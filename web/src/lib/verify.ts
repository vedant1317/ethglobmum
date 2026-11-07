import { decodeAbiParameters, encodeFunctionData, keccak256, namehash, parseAbi, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";
import { decodeContenthash, dnsEncode, labelId, sameCid } from "@ensure/core/ens";
import { buildManifest, hashFiles, parseManifest, type Manifest } from "@ensure/core/manifest";
import { B } from "../../../tools/ensure-sepolia/scripts/protocol-abi";
import { jcs, typedApproval, type Envelope } from "../../../tools/ensure-sepolia/scripts/release-approval";
import { bytesCid, resolverAbi as ownerResolverAbi } from "../../../tools/ensure-sepolia/scripts/owner-promote-shared";
import { deployment, publicClient, resolverForName } from "./config";
import { GatewayContentMismatchError, GatewayUnavailableError, cidFromPointer, fetchIpfs, fetchIpfsMatching } from "./ipfs";

export type CheckState = "pass" | "fail" | "unavailable" | "info";
export type VerifyStatus = "MATCH" | "MISMATCH" | "UNAVAILABLE";
export type VerificationCheck = { id: string; label: string; state: CheckState; detail: string };
export type EnvironmentSummary = {
  name: string;
  cid?: string;
  buildRecord?: string;
  buildManifestCid?: string;
  resolver?: Address;
  detail: string;
};
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

const profile = parseAbi([
  "function contenthash(bytes32 node) view returns (bytes)",
  "function text(bytes32 node,string key) view returns (string)",
]);
const helper = parseAbi([
  "function findParentRegistry(bytes name) view returns (address)",
  "function findExactRegistry(bytes name) view returns (address)",
]);
const findOwnerAbi = parseAbi(["function findExactOwner(bytes name) view returns (address)"]);
const rootRegistry = parseAbi(["function getSubregistry(string label) view returns (address)"]);
const controllerAbi = parseAbi([
  "function currentReleaseId() view returns (bytes32)",
  "function getRelease(bytes32) view returns ((bytes contenthash,string manifestCid,bytes32 manifestDigest,bytes32 commitDigest,bytes32 previousReleaseId,address approver,uint64 approvedAt))",
]);
const ROLE_SET_TEXT = 1n << 4n;
const ROLE_SET_CONTENTHASH = 1n << 8n;
const ROLE_LINK = 1n << 28n;
const ROLE_UPGRADE = 1n << 124n;
const admin = (role: bigint) => role << 128n;
const equalAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const toIso = (unixSeconds: string) => new Date(Number(unixSeconds) * 1000).toISOString();

type RegistrationState = { status: number; expiry: bigint; latestOwner: Address; tokenId: bigint; resource: bigint };
export type BuildCheck = { cid: string; manifestCid: string; gateway: string; url: string; manifest: Manifest; fileCount: number };

class IntegrityError extends Error {}

function append(checks: VerificationCheck[], id: string, label: string, state: CheckState, detail: string, onCheck?: (check: VerificationCheck) => void) {
  const check = { id, label, state, detail };
  const existing = checks.findIndex((item) => item.id === id);
  if (existing >= 0) checks[existing] = check;
  else checks.push(check);
  onCheck?.(check);
}

async function read<T>(args: object): Promise<T> {
  return await publicClient.readContract(args as never) as T;
}

async function resolveAt(name: string, resolver: Address, data: Hex, blockNumber: bigint): Promise<Hex> {
  return await read<Hex>({ address: resolver, abi: ownerResolverAbi, functionName: "resolve", args: [dnsEncode(name), data], blockNumber });
}

async function readContenthashAt(name: string, resolver: Address, blockNumber: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: profile, functionName: "contenthash", args: [namehash(name)] });
  const resolved = await resolveAt(name, resolver, data, blockNumber);
  return decodeAbiParameters([{ type: "bytes" }], resolved)[0];
}

async function readTextAt(name: string, resolver: Address, key: string, blockNumber: bigint): Promise<string> {
  const data = encodeFunctionData({ abi: profile, functionName: "text", args: [namehash(name), key] });
  const resolved = await resolveAt(name, resolver, data, blockNumber);
  return decodeAbiParameters([{ type: "string" }], resolved)[0];
}

