// ENSure release verifier, shared by the web apps and the `ensure verify` CLI (docs: section 7, Verify).
// Runtime-neutral: the chain client, address book and gateway list are passed in. Reads only the chain
// and public IPFS gateways, never the ENSure server.
import { decodeAbiParameters, encodeFunctionData, keccak256, namehash, parseAbi, recoverTypedDataAddress, toBytes, toHex, type Address, type Hex } from "viem";
import { CID } from "multiformats/cid";
import * as rawCodec from "multiformats/codecs/raw";
import { decodeContenthash, dnsEncode, findOwner, findResolver, labelId, readContenthash, readText, sameCid } from "./ens";
import { buildManifest, hashFiles, parseManifest, type Manifest } from "./manifest";
import { CORE_FIELDS, bytesCid, jcs, typedApproval, type Envelope } from "./approval";
import { GatewayContentMismatchError, GatewayUnavailableError, cidFromPointer, createIpfsFetcher } from "./ipfs";
import { IntegrityError } from "./errors";
import { controllerV2Abi, evaluateV2, type StoredReleaseV2, type TransitionV2 } from "./controller-v2";
import { commitDigest as commitDigestOf } from "./manifest";

export type CheckState = "pass" | "fail" | "unavailable" | "info";
/**
 * MATCH: every required comparison agreed (protected projects only).
 * MISMATCH: data was readable and something differed.
 * UNAVAILABLE: evidence could not be read or does not exist. Never green.
 * UNPROTECTED: files match the published build manifest, but no owner approved them (quick names). Never green.
 */
export type VerifyStatus = "MATCH" | "MISMATCH" | "UNAVAILABLE" | "UNPROTECTED";
export type VerificationCheck = { id: string; label: string; state: CheckState; detail: string };
export type EnvironmentSummary = { name: string; cid?: string; buildRecord?: string; buildManifestCid?: string; resolver?: Address; detail: string };
export type Verification = {
  name: string;
  status: VerifyStatus;
  checks: VerificationCheck[];
  production: EnvironmentSummary;
  preview: EnvironmentSummary;
  cid?: string;
  approvalManifestCid?: string;
  buildManifestCid?: string;
  release?: string;
  commit?: string;
  approver?: Address;
  issuedAt?: string;
  transaction?: Hex;
  blockNumber?: bigint;
  gateway?: string;
  siteUrl?: string;
  approvalManifestUrl?: string;
  buildManifestUrl?: string;
  explanation?: string;
};
/** manifestDigest is keccak256 of the exact manifest bytes fetched (the value v2 approvals sign). */
export type BuildCheck = { cid: string; manifestCid: string; gateway: string; url: string; manifest: Manifest; manifestDigest: Hex; fileCount: number };

/** The address-book fields the verifier needs (deployments/sepolia.json). */
export type VerifierDeployment = {
  chainId: number;
  label: string;
  projectName: string;
  prodName: string;
  previewName: string;
  registry: string;
  prodResolver: string;
  previewResolver: string;
  ci: string;
  projectResource: string;
  prodResource: string;
  minRelease: string;
  releaseController: string | null;
  protocol: {
    rootRegistry: string;
    ethRegistry: string;
    universalHelper: string;
    verifiableFactory: string;
    registryImplementation: string;
    resolverImplementation: string;
  };
  legacyBuildManifests?: Record<string, { release: string; manifestCid: string; source: { name: string; block: number; tx: string } }>;
};

/** Minimal read surface, so any viem PublicClient (browser or Node, any viem 2.x copy) can be passed. */
export type VerifierClient = {
  readContract: (args: any) => Promise<any>;
  getChainId: () => Promise<number>;
  getBlock: (args?: any) => Promise<{ number: bigint; hash: Hex | null; timestamp: bigint }>;
};

export { IntegrityError } from "./errors";

const profile = parseAbi(["function contenthash(bytes32 node) view returns (bytes)", "function text(bytes32 node,string key) view returns (string)"]);
const helperAbi = parseAbi(["function findParentRegistry(bytes name) view returns (address)", "function findExactRegistry(bytes name) view returns (address)", "function findExactOwner(bytes name) view returns (address)"]);
const registryState = "function getState(uint256 anyId) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource) state)";
const ethRegistryAbi = parseAbi([registryState, "function getSubregistry(string label) view returns (address)"]);
const registryAbi = parseAbi([registryState, "function getResolver(string label) view returns (address)"]);
const factoryAbi = parseAbi(["function verifyContract(address proxy) view returns (address implementation)"]);
const resolverAbi = parseAbi([
  "function resolve(bytes name,bytes data) view returns (bytes)",
  "function hasRootRoles(uint256 roles,address account) view returns (bool)",
  "function hasRoles(uint256 resource,uint256 roles,address account) view returns (bool)",
]);
const ROLE_SET_TEXT = 1n << 4n;
const ROLE_SET_CONTENTHASH = 1n << 8n;
const ROLE_LINK = 1n << 28n;
const ROLE_UPGRADE = 1n << 124n;
const admin = (role: bigint) => role << 128n;
const equalAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isZeroAddress = (a?: string) => !a || /^0x0{40}$/i.test(a);
const toIso = (unixSeconds: string) => new Date(Number(unixSeconds) * 1000).toISOString();
const NO_APPROVAL_NOTE = "Files can match while nobody approved them. This checks what the name serves, not whether it is safe.";

