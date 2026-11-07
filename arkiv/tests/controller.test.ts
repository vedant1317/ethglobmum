import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseEventLogs, toBytes, toEventSelector, type Hex } from "viem";
import { cidFromBuildPointer, controllerV2Abi } from "../src/controller";

const solidity = readFileSync(fileURLToPath(new URL("../../contracts/ensure/src/ENSureReleaseController.sol", import.meta.url)), "utf8");

/** Rebuilds a canonical event signature from the Solidity declaration, e.g. `ReleasePromoted(bytes32,…)`. */
function solidityEventSignature(name: string) {
  const match = new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)`, "s").exec(solidity);
  assert.ok(match, `event ${name} not found in ENSureReleaseController.sol`);
  const types = match[1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
  return `${name}(${types.join(",")})`;
}

test("event ABI matches the v2 contract source", () => {
  for (const name of ["ReleasePromoted", "ReleaseRolledBack"] as const) {
    const fromSource = keccak256(toBytes(solidityEventSignature(name)));
    assert.equal(toEventSelector(controllerV2Abi.find((x) => x.type === "event" && x.name === name)!), fromSource, name);
  }
});

test("Release struct field order matches the contract", () => {
  const struct = /struct Release \{([^}]*)\}/s.exec(solidity)![1];
  const fields = struct.split(";").map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
  const getRelease = controllerV2Abi.find((x) => x.type === "function" && x.name === "getRelease")!;
  const abiFields = (getRelease as { outputs: readonly { components: readonly { name: string }[] }[] }).outputs[0].components.map((c) => c.name);
  assert.deepEqual(abiFields, fields);
});

test("the contract no longer has a recovery path", () => {
  assert.doesNotMatch(solidity, /ReleaseRecovered|recoveryAuthority/);
});

test("decodes a v2 ReleasePromoted log", () => {
  const releaseId = `0x${"1".repeat(64)}` as Hex;
  const previous = `0x${"2".repeat(64)}` as Hex;
  const approver = "0xBa3084737A99f3ccB2F384b3AE8f325CF50EfBBe";
  const topics = encodeEventTopics({ abi: controllerV2Abi, eventName: "ReleasePromoted", args: { releaseId, previousReleaseId: previous, approver } });
  const data = encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }], [6n, `0x${"3".repeat(64)}`]);
  const [log] = parseEventLogs({
    abi: controllerV2Abi,
    strict: true,
    logs: [{ address: "0x0000000000000000000000000000000000000c0d", topics: topics as [Hex, ...Hex[]], data, blockHash: null, blockNumber: null, logIndex: 0, transactionHash: null, transactionIndex: null, removed: false }],
  });
  assert.equal(log.eventName, "ReleasePromoted");
  assert.equal((log.args as { sequence: bigint }).sequence, 6n);
  assert.equal((log.args as { approver: string }).approver.toLowerCase(), approver.toLowerCase());
});

test("buildPointer must be an ipfs:// CID", () => {
  assert.equal(cidFromBuildPointer("ipfs://bafkreiegr2lhz5prd7bun736mwyhvxe4x3fctxvtmgzhfxzcvcxdq54v3i"), "bafkreiegr2lhz5prd7bun736mwyhvxe4x3fctxvtmgzhfxzcvcxdq54v3i");
  assert.throws(() => cidFromBuildPointer("https://ipfs.io/ipfs/bafy"), /not an ipfs:\/\/ CID/);
  assert.throws(() => cidFromBuildPointer("ipfs://"), /not an ipfs:\/\/ CID/);
});
