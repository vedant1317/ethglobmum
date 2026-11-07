# Release controller v2 — local implementation, not deployed

## Scope and authority

`contracts/src/ENSureReleaseController.sol` is non-upgradeable, hard-scoped to
`ensure.eth`, `prod.ensure.eth`, `preview.ensure.eth` and chain **11155111**.
Constructor and every mutating function reject another chain. Constructor pins the
ENS helper, project child registry and separate prod/preview resolvers; all must
have deployed code. It checks routing immediately. The supplied baseline is a
reviewed legacy release checkpoint, not an imported approval: initial current ID
is zero, and the first action must have sequence `baseline + 1`.

The helper's `findExactOwner(projectDns)` is read on every action, following the
existing `EnsOwned` approach. A zero owner or changed exact project child registry
fails closed. Promote/rollback require **both** the current owner as caller and a
valid signature from that same owner. This intentionally excludes relayers,
including CI even when it possesses an owner signature. Pause, unpause and nonce
cancellation require the current owner as caller. There is no fixed recovery key,
server/publisher shortcut, upgrade/admin function or arbitrary-call method.

## Typed signatures

Domain: `name = ENSureReleaseController`, `version = 2`, live `chainId`,
`verifyingContract = controller`. Only 65-byte EOA signatures, `v = 27/28`, nonzero
recovered signer and low `s` are accepted. V1 approval signatures cannot be reused.

Exact EIP-712 primary type strings:

```text
Promote(bytes32 contenthashHash,string buildPointer,bytes32 manifestDigest,bytes32 commitDigest,uint64 sequence,bytes32 expectedCurrentReleaseId,uint256 nonce,uint256 deadline)
Rollback(bytes32 targetReleaseId,uint64 sequence,bytes32 expectedCurrentReleaseId,uint256 nonce,uint256 deadline)
```

EIP-712 encodes `buildPointer` as `keccak256(bytes(buildPointer))`, not the ABI
offset or literal string bytes. Use `hashPromote` / `hashRollback` for the final
`0x1901` digest; tests independently reconstruct those hashes.

Every action needs `nonce == nonces[currentOwner]`, `sequence == lastSequence + 1`
and an exact expected current ID. The deadline is inclusive: valid at the exact
second, rejected afterwards. Successful promote and rollback increment the owner's
nonce and global sequence together. `cancelNonce(newNonce)` must increase the
current owner's nonce, invalidating all lower nonces for either action type. The
maximum uint256 nonce is rejected to avoid accidentally making the next increment
impossible.
Client approvals should use short deadlines (for example 15 minutes).

## Preview and artifact binding

At execution, promote checks current prod and preview resolver routing. It reads
preview with the actual ENSv2 API:

```text
resolve(previewDns, abi.encodeCall(contenthash(bytes32), (previewNode))) -> ABI bytes
resolve(previewDns, abi.encodeCall(text(bytes32,string), (previewNode,"ensure.build"))) -> ABI string
```

**Both** contenthash hash and build pointer must match the signed values. A CI
publish during owner review causes a stale approval to fail. Supported site
contenthashes are ENSIP-7 IPFS CIDv1, raw or dag-pb, SHA2-256, exactly 38 bytes.
Build pointers are CID-only `ipfs://` URLs for raw or dag-pb CIDv1/SHA2-256 in canonical
lower-case base32, with checked header/padding; no URL, path, query or IPNS.

`manifestDigest` is `keccak256(raw canonical build-manifest bytes)` and
`commitDigest` is the existing core format `keccak256(UTF8(lower-case git SHA))`.
Both are nonzero signed commitments. The controller does **not** fetch/parse a
manifest, establish its digest against the CID, or check per-file integrity.
A v2 public verifier must fetch the build manifest, perform codec-aware CID/DAG verification
(raw SHA-256 for raw CIDs, UnixFS/DAG verification for dag-pb), check the signed
keccak digest, canonical JSON, commit/site CID and listed files.
These cryptographic commitments do not prove code safety or reproducibility.

## Deliberate v2 resolver record schema

One prod `multicall` writes **five setters**:

| Record | V2 value |
| --- | --- |
| contenthash | The approved artifact's validated ENSIP-7 bytes |
| `ensure.release` | Canonical unsigned decimal **action sequence**, without leading zeros |
| `ensure.manifest` | Build manifest pointer (`ipfs://<CID>`), identical to `ensure.build` |
| `ensure.approval` | Lower-case `0x` hex of the ABI approval proof described below |
| `ensure.build` | The owner's signed build manifest pointer |

`ensure.manifest` is intentionally the **build** manifest here, not an approval
CID. The proof is on-chain in the approval record and transition storage; no
approval-CID construction or self-referential signature is used.

Proof bytes are exactly:

```solidity
// Promotion: action = 1
abi.encode(uint8(2), uint8(1), domainSeparator(), promoteStruct, signature)
// Rollback: action = 2
abi.encode(uint8(2), uint8(2), domainSeparator(), rollbackStruct, signature)
```

Decode with `(uint8,uint8,bytes32,Promote,bytes)` or
`(uint8,uint8,bytes32,Rollback,bytes)` according to the action. A rollback proof's
target ID points to the immutable stored artifact and its original approval.
The domain identifies this chain/controller; clients also verify deployed code,
ENS routing and the owner-controlled controller pointer, not a self-asserted ABI.