async function checkProductionAuthority(resolver: Address, blockNumber: bigint): Promise<boolean> {
  const ci = deployment.ci as Address;
  const rootRoles = [ROLE_SET_CONTENTHASH, ROLE_SET_TEXT, ROLE_LINK, ROLE_UPGRADE];
  const root = await Promise.all(rootRoles.flatMap((role) => [
    read<boolean>({ address: resolver, abi: ownerResolverAbi, functionName: "hasRootRoles", args: [role, ci], blockNumber }),
    read<boolean>({ address: resolver, abi: ownerResolverAbi, functionName: "hasRootRoles", args: [admin(role), ci], blockNumber }),
  ]));
  const scoped = await Promise.all(["ensure.manifest", "ensure.release", "ensure.approval", "ensure.build"].flatMap((key) => {
    const resource = BigInt(keccak256(toBytes(key)));
    return [
      read<boolean>({ address: resolver, abi: ownerResolverAbi, functionName: "hasRoles", args: [resource, ROLE_SET_TEXT, ci], blockNumber }),
      read<boolean>({ address: resolver, abi: ownerResolverAbi, functionName: "hasRoles", args: [resource, admin(ROLE_SET_TEXT), ci], blockNumber }),
    ];
  }));
  return !root.some(Boolean) && !scoped.some(Boolean);
}

function parseApproval(text: string): Envelope {
  let envelope: Envelope;
  try { envelope = JSON.parse(text) as Envelope; }
  catch { throw new IntegrityError("Approval manifest is not valid JSON"); }
  if (jcs(envelope) !== text) throw new IntegrityError("Approval manifest is not canonical JSON");
  if (!envelope || typeof envelope !== "object" || !envelope.core || typeof envelope.core !== "object") throw new IntegrityError("Approval manifest has no signed core");
  const expectedFields = ["approver", "buildHash", "chainId", "cid", "commit", "issuedAt", "name", "parentRegistry", "parentResource", "previousManifest", "projectName", "release", "resolver", "resource", "schemaVersion", "validUntil"].sort().join(",");
  if (Object.keys(envelope.core).sort().join(",") !== expectedFields) throw new IntegrityError("Signed approval has an unexpected schema");
  if (envelope.core.schemaVersion !== 1 || !/^0x[0-9a-f]{64}$/i.test(envelope.core.buildHash)) throw new IntegrityError("Approval schema or signed build hash is invalid");
  if (!/^0x[0-9a-f]{130}$/i.test(envelope.signature)) throw new IntegrityError("Approval signature is malformed");
  return envelope;
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

export async function verifyBuildManifestFiles(siteCid: string, manifestCid: string, onProgress?: (complete: number, total: number) => void): Promise<BuildCheck> {
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
    const match = await fetchIpfsMatching(siteCid, file.path, (bytes) => {
      if (bytes.length !== file.size) return false;
      return hashFiles([{ path: file.path, bytes }])[0].sha256 === file.sha256;
    });
    complete += 1;
    onProgress?.(complete, parsed.files.length);
    return { path: file.path, gateway: match.gateway };
  });
  return { cid: siteCid, manifestCid, gateway: manifestResult.gateway, url: manifestResult.url, manifest: parsed, fileCount: checkedFiles.length };
}

function pointerOrCid(value: string | undefined): string | undefined {
  return cidFromPointer(value);
}

