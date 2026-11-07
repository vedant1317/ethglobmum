// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ENSureReleaseController as Controller,
    IReleaseRegistry,
    IReleaseOwnerHelper,
    IReleaseResolver,
    IReleaseProfile
} from "../src/ENSureReleaseController.sol";

interface ReleaseVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function chainId(uint256) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function createSelectFork(string calldata url) external returns (uint256);
    function skip(bool condition) external;
}

contract ReleaseRegistryMock is IReleaseRegistry {
    mapping(bytes32 => address) private _resolvers;

    function setResolver(string calldata label, address value) external {
        _resolvers[keccak256(bytes(label))] = value;
    }

    function getResolver(string calldata label) external view returns (address) {
        return _resolvers[keccak256(bytes(label))];
    }
}

contract ReleaseOwnerMock is IReleaseOwnerHelper {
    address public owner;
    address public registry;

    function configure(address owner_, address registry_) external {
        owner = owner_;
        registry = registry_;
    }

    function findExactOwner(bytes calldata dns) external view returns (address) {
        require(keccak256(dns) == keccak256(hex"06656e737572650365746800"), "wrong project DNS");
        return owner;
    }

    function findExactRegistry(bytes calldata) external view returns (address) {
        return registry;
    }
}

/// @dev Delegatecall multicall preserves the external caller, as required by ENSv2 EAC.
///      No controller privileges bypass the per-setter checks.
contract ReleaseResolverMock is IReleaseResolver {
    struct Records {
        bytes contenthash;
        mapping(bytes32 => string) texts;
    }
    mapping(bytes32 => Records) private _records;
    mapping(address => bool) public contentWriters;
    mapping(bytes32 => mapping(address => bool)) public textWriters;
    address private immutable admin = msg.sender;
    bytes32 public failKey;
    bytes32 public dropKey;
    uint256 public multicallCount;
    Controller public callback;
    bool public callbackAttempted;
    error NoRole();
    error SetterFailed();

    function grantContent(address account, bool allowed) external {
        require(msg.sender == admin, "admin");
        contentWriters[account] = allowed;
    }

    function grantText(string calldata key, address account, bool allowed) external {
        require(msg.sender == admin, "admin");
        textWriters[keccak256(bytes(key))][account] = allowed;
    }

    function faults(bytes32 fail_, bytes32 drop_) external {
        require(msg.sender == admin, "admin");
        failKey = fail_;
        dropKey = drop_;
    }

    function setCallback(Controller c) external {
        require(msg.sender == admin, "admin");
        callback = c;
    }

    function setContenthash(bytes calldata dns, bytes calldata value) external {
        if (!contentWriters[msg.sender]) revert NoRole();
        _records[keccak256(dns)].contenthash = value;
    }

    function setText(bytes calldata dns, string calldata key, string calldata value) external {
        bytes32 k = keccak256(bytes(key));
        if (!textWriters[k][msg.sender]) revert NoRole();
        if (k == failKey) revert SetterFailed();
        if (k == dropKey) return;
        if (address(callback) != address(0) && k == keccak256("ensure.approval")) {
            callbackAttempted = true;
            (bool ok, bytes memory reason) = address(callback).call(abi.encodeCall(Controller.pause, ()));
            require(!ok && bytes4(reason) == Controller.Reentrancy.selector, "guard did not reject reentry");
        }
        _records[keccak256(dns)].texts[k] = value;
    }

    function multicall(bytes[] calldata calls) external returns (bytes[] memory results) {
        multicallCount++;
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory result) = address(this).delegatecall(calls[i]);
            if (!ok) {
                assembly { revert(add(result, 32), mload(result)) }
            }
            results[i] = result;
        }
    }

    function resolve(bytes calldata dns, bytes calldata data) external view returns (bytes memory) {
        if (bytes4(data[:4]) == IReleaseProfile.contenthash.selector) {
            bytes32 contentNode = abi.decode(data[4:], (bytes32));
            require(contentNode == _node(dns, 0), "wrong contenthash node");
            return abi.encode(_records[keccak256(dns)].contenthash);
        }
        require(bytes4(data[:4]) == IReleaseProfile.text.selector, "wrong profile selector");
        (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
        require(node == _node(dns, 0), "wrong text node");
        return abi.encode(_records[keccak256(dns)].texts[keccak256(bytes(key))]);
    }

    function _node(bytes calldata dns, uint256 offset) private pure returns (bytes32) {
        uint256 len = uint8(dns[offset]);
        if (len == 0) return bytes32(0);
        return keccak256(abi.encodePacked(_node(dns, offset + len + 1), keccak256(dns[offset + 1:offset + 1 + len])));
    }
}