All five records are read back and compared before success. Checks/effects happen
before the external write, with a guard covering every mutation. A failing setter,
missing role, silent dropped write or readback mismatch reverts the entire
transaction: resolver records, release existence, transition, nonce and sequence.

**Breaking compatibility:** existing v1 tools expect release/manifest to be equal
approval-envelope CID pointers and inline canonical JSON. They do not understand
v2. This step deliberately does not change frontend, verifier, existing owner
scripts or their behavior. Do not deploy/grant/activate this controller until a
versioned reader and explicit owner/controller role allowlist are tested; do not
claim existing GREEN checks already support these records. `ensure.controller`
remains an owner-written pointer and is not changed by this implementation.

## History, pause and rollback

Artifact ID is
`keccak256(abi.encode(projectNode,contenthashHash,keccak256(bytes(buildPointer)),manifestDigest,commitDigest))`.
An artifact is stored once with `exists`, bytes/pointer/digests, original approver,
time and first sequence. Promoting the same ID again fails; use rollback to
reassert it. `getRelease(id)` returns `exists = false` for an unknown ID.

`transitionCount()` and `getTransition(index)` provide append-only action history:
sequence, from/to artifact, current authorizer, timestamp, rollback flag, signed
action digest and exact ABI proof. Events index ID, previous ID and authorizer;
transaction hashes come from receipts/logs. Out-of-range transition indices revert.

Rollback requires a fresh current-owner signature and an existing controller-
approved artifact. It restores contenthash/build/manifest, writes the new forward-
moving decimal sequence and a fresh rollback proof. It does not require current
preview equality, and can reassert the current artifact to repair a direct write.
Historical releases before this controller are not silently approved/imported.

Pause blocks promotions only; signed owner rollback is allowed while paused.
Only the current owner can unpause. Pause does not invalidate signatures by itself:
use `cancelNonce` as well during an incident. Pause does not take the live site
offline and cannot block direct resolver writes by retained privileged accounts.

## Roles to grant later — not performed in this step

On the **dedicated production resolver**, the owner must grant:

- Root `ROLE_SET_CONTENTHASH` (`1 << 8`) to the controller.
- `grantSetterRoles(encoded setText(prodDns,key,""), controller)` for each exact
  key: `ensure.release`, `ensure.manifest`, `ensure.approval`, `ensure.build`.
  Each is `ROLE_SET_TEXT` (`1 << 4`) on `keccak256(bytes(key))`.

No root text, admin bits, LINK, UPGRADE, registry or preview permissions. Use the
resolver's root/setter grant methods, not generic `grantRoles`. Verify effective
root/inherited/key permissions and packed assignee counts before activation.
CI must hold no production writer/admin/upgrade/link/registry route. Root content
and key scopes are resolver-wide, so keep prod and preview on separate dedicated
resolvers. The controller itself can only write its fixed prod DNS name.

The owner retains administration as a trust root and can bypass/revoke the
controller; the verifier must detect controller/record drift. ENS transfer does
not automatically migrate separately held resolver administration. During handover,
migrate/revoke those rights deliberately, then verify both old and new accounts.

## Tests and deployment preparation

```sh
cd contracts
forge build
forge test -vv
# Optional public read-only ABI fork check; no signing key is needed:
ENSURE_FORK_RPC_URL=<Sepolia-RPC> forge test --match-contract ENSureReleaseControllerForkTest -vv
# From repository root:
pnpm test
```

Tests use EOA test fixtures and role-enforcing delegatecall resolver mocks, final-
setter failure, silent dropped writes, callback reentry, independently constructed
typed digests, owner rotation, all requested permission/state paths and a 256-run
sequence fuzz test. The optional fork test is **skipped** without its explicit RPC
variable; it checks real helper/resolver read ABI and routing, not full production
role grants or live release execution. No test sends an external transaction.

`contracts/script/DeployReleaseController.s.sol` is prepared but **not run**. It
reads only `CONTROLLER_BASELINE_SEQUENCE`, uses an externally selected signer and
pins public Sepolia addresses. A separate reviewed deployment must first establish
the live legacy sequence, test actual EAC writes on a fork, and update readers.
Do not assume the test baseline (5) is current production state.

## Explicit limitations

Unaudited hackathon implementation; not production-ready. No ERC-1271/Safe signing,
full ancestry/registration-generation/proxy-provenance proof, ownership-transfer
hook, automatic role migration or guardian recovery. Routing/zero-owner checks
fail closed where provided, but helper correctness and pinned ENS implementations
remain trust assumptions. Every new instance has an isolated EIP-712 domain.

Nonces are per owner and retained across rotation. An unused unexpired signature
may become valid again if the same ENS owner transfers away and returns with
unchanged expected release/nonce; cancel pending nonces during handover. Since
submission is owner-only, another holder of that old signature cannot submit it.
The uint64 sequence cannot wrap: its maximum permits no further release action.
Approvals/transition proof storage increases gas; simulate before any wallet prompt.
Arkiv is optional history presentation, never authorization or a required dependency.