export async function verifyProject(nameInput: string, onCheck?: (check: VerificationCheck) => void): Promise<Verification> {
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
    const chainId = await publicClient.getChainId();
    if (chainId !== deployment.chainId) throw new Error(`Configured read client is on chain ${chainId}; expected Sepolia ${deployment.chainId}`);
    const block = await publicClient.getBlock();
    result.blockNumber = block.number;
    append(checks, "network", "Sepolia snapshot", "pass", `Chain ${chainId} · block ${block.number}`, onCheck);

    if (projectName !== deployment.projectName.toLowerCase()) {
      append(checks, "scope", "Configured ENS project", "fail", `This app is configured for ${deployment.projectName}; ${projectName} is not in deployments/sepolia.json`, onCheck);
      result.status = "MISMATCH";
      result.explanation = "The entered ENS parent name does not match this deployment configuration.";
      return result;
    }

    currentStep = "ENSv2 name ownership and resolver routing";
    const [ethForward, rootEthState, projectState, parentRegistry, exactRegistry] = await Promise.all([
      read<Address>({ address: deployment.protocol.rootRegistry, abi: rootRegistry, functionName: "getSubregistry", args: ["eth"], blockNumber: block.number }),
      read<RegistrationState>({ address: deployment.protocol.rootRegistry, abi: B.eth, functionName: "getState", args: [labelId("eth")], blockNumber: block.number }),
      read<RegistrationState>({ address: deployment.protocol.ethRegistry, abi: B.eth, functionName: "getState", args: [labelId(deployment.label)], blockNumber: block.number }),
      read<Address>({ address: deployment.protocol.universalHelper, abi: helper, functionName: "findParentRegistry", args: [dnsEncode(prodName)], blockNumber: block.number }),
      read<Address>({ address: deployment.protocol.universalHelper, abi: helper, functionName: "findExactRegistry", args: [dnsEncode(projectName)], blockNumber: block.number }),
    ]);
    const hierarchyOk = equalAddress(ethForward, deployment.protocol.ethRegistry) && Number(rootEthState.status) === 2 && rootEthState.expiry > block.timestamp &&
      Number(projectState.status) === 2 && projectState.expiry > block.timestamp && projectState.resource.toString() === deployment.projectResource &&
      equalAddress(parentRegistry, deployment.registry) && equalAddress(exactRegistry, deployment.protocol.ethRegistry);
    append(checks, "owner", "ENSv2 parent and current owner", hierarchyOk ? "pass" : "fail", hierarchyOk ? `Current parent-name owner: ${projectState.latestOwner}` : "The .eth parent, project registration, resource or parent registry does not match the configured ENSv2 hierarchy", onCheck);
    if (!hierarchyOk) throw new IntegrityError("ENSv2 project registration or ownership context does not match the configured hierarchy");
    const currentOwner = projectState.latestOwner;

    const envs = await Promise.all([prodName, previewName].map(async (name) => {
      const resolver = resolverForName(name);
      if (!resolver) throw new IntegrityError(`No resolver configured for ${name}`);
      const envLabel = name.split(".")[0];
      const [forwardResolver, state, exactOwner, contenthash, buildRecord, manifestRecord, releaseRecord, approvalText] = await Promise.all([
        read<Address>({ address: deployment.registry, abi: B.registry, functionName: "getResolver", args: [envLabel], blockNumber: block.number }),
        read<RegistrationState>({ address: deployment.registry, abi: B.registry, functionName: "getState", args: [labelId(envLabel)], blockNumber: block.number }),
        read<Address>({ address: deployment.protocol.universalHelper, abi: findOwnerAbi, functionName: "findExactOwner", args: [dnsEncode(name)], blockNumber: block.number }),
        readContenthashAt(name, resolver, block.number),
        readTextAt(name, resolver, "ensure.build", block.number),
        readTextAt(name, resolver, "ensure.manifest", block.number),
        readTextAt(name, resolver, "ensure.release", block.number),
        readTextAt(name, resolver, "ensure.approval", block.number),
      ]);
      const expectedResource = envLabel === "prod" ? BigInt(deployment.prodResource) : undefined;
      const active = Number(state.status) === 2 && state.expiry > block.timestamp && (!expectedResource || state.resource === expectedResource);
      if (!equalAddress(forwardResolver, resolver) || !active) throw new IntegrityError(`${name} is inactive or its registered resolver/resource differs from deployments/sepolia.json`);
      const summary: EnvironmentSummary = {
        name,
        resolver,
        buildRecord: buildRecord || manifestRecord || undefined,
        buildManifestCid: pointerOrCid(buildRecord || manifestRecord),
        detail: "Live ENSv2 records read at the verification block",
      };
      let cid: string | undefined;
      if (contenthash && contenthash !== "0x") {
        try { cid = decodeContenthash(contenthash); }
        catch (error) { throw new IntegrityError(`${name} contenthash is not a valid IPFS contenthash: ${error instanceof Error ? error.message : String(error)}`); }
      }
      summary.cid = cid;
      return { name, resolver, state, exactOwner, contenthash, cid, buildRecord, manifestRecord, releaseRecord, approvalText, summary };
    }));
    const [prod, preview] = envs;
    result.production = prod.summary;
    result.preview = preview.summary;
    append(checks, "resolver", "Production and preview resolvers", "pass", `${prodName} → ${prod.resolver} · ${previewName} → ${preview.resolver}`, onCheck);
    append(checks, "env-records", "Live production and preview records", prod.cid ? "pass" : "fail", `Production CID ${prod.cid ?? "missing"}; build record ${prod.buildRecord || "missing"}. Preview CID ${preview.cid ?? "missing"}; build record ${preview.buildRecord || "missing"}.`, onCheck);
    if (!prod.cid) throw new IntegrityError("Production ENS contenthash is empty");
    result.cid = prod.cid;
    result.buildManifestCid = pointerOrCid(prod.buildRecord);
    result.approvalManifestCid = pointerOrCid(prod.manifestRecord);
    if (!result.approvalManifestCid || !prod.approvalText) throw new IntegrityError("Production signed approval pointer or inline approval text record is missing");
    if (!result.buildManifestCid) {
      append(checks, "build-record", "Production build manifest pointer", "unavailable", "The live ensure.build text record is empty, so full directory verification cannot run yet.", onCheck);
      throw new GatewayUnavailableError("Production ensure.build has no build manifest CID; full directory verification cannot run yet");
    }
    append(checks, "build-record", "Production build manifest pointer", "pass", `ensure.build → ${result.buildManifestCid}`, onCheck);

    currentStep = "ENSv2 implementation and resolver isolation";
    const [registryImpl, prodImpl, previewImpl] = await Promise.all([
      read<Address>({ address: deployment.protocol.verifiableFactory, abi: B.factory, functionName: "verifyContract", args: [deployment.registry], blockNumber: block.number }),
      read<Address>({ address: deployment.protocol.verifiableFactory, abi: B.factory, functionName: "verifyContract", args: [prod.resolver], blockNumber: block.number }),
      read<Address>({ address: deployment.protocol.verifiableFactory, abi: B.factory, functionName: "verifyContract", args: [preview.resolver], blockNumber: block.number }),
    ]);
    const implementationOk = equalAddress(registryImpl, deployment.protocol.registryImplementation) && equalAddress(prodImpl, deployment.protocol.resolverImplementation) && equalAddress(previewImpl, deployment.protocol.resolverImplementation) && !equalAddress(prod.resolver, preview.resolver);
    append(checks, "implementation", "Resolver implementation and separation", implementationOk ? "pass" : "fail", implementationOk ? "Both names use the configured PermissionedResolver implementation and separate resolver instances" : "Resolver implementation provenance or production/preview isolation differs from configuration", onCheck);
    if (!implementationOk) throw new IntegrityError("ENSv2 resolver implementation or separation check failed");

    currentStep = "Production writer permissions";
    const ciBlocked = await checkProductionAuthority(prod.resolver, block.number);
    append(checks, "authority", "CI cannot write production", ciBlocked ? "pass" : "fail", ciBlocked ? `CI ${deployment.ci} has no production record-writing or role-admin permissions` : `CI ${deployment.ci} has production writer or role-admin permission`, onCheck);
    if (!ciBlocked) throw new IntegrityError("CI has a production resolver write permission");

    currentStep = "IPFS approval manifest";
    const approvalPointer = `ipfs://${result.approvalManifestCid}`;
    const releaseIsPointer = prod.releaseRecord === approvalPointer || prod.releaseRecord === prod.manifestRecord;
    const isControllerRelease = /^0x[0-9a-f]{64}$/i.test(prod.releaseRecord);
    if (!releaseIsPointer && !isControllerRelease) throw new IntegrityError("ensure.release does not match the signed approval manifest pointer or a release-controller ID");
    const approvalResponse = await fetchIpfs(result.approvalManifestCid);
    const fetchedApprovalCid = await bytesCid(approvalResponse.bytes);
    if (!sameCid(fetchedApprovalCid, result.approvalManifestCid)) throw new IntegrityError("Fetched approval bytes do not match the ENS approval-manifest CID");
    const approvalText = new TextDecoder("utf-8", { fatal: true }).decode(approvalResponse.bytes);
    if (approvalText !== prod.approvalText) throw new IntegrityError("Fetched approval bytes differ from the inline ENS approval record");
    const envelope = parseApproval(approvalText);
    append(checks, "approval-cid", "Approval manifest fetched from IPFS", "pass", `Fetched via ${new URL(approvalResponse.gateway).host}; raw bytes match ${result.approvalManifestCid}`, onCheck);

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
    result.gateway = approvalResponse.gateway;
    result.approvalManifestUrl = approvalResponse.url;
    append(checks, "approval", "Current owner EIP-712 signature", "pass", `Release ${core.release} signed by current owner ${recovered}; valid until ${toIso(core.validUntil)}`, onCheck);
    append(checks, "cid", "ENS contenthash matches signed CID", "pass", `Both point to ${prod.cid}`, onCheck);

    if (deployment.releaseController && isControllerRelease) {
      const [currentId, controllerRelease] = await Promise.all([
        read<Hex>({ address: deployment.releaseController, abi: controllerAbi, functionName: "currentReleaseId", blockNumber: block.number }),
        read<{ approver: Address; manifestCid: string }>({ address: deployment.releaseController, abi: controllerAbi, functionName: "getRelease", args: [prod.releaseRecord as Hex], blockNumber: block.number }),
      ]);
      const controllerMatch = currentId.toLowerCase() === prod.releaseRecord.toLowerCase() && equalAddress(controllerRelease.approver, recovered) && controllerRelease.manifestCid === prod.manifestRecord;
      append(checks, "controller", "Controller release matches ENS", controllerMatch ? "pass" : "fail", controllerMatch ? `Current release ID ${currentId}` : "Controller history and production ENS records disagree", onCheck);
      if (!controllerMatch) throw new IntegrityError("Controller release does not match production ENS records");
    } else {
      append(checks, "controller", "Release controller", "info", "No release-controller ID is set on the live approval path; direct owner approval is checked", onCheck);
    }

    currentStep = "Production build manifest and site files";
    let build: BuildCheck;
    try {
      build = await verifyBuildManifestFiles(prod.cid, result.buildManifestCid, (complete, total) => {
        if (complete === total || complete === 1) append(checks, "files", "Build file SHA-256 checks", "info", `Verified ${complete} of ${total} files against the build manifest`, onCheck);
      });
    } catch (error) {
      const mismatch = error instanceof IntegrityError || error instanceof GatewayContentMismatchError;
      append(checks, "files", "Build files match manifest", mismatch ? "fail" : "unavailable", error instanceof Error ? error.message : String(error), onCheck);
      throw error;
    }
    const index = build.manifest.files.find((file) => file.path === "index.html");
    if (!index) throw new IntegrityError("Build manifest has no index.html file");
    if (index.sha256.toLowerCase() !== core.buildHash.slice(2).toLowerCase()) throw new IntegrityError("The signed buildHash differs from the manifest's index.html SHA-256");
    if (build.manifest.commitSha !== core.commit) throw new IntegrityError("The build manifest commit differs from the owner-signed commit");
    result.buildManifestCid = build.manifestCid;
    result.gateway = build.gateway;
    result.buildManifestUrl = build.url;
    result.siteUrl = `${build.gateway}/ipfs/${encodeURIComponent(prod.cid)}/`;
    append(checks, "files", "Build files match manifest", "pass", `${build.fileCount} files fetched from the IPFS CID; every size and SHA-256 matches. index.html also matches the signed buildHash.`, onCheck);
    append(checks, "preview", "Preview remains separately addressable", "info", preview.cid ? `${preview.name} has its own CID ${preview.cid} and build pointer ${preview.buildRecord || "not set"}` : `${preview.name} is not currently published; production verification is independent`, onCheck);

    const snapshotHash = block.hash;
    if (snapshotHash && (await publicClient.getBlock({ blockNumber: block.number })).hash !== snapshotHash) throw new IntegrityError("Sepolia block changed during verification; retry against a stable snapshot");
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

export const verifyName = verifyProject;

export async function readCurrentProjectOwner(blockNumber?: bigint): Promise<Address> {
  const state = await read<RegistrationState>({
    address: deployment.protocol.ethRegistry,
    abi: B.eth,
    functionName: "getState",
    args: [labelId(deployment.label)],
    ...(blockNumber ? { blockNumber } : {}),
  });
  if (Number(state.status) !== 2 || state.expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Error(`${deployment.projectName} is inactive or expired`);
  if (state.resource.toString() !== deployment.projectResource) throw new Error(`${deployment.projectName} has a different registry resource than configured`);
  return state.latestOwner;
}