contract ENSureReleaseControllerTest {
    ReleaseVm private constant vm = ReleaseVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant NEXT_OWNER_KEY = 0xB0B;
    uint256 private constant CI_KEY = 0xC1;
    bytes private constant PROD = hex"0470726f6406656e737572650365746800";
    bytes private constant PREVIEW = hex"077072657669657706656e737572650365746800";
    string private constant BUILD_A = string(
        hex"697066733a2f2f6261666b72656961616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161"
    );
    string private constant BUILD_B = string(
        hex"697066733a2f2f6261666b7265696363696a626565717363696a626565717363696a626565717363696a626565717363696a626565717363696a6265657173636969"
    );
    uint64 private constant BASELINE = 5;
    address private owner;
    address private nextOwner;
    address private ci;
    ReleaseOwnerMock private helper;
    ReleaseRegistryMock private registry;
    ReleaseResolverMock private prod;
    ReleaseResolverMock private preview;
    Controller private controller;

    event ReleasePromoted(
        bytes32 indexed releaseId,
        bytes32 indexed previousReleaseId,
        address indexed approver,
        uint64 sequence,
        bytes32 actionDigest
    );
    event ReleaseRolledBack(
        bytes32 indexed releaseId,
        bytes32 indexed fromReleaseId,
        address indexed approver,
        uint64 sequence,
        bytes32 actionDigest
    );
    event Paused(address indexed owner);
    event Unpaused(address indexed owner);
    event NonceCancelled(address indexed owner, uint256 previousNonce, uint256 newNonce);

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(1_800_000_000);
        owner = vm.addr(OWNER_KEY);
        nextOwner = vm.addr(NEXT_OWNER_KEY);
        ci = vm.addr(CI_KEY);
        helper = new ReleaseOwnerMock();
        registry = new ReleaseRegistryMock();
        prod = new ReleaseResolverMock();
        preview = new ReleaseResolverMock();
        helper.configure(owner, address(registry));
        registry.setResolver("prod", address(prod));
        registry.setResolver("preview", address(preview));
        controller = new Controller(helper, registry, prod, preview, BASELINE);
        _grant(prod, address(controller));
        _grant(prod, owner);
        _grant(preview, address(this));
        _grant(preview, ci);
        _preview(_ch(1), BUILD_A);
    }

    function _grant(ReleaseResolverMock resolver, address account) private {
        resolver.grantContent(account, true);
        resolver.grantText("ensure.release", account, true);
        resolver.grantText("ensure.manifest", account, true);
        resolver.grantText("ensure.approval", account, true);
        resolver.grantText("ensure.build", account, true);
    }

    function _ch(uint256 value) private pure returns (bytes memory) {
        return abi.encodePacked(hex"e30101701220", bytes32(value));
    }

    function _preview(bytes memory ch, string memory pointer) private {
        preview.setContenthash(PREVIEW, ch);
        preview.setText(PREVIEW, "ensure.build", pointer);
    }

    function _proposal() private view returns (Controller.Promote memory) {
        return Controller.Promote(
            keccak256(_ch(1)),
            BUILD_A,
            keccak256("manifest-A"),
            keccak256("commit-A"),
            controller.lastSequence() + 1,
            controller.currentReleaseId(),
            controller.nonces(owner),
            block.timestamp + 900
        );
    }

    function _domain(address target, uint256 chain, string memory version) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ENSureReleaseController"),
                keccak256(bytes(version)),
                chain,
                target
            )
        );
    }

    function _promoteDigest(Controller.Promote memory p, bytes32 domain) private pure returns (bytes32) {
        bytes32 typehash = keccak256(
            "Promote(bytes32 contenthashHash,string buildPointer,bytes32 manifestDigest,bytes32 commitDigest,uint64 sequence,bytes32 expectedCurrentReleaseId,uint256 nonce,uint256 deadline)"
        );
        bytes32 h = keccak256(
            abi.encode(
                typehash,
                p.contenthashHash,
                keccak256(bytes(p.buildPointer)),
                p.manifestDigest,
                p.commitDigest,
                p.sequence,
                p.expectedCurrentReleaseId,
                p.nonce,
                p.deadline
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, h));
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sig(Controller.Promote memory p) private returns (bytes memory) {
        return _sign(OWNER_KEY, _promoteDigest(p, _domain(address(controller), 11155111, "2")));
    }

    function _send(Controller.Promote memory p, bytes memory signature) private returns (bytes32) {
        vm.prank(owner);
        return controller.promote(_ch(1), p, signature);
    }

    function _promoteA() private returns (bytes32) {
        Controller.Promote memory p = _proposal();
        return _send(p, _sig(p));
    }

    function _promoteB() private returns (bytes32) {
        _preview(_ch(2), BUILD_B);
        Controller.Promote memory p = _proposal();
        p.contenthashHash = keccak256(_ch(2));
        p.buildPointer = BUILD_B;
        p.manifestDigest = keccak256("manifest-B");
        p.commitDigest = keccak256("commit-B");
        bytes memory sig = _sig(p);
        vm.prank(owner);
        return controller.promote(_ch(2), p, sig);
    }

    function _rollback(bytes32 target) private view returns (Controller.Rollback memory) {
        return Controller.Rollback(
            target,
            controller.lastSequence() + 1,
            controller.currentReleaseId(),
            controller.nonces(owner),
            block.timestamp + 900
        );
    }

    function _rollbackSig(Controller.Rollback memory r) private returns (bytes memory) {
        bytes32 typehash = keccak256(
            "Rollback(bytes32 targetReleaseId,uint64 sequence,bytes32 expectedCurrentReleaseId,uint256 nonce,uint256 deadline)"
        );
        bytes32 h = keccak256(
            abi.encode(typehash, r.targetReleaseId, r.sequence, r.expectedCurrentReleaseId, r.nonce, r.deadline)
        );
        return _sign(OWNER_KEY, keccak256(abi.encodePacked(hex"1901", _domain(address(controller), 11155111, "2"), h)));
    }

    function _sendRollback(Controller.Rollback memory r) private {
        bytes memory sig = _rollbackSig(r);
        vm.prank(owner);
        controller.rollback(r, sig);
    }

    function _text(string memory key) private view returns (string memory) {
        return
            abi.decode(prod.resolve(PROD, abi.encodeCall(IReleaseProfile.text, (controller.prodNode(), key))), (string));
    }

    function _hash() private view returns (bytes memory) {
        return
            abi.decode(
                prod.resolve(PROD, abi.encodeCall(IReleaseProfile.contenthash, (controller.prodNode()))), (bytes)
            );
    }

    function _snapshot() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                _hash(),
                _text("ensure.release"),
                _text("ensure.manifest"),
                _text("ensure.approval"),
                _text("ensure.build")
            )
        );
    }

    function _eq(string memory a, string memory b) private pure {
        require(keccak256(bytes(a)) == keccak256(bytes(b)), "text differs");
    }

    function _rejected(Controller.Promote memory p, bytes memory sig, bytes4 error_) private {
        vm.expectRevert(error_);
        vm.prank(owner);
        controller.promote(_ch(1), p, sig);
    }

    function test_happyPromote_recordsHistoryAndIndependentDigest() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        require(
            controller.hashPromote(p) == _promoteDigest(p, _domain(address(controller), 11155111, "2")), "typed digest"
        );
        bytes32 expected = keccak256(
            abi.encode(
                controller.projectNode(),
                p.contenthashHash,
                keccak256(bytes(p.buildPointer)),
                p.manifestDigest,
                p.commitDigest
            )
        );
        vm.expectEmit(true, true, true, true, address(controller));
        emit ReleasePromoted(expected, bytes32(0), owner, 6, controller.hashPromote(p));
        bytes32 id = _send(p, sig);
        require(id == expected && controller.currentReleaseId() == id && controller.lastSequence() == 6, "current");
        require(
            controller.nonces(owner) == 1 && controller.transitionCount() == 1 && prod.multicallCount() == 1, "counts"
        );
        Controller.Release memory r = controller.getRelease(id);
        require(r.exists && r.approver == owner && r.firstSequence == 6 && r.approvedAt == block.timestamp, "release");
        require(r.manifestDigest == p.manifestDigest && r.commitDigest == p.commitDigest, "digests");
        require(keccak256(r.contenthash) == keccak256(_ch(1)) && keccak256(_hash()) == keccak256(_ch(1)), "hash");
        _eq(_text("ensure.release"), "6");
        _eq(_text("ensure.build"), BUILD_A);
        _eq(_text("ensure.manifest"), BUILD_A);
        Controller.Transition memory t = controller.getTransition(0);
        require(t.sequence == 6 && t.fromReleaseId == 0 && t.toReleaseId == id && !t.isRollback, "transition");
        require(t.actionDigest == controller.hashPromote(p) && t.authorizer == owner, "authorization");
        (uint8 version, uint8 action, bytes32 domain, Controller.Promote memory decoded, bytes memory decodedSig) =
            abi.decode(t.proof, (uint8, uint8, bytes32, Controller.Promote, bytes));
        require(version == 2 && action == 1 && domain == controller.domainSeparator() && decoded.sequence == 6, "proof");
        require(keccak256(decodedSig) == keccak256(sig), "proof signature");
        require(keccak256(bytes(_text("ensure.approval"))) == keccak256(bytes(_hex(t.proof))), "proof record");
    }

    function test_wrongSigner() public {
        Controller.Promote memory p = _proposal();
        _rejected(p, _sign(CI_KEY, controller.hashPromote(p)), Controller.InvalidSignature.selector);
    }

    function test_oldOwnerAfterTransferRejected_newOwnerWorks() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        helper.configure(nextOwner, address(registry));
        _rejected(p, sig, Controller.NotOwner.selector);
        vm.expectRevert(Controller.InvalidSignature.selector);
        vm.prank(nextOwner);
        controller.promote(_ch(1), p, sig);
        sig = _sign(NEXT_OWNER_KEY, controller.hashPromote(p));
        vm.prank(nextOwner);
        controller.promote(_ch(1), p, sig);
        require(
            controller.currentOwner() == nextOwner && controller.nonces(nextOwner) == 1
                && controller.nonces(owner) == 0,
            "rotation"
        );
    }

    function test_replay() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        _send(p, sig);
        _rejected(p, sig, Controller.InvalidNonce.selector);
    }

    function test_expired() public {
        Controller.Promote memory p = _proposal();
        p.deadline = block.timestamp - 1;
        _rejected(p, _sig(p), Controller.ApprovalExpired.selector);
    }

    function test_deadlineExactBoundaryAccepted() public {
        Controller.Promote memory p = _proposal();
        p.deadline = block.timestamp;
        _send(p, _sig(p));
    }

    function test_wrongChainSignature() public {
        Controller.Promote memory p = _proposal();
        _rejected(
            p,
            _sign(OWNER_KEY, _promoteDigest(p, _domain(address(controller), 1, "2"))),
            Controller.InvalidSignature.selector
        );
    }

    function test_wrongContractDomain() public {
        Controller.Promote memory p = _proposal();
        _rejected(
            p,
            _sign(OWNER_KEY, _promoteDigest(p, _domain(address(0x1234), 11155111, "2"))),
            Controller.InvalidSignature.selector
        );
    }

    function test_wrongVersionDomain() public {
        Controller.Promote memory p = _proposal();
        _rejected(
            p,
            _sign(OWNER_KEY, _promoteDigest(p, _domain(address(controller), 11155111, "1"))),
            Controller.InvalidSignature.selector
        );
    }

    function test_wrongSequence() public {
        Controller.Promote memory p = _proposal();
        p.sequence = 8;
        _rejected(p, _sig(p), Controller.InvalidSequence.selector);
    }

    function test_wrongExpectedCurrent() public {
        Controller.Promote memory p = _proposal();
        p.expectedCurrentReleaseId = bytes32(uint256(123));
        _rejected(p, _sig(p), Controller.CurrentReleaseMismatch.selector);
    }

    function test_previewContenthashMismatch() public {
        _preview(_ch(2), BUILD_A);
        Controller.Promote memory p = _proposal();
        _rejected(p, _sig(p), Controller.PreviewContenthashMismatch.selector);
    }

    function test_previewBuildMismatch() public {
        _preview(_ch(1), BUILD_B);
        Controller.Promote memory p = _proposal();
        _rejected(p, _sig(p), Controller.PreviewBuildMismatch.selector);
    }

    function test_atomicRevertOnLastSetter_keepsAllFiveRecordsAndHistory() public {
        bytes32 first = _promoteA();
        bytes32 before_ = _snapshot();
        _preview(_ch(2), BUILD_B);
        Controller.Promote memory p = _proposal();
        p.contenthashHash = keccak256(_ch(2));
        p.buildPointer = BUILD_B;
        bytes memory sig = _sig(p);
        prod.faults(keccak256("ensure.build"), bytes32(0));
        vm.expectRevert(ReleaseResolverMock.SetterFailed.selector);
        vm.prank(owner);
        controller.promote(_ch(2), p, sig);
        require(
            _snapshot() == before_ && controller.currentReleaseId() == first && controller.lastSequence() == 6,
            "not atomic"
        );
        require(
            controller.nonces(owner) == 1 && controller.transitionCount() == 1 && prod.multicallCount() == 1,
            "effects leaked"
        );
        bytes32 failedId = keccak256(
            abi.encode(
                controller.projectNode(),
                p.contenthashHash,
                keccak256(bytes(p.buildPointer)),
                p.manifestDigest,
                p.commitDigest
            )
        );
        require(!controller.getRelease(failedId).exists, "failed release exists");
    }

    function test_readbackDetectsSilentDrop() public {
        prod.faults(bytes32(0), keccak256("ensure.approval"));
        Controller.Promote memory p = _proposal();
        _rejected(p, _sig(p), Controller.WriteVerificationFailed.selector);
        require(
            controller.transitionCount() == 0 && controller.nonces(owner) == 0 && _hash().length == 0,
            "silent drop not atomic"
        );
    }

    function test_rollbackKnown_restoresArtifactFreshProofAndMonotonicSequence() public {
        bytes32 a = _promoteA();
        string memory firstProof = _text("ensure.approval");
        bytes32 b = _promoteB();
        Controller.Rollback memory r = _rollback(a);
        vm.expectEmit(true, true, true, true, address(controller));
        emit ReleaseRolledBack(a, b, owner, 8, controller.hashRollback(r));
        _sendRollback(r);
        require(
            controller.currentReleaseId() == a && controller.lastSequence() == 8 && controller.nonces(owner) == 3,
            "rollback state"
        );
        _eq(_text("ensure.release"), "8");
        _eq(_text("ensure.manifest"), BUILD_A);
        _eq(_text("ensure.build"), BUILD_A);
        require(keccak256(_hash()) == keccak256(_ch(1)), "artifact not restored");
        require(keccak256(bytes(firstProof)) != keccak256(bytes(_text("ensure.approval"))), "old approval reused");
        Controller.Transition memory t = controller.getTransition(2);
        require(t.isRollback && t.fromReleaseId == b && t.toReleaseId == a && t.sequence == 8, "rollback transition");
        (uint8 version, uint8 action, bytes32 domain, Controller.Rollback memory decoded,) =
            abi.decode(t.proof, (uint8, uint8, bytes32, Controller.Rollback, bytes));
        require(
            version == 2 && action == 2 && domain == controller.domainSeparator() && decoded.targetReleaseId == a,
            "rollback proof"
        );
        require(controller.getRelease(a).firstSequence == 6, "approval history overwritten");
    }

    function test_rollbackUnknown() public {
        Controller.Rollback memory r = _rollback(bytes32(uint256(999)));
        bytes memory sig = _rollbackSig(r);
        vm.expectRevert(Controller.UnknownRelease.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
    }

    function test_rollbackWhilePaused() public {
        bytes32 a = _promoteA();
        _promoteB();
        vm.prank(owner);
        controller.pause();
        _sendRollback(_rollback(a));
        require(controller.paused() && controller.currentReleaseId() == a, "paused rollback");
    }

    function test_promoteWhilePaused() public {
        vm.prank(owner);
        controller.pause();
        Controller.Promote memory p = _proposal();
        _rejected(p, _sig(p), Controller.PromotionsPaused.selector);
    }

    function test_pauseAndUnpauseEvents() public {
        vm.expectEmit(true, false, false, true, address(controller));
        emit Paused(owner);
        vm.prank(owner);
        controller.pause();
        vm.expectEmit(true, false, false, true, address(controller));
        emit Unpaused(owner);
        vm.prank(owner);
        controller.unpause();
        require(!controller.paused(), "unpause");
        _promoteA();
    }

    function test_nonOwnerPauseAndUnpause() public {
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.pause();
        vm.prank(owner);
        controller.pause();
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.unpause();
    }

    function test_nonceCancelEventAndOldSignature() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        vm.expectEmit(true, false, false, true, address(controller));
        emit NonceCancelled(owner, 0, 10);
        vm.prank(owner);
        controller.cancelNonce(10);
        _rejected(p, sig, Controller.InvalidNonce.selector);
        p.nonce = 10;
        _send(p, _sig(p));
        require(controller.nonces(owner) == 11, "new nonce");
    }

    function test_nonceCannotDecrease() public {
        vm.prank(owner);
        controller.cancelNonce(3);
        vm.expectRevert(Controller.InvalidNonce.selector);
        vm.prank(owner);
        controller.cancelNonce(3);
        vm.expectRevert(Controller.InvalidNonce.selector);
        vm.prank(owner);
        controller.cancelNonce(2);
    }

    function test_ciCannotAuthorizeSubmitOrAdministerProduction() public {
        Controller.Promote memory p = _proposal();
        bytes memory validOwnerSig = _sig(p);
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.promote(_ch(1), p, validOwnerSig);
        Controller.Rollback memory r = _rollback(bytes32(uint256(1)));
        bytes memory sig = _rollbackSig(r);
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.rollback(r, sig);
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.cancelNonce(99);
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.pause();
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(ci);
        controller.unpause();
        vm.expectRevert(ReleaseResolverMock.NoRole.selector);
        vm.prank(ci);
        prod.setContenthash(PROD, _ch(3));
        vm.expectRevert(ReleaseResolverMock.NoRole.selector);
        vm.prank(ci);
        prod.setText(PROD, "ensure.approval", "bad");
        require(
            controller.lastSequence() == BASELINE && controller.nonces(ci) == 0 && _hash().length == 0,
            "CI changed prod"
        );
    }

    function test_missingControllerRoleRevertsAtomically() public {
        prod.grantText("ensure.build", address(controller), false);
        Controller.Promote memory p = _proposal();
        _rejected(p, _sig(p), ReleaseResolverMock.NoRole.selector);
        require(
            controller.transitionCount() == 0 && _hash().length == 0 && controller.nonces(owner) == 0,
            "role failure leaked"
        );
    }

    function test_reentryBlocked() public {
        prod.setCallback(controller);
        _promoteA();
        require(prod.callbackAttempted() && !controller.paused(), "reentry");
    }

    function test_highSAndBadLengthAndBadVRejected() public {
        Controller.Promote memory p = _proposal();
        bytes32 digest = controller.hashPromote(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        _rejected(
            p,
            abi.encodePacked(r, bytes32(order - uint256(s)), uint8(v == 27 ? 28 : 27)),
            Controller.InvalidSignature.selector
        );
        _rejected(p, hex"01", Controller.InvalidSignature.selector);
        _rejected(p, abi.encodePacked(r, s, uint8(0)), Controller.InvalidSignature.selector);
        _rejected(p, new bytes(65), Controller.InvalidSignature.selector);
    }

    function test_tamperedPayloadRejected() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        p.commitDigest = keccak256("other");
        _rejected(p, sig, Controller.InvalidSignature.selector);
    }

    function test_contenthashArgumentMustMatchSignedHash() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        vm.expectRevert(Controller.InvalidArtifact.selector);
        vm.prank(owner);
        controller.promote(_ch(2), p, sig);
    }

    function test_invalidBuildEncodingRejected() public {
        Controller.Promote memory p = _proposal();
        p.buildPointer = "https://example.invalid/build";
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
        p.buildPointer = string.concat(BUILD_A, "/file");
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
        bytes memory chars = bytes(BUILD_A);
        chars[chars.length - 1] = "b";
        p.buildPointer = string(chars);
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
    }

    function test_routingMismatch() public {
        Controller.Promote memory p = _proposal();
        registry.setResolver("prod", address(preview));
        _rejected(p, _sig(p), Controller.ResolverMismatch.selector);
        registry.setResolver("prod", address(prod));
        registry.setResolver("preview", address(prod));
        _rejected(p, _sig(p), Controller.ResolverMismatch.selector);
    }

    function test_invalidOwnerContext() public {
        Controller.Promote memory p = _proposal();
        helper.configure(address(0), address(registry));
        _rejected(p, _sig(p), Controller.InvalidOwnerContext.selector);
        helper.configure(owner, address(0x1234));
        _rejected(p, _sig(p), Controller.InvalidOwnerContext.selector);
    }

    function test_constructorAndExecutionRejectWrongChain() public {
        Controller.Promote memory p = _proposal();
        bytes memory sig = _sig(p);
        vm.chainId(1);
        vm.expectRevert(Controller.WrongChain.selector);
        new Controller(helper, registry, prod, preview, BASELINE);
        _rejected(p, sig, Controller.WrongChain.selector);
        vm.expectRevert(Controller.WrongChain.selector);
        vm.prank(owner);
        controller.pause();
    }

    function test_badConstructorConfig() public {
        vm.expectRevert(Controller.InvalidConfig.selector);
        new Controller(helper, registry, prod, prod, BASELINE);
        vm.expectRevert(Controller.InvalidConfig.selector);
        new Controller(helper, registry, prod, preview, type(uint64).max);
        vm.expectRevert(Controller.InvalidConfig.selector);
        new Controller(IReleaseOwnerHelper(address(0)), registry, prod, preview, BASELINE);
    }

    function test_duplicateArtifactMustUseRollback() public {
        _promoteA();
        Controller.Promote memory p = _proposal();
        _rejected(p, _sig(p), Controller.ReleaseExists.selector);
    }

    function test_reassertCurrentRepairsDirectOwnerTamper() public {
        bytes32 a = _promoteA();
        vm.prank(owner);
        prod.setContenthash(PROD, _ch(999));
        _sendRollback(_rollback(a));
        require(keccak256(_hash()) == keccak256(_ch(1)) && controller.lastSequence() == 7, "repair");
    }

    function test_rollbackReplayWrongSequenceAndExpired() public {
        bytes32 a = _promoteA();
        Controller.Rollback memory r = _rollback(a);
        bytes memory sig = _rollbackSig(r);
        vm.prank(owner);
        controller.rollback(r, sig);
        vm.expectRevert(Controller.InvalidNonce.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
        r = _rollback(a);
        r.sequence += 1;
        sig = _rollbackSig(r);
        vm.expectRevert(Controller.InvalidSequence.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
        r = _rollback(a);
        r.deadline = block.timestamp - 1;
        sig = _rollbackSig(r);
        vm.expectRevert(Controller.ApprovalExpired.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
    }

    function test_rollbackWrongSignerAndExpectedCurrent() public {
        bytes32 a = _promoteA();
        Controller.Rollback memory r = _rollback(a);
        bytes memory sig = _sign(CI_KEY, controller.hashRollback(r));
        vm.expectRevert(Controller.InvalidSignature.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
        r.expectedCurrentReleaseId = bytes32(uint256(99));
        sig = _rollbackSig(r);
        vm.expectRevert(Controller.CurrentReleaseMismatch.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
    }

    function test_rollbackDoesNotDependOnNewPreviewOrPreviewRouting() public {
        bytes32 a = _promoteA();
        _promoteB();
        registry.setResolver("preview", address(0));
        _sendRollback(_rollback(a));
        require(controller.currentReleaseId() == a, "preview blocked emergency rollback");
    }

    function test_rollbackRoutingMismatch() public {
        bytes32 a = _promoteA();
        Controller.Rollback memory r = _rollback(a);
        bytes memory sig = _rollbackSig(r);
        registry.setResolver("prod", address(0));
        vm.expectRevert(Controller.ResolverMismatch.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
    }

    function test_rollbackPartialWriteFailureIsAtomic() public {
        bytes32 a = _promoteA();
        bytes32 b = _promoteB();
        bytes32 before_ = _snapshot();
        Controller.Rollback memory r = _rollback(a);
        bytes memory sig = _rollbackSig(r);
        prod.faults(keccak256("ensure.build"), bytes32(0));
        vm.expectRevert(ReleaseResolverMock.SetterFailed.selector);
        vm.prank(owner);
        controller.rollback(r, sig);
        require(
            _snapshot() == before_ && controller.currentReleaseId() == b && controller.lastSequence() == 7,
            "rollback leaked"
        );
        require(controller.nonces(owner) == 2 && controller.transitionCount() == 2, "rollback effects leaked");
    }

    function test_newOwnerCanRollbackOldApprovedArtifactAndManagePause() public {
        bytes32 a = _promoteA();
        _promoteB();
        helper.configure(nextOwner, address(registry));
        vm.expectRevert(Controller.NotOwner.selector);
        vm.prank(owner);
        controller.pause();
        vm.prank(nextOwner);
        controller.pause();
        Controller.Rollback memory r = _rollback(a);
        r.nonce = controller.nonces(nextOwner);
        bytes memory sig = _sign(NEXT_OWNER_KEY, controller.hashRollback(r));
        vm.prank(nextOwner);
        controller.rollback(r, sig);
        vm.prank(nextOwner);
        controller.cancelNonce(10);
        vm.prank(nextOwner);
        controller.unpause();
        require(
            controller.currentReleaseId() == a && controller.nonces(nextOwner) == 10 && !controller.paused(),
            "new owner control"
        );
        require(controller.getRelease(a).approver == owner, "historical signer overwritten");
    }

    function test_badContenthashCodecAndEmptyDigestRejected() public {
        Controller.Promote memory p = _proposal();
        bytes memory bad = _ch(1);
        bad[3] = 0x71;
        p.contenthashHash = keccak256(bad);
        bytes memory sig = _sig(p);
        vm.expectRevert(Controller.InvalidArtifact.selector);
        vm.prank(owner);
        controller.promote(bad, p, sig);
        p = _proposal();
        p.manifestDigest = bytes32(0);
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
        p = _proposal();
        p.commitDigest = bytes32(0);
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
    }

    function test_rawSiteContenthashAccepted() public {
        bytes memory ch = _ch(1);
        ch[3] = 0x55;
        _preview(ch, BUILD_A);
        Controller.Promote memory p = _proposal();
        p.contenthashHash = keccak256(ch);
        bytes memory sig = _sig(p);
        vm.prank(owner);
        controller.promote(ch, p, sig);
        require(keccak256(_hash()) == keccak256(ch), "raw CID");
    }

    function test_invalidBuildHeaderAndAlphabetRejected() public {
        Controller.Promote memory p = _proposal();
        bytes memory chars = bytes(BUILD_A);
        chars[14] = "z";
        p.buildPointer = string(chars);
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
        chars = bytes(BUILD_A);
        chars[20] = "A";
        p.buildPointer = string(chars);
        _rejected(p, _sig(p), Controller.InvalidArtifact.selector);
    }

    function test_duplicatePauseStateAndMaxNonceRejected() public {
        vm.expectRevert(Controller.InvalidPauseState.selector);
        vm.prank(owner);
        controller.unpause();
        vm.prank(owner);
        controller.pause();
        vm.expectRevert(Controller.InvalidPauseState.selector);
        vm.prank(owner);
        controller.pause();
        vm.expectRevert(Controller.InvalidNonce.selector);
        vm.prank(owner);
        controller.cancelNonce(type(uint256).max);
    }

    function test_dagPbBuildPointerAccepted() public {
        string memory pointer = "ipfs://bafybeiccijbeeqscijbeeqscijbeeqscijbeeqscijbeeqscijbeeqscii";
        _preview(_ch(1), pointer);
        Controller.Promote memory p = _proposal();
        p.buildPointer = pointer;
        _send(p, _sig(p));
        _eq(_text("ensure.build"), pointer);
    }

    function testFuzz_sequenceMonotonicity(uint64 proposed, uint8 moves) public {
        Controller.Promote memory p = _proposal();
        p.sequence = proposed;
        if (proposed != BASELINE + 1) {
            _rejected(p, _sig(p), Controller.InvalidSequence.selector);
            require(
                controller.lastSequence() == BASELINE && controller.transitionCount() == 0, "invalid sequence advanced"
            );
        }
        bytes32 a = _promoteA();
        uint256 steps = uint256(moves % 8) + 1;
        for (uint256 i; i < steps; ++i) {
            uint64 before_ = controller.lastSequence();
            _sendRollback(_rollback(a));
            require(controller.lastSequence() == before_ + 1, "not monotonic");
        }
        require(controller.transitionCount() == steps + 1, "transition count");
    }

    function _hex(bytes memory value) private pure returns (string memory) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory out = new bytes(value.length * 2 + 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < value.length; ++i) {
            out[2 + 2 * i] = alphabet[uint8(value[i]) >> 4];
            out[3 + 2 * i] = alphabet[uint8(value[i]) & 15];
        }
        return string(out);
    }
}

/// @dev Opt-in read-only ABI integration check. Fork state is local; nothing is broadcast.
contract ENSureReleaseControllerForkTest {
    ReleaseVm private constant vm = ReleaseVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testFork_liveENSv2ReadABI() public {
        string memory rpc = vm.envOr("ENSURE_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 11155111, "fork must be Sepolia");
        IReleaseOwnerHelper helper = IReleaseOwnerHelper(0xd453e5Bdb62CC3beA84341B1e306319C8Ffd7DFe);
        IReleaseRegistry registry = IReleaseRegistry(0x9A322BAc469a3d03185730e8eCF0035389206F8B);
        IReleaseResolver prod = IReleaseResolver(0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7);
        IReleaseResolver preview = IReleaseResolver(0x75b4dCA2604585c81ce4E24c9879E1aBF1514Bcf);
        Controller c = new Controller(helper, registry, prod, preview, 0);
        require(c.currentOwner() != address(0), "no project owner");
        abi.decode(
            preview.resolve(c.PREVIEW_DNS(), abi.encodeCall(IReleaseProfile.contenthash, (c.previewNode()))), (bytes)
        );
        abi.decode(
            preview.resolve(c.PREVIEW_DNS(), abi.encodeCall(IReleaseProfile.text, (c.previewNode(), "ensure.build"))),
            (string)
        );
        abi.decode(prod.resolve(c.PROD_DNS(), abi.encodeCall(IReleaseProfile.contenthash, (c.prodNode()))), (bytes));
        abi.decode(
            prod.resolve(c.PROD_DNS(), abi.encodeCall(IReleaseProfile.text, (c.prodNode(), "ensure.release"))), (string)
        );
    }
}