type RegistrationState = { status: number; expiry: bigint; latestOwner: Address; tokenId: bigint; resource: bigint };

function append(checks: VerificationCheck[], id: string, label: string, state: CheckState, detail: string, onCheck?: (check: VerificationCheck) => void) {
  const check = { id, label, state, detail };
  const existing = checks.findIndex((item) => item.id === id);
  if (existing >= 0) checks[existing] = check;
  else checks.push(check);
  onCheck?.(check);
}

/** Exported for tests: parses and schema-checks a canonical v1 approval envelope. */
export function parseApproval(text: string): Envelope {
  let envelope: Envelope;
  try { envelope = JSON.parse(text) as Envelope; }
  catch { throw new IntegrityError("Approval manifest is not valid JSON"); }
  if (jcs(envelope) !== text) throw new IntegrityError("Approval manifest is not canonical JSON");
  if (!envelope || typeof envelope !== "object" || !envelope.core || typeof envelope.core !== "object") throw new IntegrityError("Approval manifest has no signed core");
  if (Object.keys(envelope.core).sort().join(",") !== [...CORE_FIELDS].sort().join(",")) throw new IntegrityError("Signed approval has an unexpected schema");
  if (envelope.core.schemaVersion !== 1 || !/^0x[0-9a-f]{64}$/i.test(envelope.core.buildHash)) throw new IntegrityError("Approval schema or signed build hash is invalid");
  if (!/^0x[0-9a-f]{130}$/i.test(envelope.signature)) throw new IntegrityError("Approval signature is malformed");
  return envelope;
}

/**
 * Exported for tests: the buildHash rule shared with tools/ensure-sepolia/scripts/verify.ts.
 * A raw single-file CID signs that file's SHA-256; a UnixFS directory CID signs its own multihash digest.
 */
export function checkSignedBuildHash(siteCid: string, buildHash: string, indexSha256: string) {
  const v1 = CID.parse(siteCid).toV1();
  if (v1.code === rawCodec.code) {
    if (indexSha256.toLowerCase() !== buildHash.slice(2).toLowerCase()) throw new IntegrityError("The signed buildHash differs from the manifest's index.html SHA-256");
    return "the file's SHA-256";
  }
  if (toHex(v1.multihash.digest).toLowerCase() !== buildHash.toLowerCase()) throw new IntegrityError("The signed buildHash differs from the directory CID's multihash digest");
  return "the directory CID's multihash digest";
}

function normalizeManifest(manifest: Manifest): Manifest {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new IntegrityError("Build manifest schema is invalid or has no files");
  if (!/^[0-9a-f]{40}$/.test(manifest.commitSha) || !manifest.siteCid) throw new IntegrityError("Build manifest is missing a valid commit or site CID");
  try {
    return buildManifest({
      repositoryId: manifest.repositoryId,
      repositoryUrl: manifest.repositoryUrl,
      commitSha: manifest.commitSha,
      workflowRunUrl: manifest.workflowRunUrl,
      siteCid: manifest.siteCid,
      buildTools: manifest.buildTools,
      files: manifest.files,
    });
  } catch (error) {
    throw new IntegrityError(error instanceof Error ? error.message : "Build manifest file list is invalid");
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index]);
    }
  }));
  return output;
}

export function createVerifier(options: { client: VerifierClient; deployment: VerifierDeployment; gateways: readonly string[] }) {
  const { client, deployment } = options;
  const { fetchIpfs, fetchIpfsMatching } = createIpfsFetcher(options.gateways);
  const read = async <T>(args: object): Promise<T> => await client.readContract(args) as T;

  const resolverForName = (name: string): Address | undefined => {
    if (name.toLowerCase() === deployment.prodName.toLowerCase()) return deployment.prodResolver as Address;
    if (name.toLowerCase() === deployment.previewName.toLowerCase()) return deployment.previewResolver as Address;
    return undefined;
  };

  async function resolveAt(name: string, resolver: Address, data: Hex, blockNumber: bigint): Promise<Hex> {
    return await read<Hex>({ address: resolver, abi: resolverAbi, functionName: "resolve", args: [dnsEncode(name), data], blockNumber });
  }
  async function readContenthashAt(name: string, resolver: Address, blockNumber: bigint): Promise<Hex> {
    const resolved = await resolveAt(name, resolver, encodeFunctionData({ abi: profile, functionName: "contenthash", args: [namehash(name)] }), blockNumber);
    return decodeAbiParameters([{ type: "bytes" }], resolved)[0];
  }
  async function readTextAt(name: string, resolver: Address, key: string, blockNumber: bigint): Promise<string> {
    const resolved = await resolveAt(name, resolver, encodeFunctionData({ abi: profile, functionName: "text", args: [namehash(name), key] }), blockNumber);
    return decodeAbiParameters([{ type: "string" }], resolved)[0];
  }

  async function checkProductionAuthority(resolver: Address, blockNumber: bigint): Promise<boolean> {
    const ci = deployment.ci as Address;
    const root = await Promise.all([ROLE_SET_CONTENTHASH, ROLE_SET_TEXT, ROLE_LINK, ROLE_UPGRADE].flatMap((role) => [
      read<boolean>({ address: resolver, abi: resolverAbi, functionName: "hasRootRoles", args: [role, ci], blockNumber }),
      read<boolean>({ address: resolver, abi: resolverAbi, functionName: "hasRootRoles", args: [admin(role), ci], blockNumber }),
    ]));
    const scoped = await Promise.all(["ensure.manifest", "ensure.release", "ensure.approval", "ensure.build"].flatMap((key) => {
      const resource = BigInt(keccak256(toBytes(key)));
      return [
        read<boolean>({ address: resolver, abi: resolverAbi, functionName: "hasRoles", args: [resource, ROLE_SET_TEXT, ci], blockNumber }),
        read<boolean>({ address: resolver, abi: resolverAbi, functionName: "hasRoles", args: [resource, admin(ROLE_SET_TEXT), ci], blockNumber }),
      ];
    }));
    return !root.some(Boolean) && !scoped.some(Boolean);
  }

  async function verifyBuildManifestFiles(siteCid: string, manifestCid: string, onProgress?: (complete: number, total: number) => void): Promise<BuildCheck> {
    const manifestResult = await fetchIpfs(manifestCid);
    let parsed: Manifest;
    try { parsed = normalizeManifest(parseManifest(manifestResult.bytes)); }
    catch (error) {
      if (error instanceof IntegrityError) throw error;
      throw new IntegrityError(error instanceof Error ? error.message : "Build manifest could not be parsed");
    }
    if (!sameCid(parsed.siteCid, siteCid)) throw new IntegrityError(`Build manifest siteCid ${parsed.siteCid} differs from the ENS contenthash ${siteCid}`);
    const paths = new Set<string>();
    for (const file of parsed.files) {
      if (paths.has(file.path)) throw new IntegrityError(`Build manifest repeats file path ${file.path}`);
      paths.add(file.path);
    }
    if (!paths.has("index.html")) throw new IntegrityError("Build manifest does not include index.html");
    let complete = 0;
    const checkedFiles = await mapLimit(parsed.files, 6, async (file) => {
      const match = await fetchIpfsMatching(siteCid, file.path, (bytes) => bytes.length === file.size && hashFiles([{ path: file.path, bytes }])[0].sha256 === file.sha256);
      complete += 1;
      onProgress?.(complete, parsed.files.length);
      return { path: file.path, gateway: match.gateway };
    });
    return { cid: siteCid, manifestCid, gateway: manifestResult.gateway, url: manifestResult.url, manifest: parsed, manifestDigest: keccak256(manifestResult.bytes), fileCount: checkedFiles.length };
  }

  /**
   * Names that are not a configured protected project (e.g. quick names written by the platform key).
   * No owner approval exists, so the best possible result is UNPROTECTED, never MATCH.
   * Throws IntegrityError / gateway errors to the caller, which map to MISMATCH / UNAVAILABLE.
   */
  async function verifyUnprotected(name: string, result: Verification, onCheck?: (check: VerificationCheck) => void): Promise<Verification> {
    const checks = result.checks;
    result.production = { name, detail: "Single name with no separate production approval" };
    result.preview = { name: "—", detail: "Unprotected names have no preview/production split" };
    const unavailable = (id: string, label: string, detail: string, explanation: string) => {
      append(checks, id, label, "unavailable", detail, onCheck);
      result.status = "UNAVAILABLE";
      result.explanation = explanation;
      return result;
    };

    const resolver = await findResolver(client, name).catch(() => undefined);
    if (isZeroAddress(resolver)) {
      return unavailable("resolver", "ENSv2 resolver", `${name} has no resolver on ENSv2 Sepolia`, `${name} does not resolve on ENSv2 Sepolia, so there is nothing to check.`);
    }
    result.production.resolver = resolver;
    const owner = await findOwner(client, name).catch(() => undefined);
    append(checks, "resolver", "ENSv2 resolver", "pass", `${name} resolves through ${resolver}${isZeroAddress(owner) ? "" : ` · owner ${owner}`}`, onCheck);
    append(checks, "approval", "Owner approval", "info", `None. ${name} is not a protected project in this configuration (only ${deployment.projectName} is), so no owner approval exists to check.`, onCheck);

    const { contenthash } = await readContenthash(client, name).catch(() => ({ contenthash: "0x" as Hex }));
    if (!contenthash || contenthash === "0x") {
      return unavailable("contenthash", "Site pointer", `${name} has no contenthash`, `${name} does not point at a website, so no files can be compared.`);
    }
    let cid: string;
    try { cid = decodeContenthash(contenthash); }
    catch {
      return unavailable("contenthash", "Site pointer", `Contenthash ${contenthash.slice(0, 18)}… is not an IPFS CID`, "The name points at content that is not on IPFS, so its files cannot be compared.");
    }
    result.cid = cid;
    result.production.cid = cid;
    append(checks, "contenthash", "Site pointer", "pass", `${name} serves IPFS CID ${cid}`, onCheck);

    const [buildRecord, manifestRecord, approvalRecord] = await Promise.all([
      readText(client, name, "ensure.build").catch(() => ""),
      readText(client, name, "ensure.manifest").catch(() => ""),
      readText(client, name, "ensure.approval").catch(() => ""),
    ]);
    if (approvalRecord) {
      // A protected name of a project this configuration doesn't cover: ensure.manifest is an approval
      // pointer there, and the approval can't be checked without that project's address book.
      return unavailable("approval", "Owner approval", `${name} publishes an owner approval, but this configuration only verifies ${deployment.projectName}`,
        `${name} looks like a protected release from another project. Its approval can't be verified here, so no result is given.`);
    }
    const manifestCid = cidFromPointer(buildRecord || manifestRecord);
    result.production.buildRecord = buildRecord || manifestRecord || undefined;
    result.production.buildManifestCid = manifestCid;
    if (!manifestCid) {
      return unavailable("manifest", "Build manifest", "No ensure.build or ensure.manifest record points at a build manifest",
        `${name} serves a site but publishes no build manifest, so its files cannot be checked. No owner approval exists either. ${NO_APPROVAL_NOTE}`);
    }
    result.buildManifestCid = manifestCid;

    const build = await verifyBuildManifestFiles(cid, manifestCid);
    result.gateway = build.gateway;
    result.buildManifestUrl = build.url;
    result.siteUrl = `${build.gateway}/ipfs/${encodeURIComponent(cid)}/`;
    result.commit = build.manifest.commitSha;
    append(checks, "manifest", "Build manifest", "pass", `Manifest ${manifestCid} names site CID ${cid} and commit ${build.manifest.commitSha.slice(0, 12)}`, onCheck);
    append(checks, "files", "Build files match manifest", "pass", `${build.fileCount} files fetched from the IPFS CID; every size and SHA-256 matches.`, onCheck);

    result.status = "UNPROTECTED";
    result.explanation = `${name} serves exactly the files in its build manifest, but nobody approved this release: it can change whenever its publisher writes a new one. ${NO_APPROVAL_NOTE}`;
    return result;
  }

  async function verifyProject(nameInput: string, onCheck?: (check: VerificationCheck) => void): Promise<Verification> {
    const input = nameInput.trim().toLowerCase().replace(/\.$/, "");
    const projectName = input === deployment.prodName.toLowerCase() || input === deployment.previewName.toLowerCase()
      ? deployment.projectName.toLowerCase()
      : input;
    const prodName = `prod.${projectName}`;
    const previewName = `preview.${projectName}`;
    const checks: VerificationCheck[] = [];
    const result: Verification = {
      name: projectName,
      status: "UNAVAILABLE",
      checks,
      production: { name: prodName, detail: "Not checked" },
      preview: { name: previewName, detail: "Not checked" },
    };
    let currentStep = "Sepolia RPC";
    try {
      const chainId = await client.getChainId();
      if (chainId !== deployment.chainId) throw new Error(`Configured read client is on chain ${chainId}; expected Sepolia ${deployment.chainId}`);
      const block = await client.getBlock();
      result.blockNumber = block.number;
      append(checks, "network", "Sepolia snapshot", "pass", `Chain ${chainId} · block ${block.number}`, onCheck);

      if (projectName !== deployment.projectName.toLowerCase()) {
        currentStep = "Unprotected name lookup";
        return await verifyUnprotected(projectName, result, onCheck);
      }

      currentStep = "ENSv2 name ownership and resolver routing";
      const [ethForward, rootEthState, projectState, parentRegistry, exactRegistry] = await Promise.all([
        read<Address>({ address: deployment.protocol.rootRegistry, abi: ethRegistryAbi, functionName: "getSubregistry", args: ["eth"], blockNumber: block.number }),
        read<RegistrationState>({ address: deployment.protocol.rootRegistry, abi: ethRegistryAbi, functionName: "getState", args: [labelId("eth")], blockNumber: block.number }),
        read<RegistrationState>({ address: deployment.protocol.ethRegistry, abi: ethRegistryAbi, functionName: "getState", args: [labelId(deployment.label)], blockNumber: block.number }),
        read<Address>({ address: deployment.protocol.universalHelper, abi: helperAbi, functionName: "findParentRegistry", args: [dnsEncode(prodName)], blockNumber: block.number }),
        read<Address>({ address: deployment.protocol.universalHelper, abi: helperAbi, functionName: "findExactRegistry", args: [dnsEncode(projectName)], blockNumber: block.number }),
      ]);
      const hierarchyOk = equalAddress(ethForward, deployment.protocol.ethRegistry) && Number(rootEthState.status) === 2 && rootEthState.expiry > block.timestamp &&
        Number(projectState.status) === 2 && projectState.expiry > block.timestamp && projectState.resource.toString() === deployment.projectResource &&
        equalAddress(parentRegistry, deployment.registry) &&
        // findExactRegistry(name) returns the name's OWN child registry (the project registry), not its parent's.
        equalAddress(exactRegistry, deployment.registry);
      append(checks, "owner", "ENSv2 parent and current owner", hierarchyOk ? "pass" : "fail", hierarchyOk ? `Current parent-name owner: ${projectState.latestOwner}` : "The .eth parent, project registration, resource or parent registry does not match the configured ENSv2 hierarchy", onCheck);
      if (!hierarchyOk) throw new IntegrityError("ENSv2 project registration or ownership context does not match the configured hierarchy");
      const currentOwner = projectState.latestOwner;

      const envs = await Promise.all([prodName, previewName].map(async (name) => {
        const resolver = resolverForName(name);
        if (!resolver) throw new IntegrityError(`No resolver configured for ${name}`);
        const envLabel = name.split(".")[0];
        const [forwardResolver, state, exactOwner, contenthash, buildRecord, manifestRecord, releaseRecord, approvalText, controllerRecord] = await Promise.all([
          read<Address>({ address: deployment.registry, abi: registryAbi, functionName: "getResolver", args: [envLabel], blockNumber: block.number }),
          read<RegistrationState>({ address: deployment.registry, abi: registryAbi, functionName: "getState", args: [labelId(envLabel)], blockNumber: block.number }),
          read<Address>({ address: deployment.protocol.universalHelper, abi: helperAbi, functionName: "findExactOwner", args: [dnsEncode(name)], blockNumber: block.number }),
          readContenthashAt(name, resolver, block.number),
          readTextAt(name, resolver, "ensure.build", block.number),
          readTextAt(name, resolver, "ensure.manifest", block.number),
          readTextAt(name, resolver, "ensure.release", block.number),
          readTextAt(name, resolver, "ensure.approval", block.number),
          readTextAt(name, resolver, "ensure.controller", block.number),
        ]);
        const expectedResource = envLabel === "prod" ? BigInt(deployment.prodResource) : undefined;
        const active = Number(state.status) === 2 && state.expiry > block.timestamp && (!expectedResource || state.resource === expectedResource);
        if (!equalAddress(forwardResolver, resolver) || !active) throw new IntegrityError(`${name} is inactive or its registered resolver/resource differs from deployments/sepolia.json`);
        const summary: EnvironmentSummary = {
          name,
          resolver,
          buildRecord: buildRecord || manifestRecord || undefined,
          buildManifestCid: cidFromPointer(buildRecord || manifestRecord),
          detail: "Live ENSv2 records read at the verification block",
        };
        let cid: string | undefined;
        if (contenthash && contenthash !== "0x") {
          try { cid = decodeContenthash(contenthash); }
          catch (error) { throw new IntegrityError(`${name} contenthash is not a valid IPFS contenthash: ${error instanceof Error ? error.message : String(error)}`); }
        }
        summary.cid = cid;
        return { name, resolver, state, exactOwner, contenthash, cid, buildRecord, manifestRecord, releaseRecord, approvalText, controllerRecord, summary };
      }));
      const [prod, preview] = envs;
      result.production = prod.summary;
      result.preview = preview.summary;
      append(checks, "resolver", "Production and preview resolvers", "pass", `${prodName} → ${prod.resolver} · ${previewName} → ${preview.resolver}`, onCheck);
      append(checks, "env-records", "Live production and preview records", prod.cid ? "pass" : "fail", `Production CID ${prod.cid ?? "missing"}; build record ${prod.buildRecord || "missing"}. Preview CID ${preview.cid ?? "missing"}; build record ${preview.buildRecord || "missing"}.`, onCheck);
      if (!prod.cid) throw new IntegrityError("Production ENS contenthash is empty");
      result.cid = prod.cid;

      currentStep = "ENSv2 implementation and resolver isolation";
      const [registryImpl, prodImpl, previewImpl] = await Promise.all([
        read<Address>({ address: deployment.protocol.verifiableFactory, abi: factoryAbi, functionName: "verifyContract", args: [deployment.registry], blockNumber: block.number }),
        read<Address>({ address: deployment.protocol.verifiableFactory, abi: factoryAbi, functionName: "verifyContract", args: [prod.resolver], blockNumber: block.number }),
        read<Address>({ address: deployment.protocol.verifiableFactory, abi: factoryAbi, functionName: "verifyContract", args: [preview.resolver], blockNumber: block.number }),
      ]);
      const implementationOk = equalAddress(registryImpl, deployment.protocol.registryImplementation) && equalAddress(prodImpl, deployment.protocol.resolverImplementation) && equalAddress(previewImpl, deployment.protocol.resolverImplementation) && !equalAddress(prod.resolver, preview.resolver);
      append(checks, "implementation", "Resolver implementation and separation", implementationOk ? "pass" : "fail", implementationOk ? "Both names use the configured PermissionedResolver implementation and separate resolver instances" : "Resolver implementation provenance or production/preview isolation differs from configuration", onCheck);
      if (!implementationOk) throw new IntegrityError("ENSv2 resolver implementation or separation check failed");

      currentStep = "Production writer permissions";
      const ciBlocked = await checkProductionAuthority(prod.resolver, block.number);
      append(checks, "authority", "CI cannot write production", ciBlocked ? "pass" : "fail", ciBlocked ? `CI ${deployment.ci} has no production record-writing or role-admin permissions` : `CI ${deployment.ci} has production writer or role-admin permission`, onCheck);
      if (!ciBlocked) throw new IntegrityError("CI has a production resolver write permission");

      // The approval schema comes from the address book, never from the records: null = v1, an address = v2 only.
      let build: BuildCheck;
      const verifyFiles = async (manifestCid: string) => {
        currentStep = "Production build manifest and site files";
        try {
          return await verifyBuildManifestFiles(prod.cid!, manifestCid, (complete, total) => {
            if (complete === total || complete === 1) append(checks, "files", "Build file SHA-256 checks", "info", `Verified ${complete} of ${total} files against the build manifest`, onCheck);
          });
        } catch (error) {
          const mismatch = error instanceof IntegrityError || error instanceof GatewayContentMismatchError;
          append(checks, "files", "Build files match manifest", mismatch ? "fail" : "unavailable", error instanceof Error ? error.message : String(error), onCheck);
          throw error;
        }
      };

      if (deployment.releaseController) {
        const controller = deployment.releaseController as Address;
        currentStep = "Release controller v2 state";
        const c = (functionName: string, args: unknown[] = []) => read<any>({ address: controller, abi: controllerV2Abi, functionName, args, blockNumber: block.number });
        const [stateProjectNode, productionResolver, previewResolver, domainSeparator, currentReleaseId, lastSequence, paused, transitionCount] = await Promise.all([
          c("projectNode"), c("productionResolver"), c("previewResolver"), c("domainSeparator"), c("currentReleaseId"), c("lastSequence"), c("paused"), c("transitionCount"),
        ]) as [Hex, Address, Address, Hex, Hex, bigint, boolean, bigint];
        const [currentRelease, latestTransition] = await Promise.all([
          c("getRelease", [currentReleaseId]) as Promise<StoredReleaseV2>,
          transitionCount > 0n ? c("getTransition", [transitionCount - 1n]) as Promise<TransitionV2> : Promise.resolve(undefined),
        ]);
        currentStep = "Release controller v2 approval";
        const v2 = await evaluateV2({
          chainId: deployment.chainId,
          controller,
          projectNode: namehash(projectName),
          expectedProdResolver: prod.resolver,
          expectedPreviewResolver: preview.resolver,
          currentOwner,
          prodContenthash: prod.contenthash,
          records: { release: prod.releaseRecord, manifest: prod.manifestRecord, build: prod.buildRecord, approval: prod.approvalText, controllerPointer: prod.controllerRecord },
          state: { projectNode: stateProjectNode, productionResolver, previewResolver, domainSeparator, currentReleaseId, lastSequence, paused },
          currentRelease,
          latestTransition,
        });
        result.release = v2.sequence.toString();
        result.approver = v2.approver;
        result.issuedAt = new Date(Number(v2.actionTimestamp) * 1000).toISOString();
        result.buildManifestCid = v2.manifestCid;
        append(checks, "controller", "Release controller v2", "pass", `prod ensure.controller → ${controller}; current release ${currentReleaseId.slice(0, 18)}… at sequence ${v2.sequence}${v2.paused ? " (promotions paused)" : ""}`, onCheck);
        append(checks, "approval", "Current owner v2 signature", "pass", `${v2.action === "promote" ? "Promotion" : "Rollback"} #${v2.sequence} signed by current owner ${v2.approver}; matches the controller's latest transition, deadline met at execution`, onCheck);
        append(checks, "cid", "ENS records match the controller release", "pass", `contenthash, ensure.build, ensure.manifest and ensure.release agree with release ${currentReleaseId.slice(0, 18)}…`, onCheck);

        build = await verifyFiles(v2.manifestCid);
        if (!equalAddress(build.manifestDigest, v2.manifestDigest)) throw new IntegrityError("Build manifest bytes do not hash to the signed manifestDigest");
        if (!equalAddress(commitDigestOf(build.manifest.commitSha), v2.commitDigest)) throw new IntegrityError("Build manifest commit does not match the signed commitDigest");
        result.commit = build.manifest.commitSha;
        append(checks, "files", "Build files match manifest", "pass", `${build.fileCount} files fetched from the IPFS CID; every size and SHA-256 matches. Manifest bytes hash to the signed manifestDigest; commit ${build.manifest.commitSha.slice(0, 12)} matches the signed commitDigest.`, onCheck);
      } else {
        result.buildManifestCid = cidFromPointer(prod.buildRecord);
        result.approvalManifestCid = cidFromPointer(prod.manifestRecord);
        if (!result.approvalManifestCid || !prod.approvalText) throw new IntegrityError("Production signed approval pointer or inline approval text record is missing");
        const legacy = !result.buildManifestCid ? deployment.legacyBuildManifests?.[prod.cid] : undefined;
        if (!result.buildManifestCid && legacy) {
          // Releases that predate ensure.build on prod: the pinned manifest is still bound below to the signed CID, commit and buildHash.
          result.buildManifestCid = legacy.manifestCid;
          append(checks, "build-record", "Production build manifest pointer", "info", `Release ${legacy.release} predates ensure.build on prod. Using the manifest CI published for this exact CID (${legacy.source.name} ensure.build, block ${legacy.source.block}, tx ${legacy.source.tx.slice(0, 12)}…); it must still match the signed CID, commit and buildHash.`, onCheck);
        } else if (!result.buildManifestCid) {
          append(checks, "build-record", "Production build manifest pointer", "unavailable", "The live ensure.build text record is empty, so full directory verification cannot run yet.", onCheck);
          throw new GatewayUnavailableError("Production ensure.build has no build manifest CID; full directory verification cannot run yet");
        } else {
          append(checks, "build-record", "Production build manifest pointer", "pass", `ensure.build → ${result.buildManifestCid}`, onCheck);
        }
        const buildManifestCid = result.buildManifestCid;

        currentStep = "Owner approval bytes";
        const approvalPointer = `ipfs://${result.approvalManifestCid}`;
        if (prod.releaseRecord !== approvalPointer && prod.releaseRecord !== prod.manifestRecord) throw new IntegrityError("ensure.release does not match the signed approval manifest pointer");
        // The signed envelope lives inline in ensure.approval; ensure.manifest/ensure.release commit to its raw
        // SHA-256 CID. The inline bytes are not promised to be pinned (docs/OWNER_PROMOTE.md), so hash them
        // directly, as the CLI verifier does. Only an empty inline record falls back to fetching from IPFS.
        let approvalText: string;
        let approvalSource: { gateway: string; url: string } | undefined;
        if (prod.approvalText) {
          const inlineBytes = new TextEncoder().encode(prod.approvalText);
          if (inlineBytes.length > 8192) throw new IntegrityError("Inline approval exceeds the 8 KB limit");
          if (!sameCid(await bytesCid(inlineBytes), result.approvalManifestCid)) throw new IntegrityError("Inline approval bytes do not hash to the ENS approval-manifest CID");
          approvalText = prod.approvalText;
          append(checks, "approval-cid", "Approval bytes match the ENS commitment", "pass", `Inline ensure.approval hashes to raw CID ${result.approvalManifestCid}, the value in ensure.manifest`, onCheck);
        } else {
          const approvalResponse = await fetchIpfs(result.approvalManifestCid);
          if (!sameCid(await bytesCid(approvalResponse.bytes), result.approvalManifestCid)) throw new IntegrityError("Fetched approval bytes do not match the ENS approval-manifest CID");
          approvalText = new TextDecoder("utf-8", { fatal: true }).decode(approvalResponse.bytes);
          approvalSource = { gateway: approvalResponse.gateway, url: approvalResponse.url };
          append(checks, "approval-cid", "Approval manifest fetched from IPFS", "pass", `Fetched via ${new URL(approvalResponse.gateway).host}; raw bytes match ${result.approvalManifestCid}`, onCheck);
        }
        const envelope = parseApproval(approvalText);

        currentStep = "Owner EIP-712 approval";
        const core = envelope.core;
        const contextOk = core.chainId === String(deployment.chainId) && core.name === prodName && core.projectName === projectName &&
          equalAddress(core.parentRegistry, deployment.protocol.ethRegistry) && equalAddress(core.registry, deployment.registry) &&
          core.parentResource === projectState.resource.toString() && core.resource === prod.state.resource.toString() &&
          equalAddress(core.resolver, prod.resolver) && equalAddress(core.approver, currentOwner) && BigInt(core.release) >= BigInt(deployment.minRelease);
        if (!contextOk) throw new IntegrityError("Signed approval name, resolver, resource, chain, current owner or release checkpoint does not match live ENSv2 state");
        const recovered = await recoverTypedDataAddress({ ...typedApproval(core), signature: envelope.signature });
        if (!equalAddress(recovered, currentOwner)) throw new IntegrityError(`EIP-712 signer ${recovered} is not the current ENS parent-name owner ${currentOwner}`);
        if (BigInt(core.issuedAt) > block.timestamp || BigInt(core.validUntil) <= block.timestamp || BigInt(core.validUntil) <= BigInt(core.issuedAt)) throw new IntegrityError("Owner approval has expired or is not yet valid at the Sepolia snapshot");
        if (!sameCid(core.cid, prod.cid)) throw new IntegrityError("Production ENS contenthash CID differs from the signed release CID");
        result.release = core.release;
        result.commit = core.commit;
        result.approver = recovered;
        result.issuedAt = toIso(core.issuedAt);
        if (approvalSource) {
          result.gateway = approvalSource.gateway;
          result.approvalManifestUrl = approvalSource.url;
        }
        append(checks, "approval", "Current owner EIP-712 signature", "pass", `Release ${core.release} signed by current owner ${recovered}; valid until ${toIso(core.validUntil)}`, onCheck);
        append(checks, "cid", "ENS contenthash matches signed CID", "pass", `Both point to ${prod.cid}`, onCheck);
        append(checks, "controller", "Release controller", "info", "No release controller is configured (releaseController is null): v1 direct owner approval is checked", onCheck);

        build = await verifyFiles(buildManifestCid);
        const index = build.manifest.files.find((file) => file.path === "index.html");
        if (!index) throw new IntegrityError("Build manifest has no index.html file");
        const buildHashBinding = checkSignedBuildHash(prod.cid, core.buildHash, index.sha256);
        if (build.manifest.commitSha !== core.commit) throw new IntegrityError("The build manifest commit differs from the owner-signed commit");
        append(checks, "files", "Build files match manifest", "pass", `${build.fileCount} files fetched from the IPFS CID; every size and SHA-256 matches. The signed buildHash matches ${buildHashBinding}.`, onCheck);
      }
      result.buildManifestCid = build.manifestCid;
      result.gateway = build.gateway;
      result.buildManifestUrl = build.url;
      result.siteUrl = `${build.gateway}/ipfs/${encodeURIComponent(prod.cid)}/`;
      append(checks, "preview", "Preview remains separately addressable", "info", preview.cid ? `${preview.name} has its own CID ${preview.cid} and build pointer ${preview.buildRecord || "not set"}` : `${preview.name} is not currently published; production verification is independent`, onCheck);

      const snapshotHash = block.hash;
      if (snapshotHash && (await client.getBlock({ blockNumber: block.number })).hash !== snapshotHash) throw new IntegrityError("Sepolia block changed during verification; retry against a stable snapshot");
      append(checks, "snapshot", "Sepolia snapshot remained stable", "pass", `Verification reads correspond to block ${block.number}`, onCheck);
      result.status = "MATCH";
      result.explanation = "The live production name, current owner signature, build manifest and fetched file hashes agree. This checks release integrity; it does not audit the site's code for vulnerabilities.";
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const isMismatch = error instanceof IntegrityError || error instanceof GatewayContentMismatchError;
      const state: CheckState = isMismatch ? "fail" : "unavailable";
      if (!checks.some((item) => item.state === "fail" || item.id === "verification-error")) append(checks, "verification-error", currentStep, state, detail, onCheck);
      else if (error instanceof GatewayUnavailableError && !checks.some((item) => item.id === "verification-error")) append(checks, "verification-error", currentStep, "unavailable", detail, onCheck);
      result.status = isMismatch ? "MISMATCH" : "UNAVAILABLE";
      result.explanation = detail;
      return result;
    }
  }

  /** Verify any name as an unprotected (quick) name. */
  async function verifyUnprotectedName(name: string, onCheck?: (check: VerificationCheck) => void): Promise<Verification> {
    const normalized = name.trim().toLowerCase().replace(/\.$/, "");
    const result: Verification = { name: normalized, status: "UNAVAILABLE", checks: [], production: { name: normalized, detail: "Not checked" }, preview: { name: "—", detail: "Not checked" } };
    try {
      return await verifyUnprotected(normalized, result, onCheck);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const isMismatch = error instanceof IntegrityError || error instanceof GatewayContentMismatchError;
      append(result.checks, "verification-error", "Unprotected name check", isMismatch ? "fail" : "unavailable", detail, onCheck);
      result.status = isMismatch ? "MISMATCH" : "UNAVAILABLE";
      result.explanation = detail;
      return result;
    }
  }

  async function readCurrentProjectOwner(blockNumber?: bigint): Promise<Address> {
    const state = await read<RegistrationState>({
      address: deployment.protocol.ethRegistry,
      abi: ethRegistryAbi,
      functionName: "getState",
      args: [labelId(deployment.label)],
      ...(blockNumber ? { blockNumber } : {}),
    });
    if (Number(state.status) !== 2 || state.expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Error(`${deployment.projectName} is inactive or expired`);
    if (state.resource.toString() !== deployment.projectResource) throw new Error(`${deployment.projectName} has a different registry resource than configured`);
    return state.latestOwner;
  }

  return { verifyProject, verifyUnprotectedName, verifyBuildManifestFiles, readCurrentProjectOwner };
}

/** CLI status words (docs section 7): GREEN = MATCH, RED = MISMATCH, AMBER = UNAVAILABLE. UNPROTECTED is never green. */
export const statusWord = (status: VerifyStatus) => status === "MATCH" ? "GREEN" : status === "MISMATCH" ? "RED" : "AMBER";
