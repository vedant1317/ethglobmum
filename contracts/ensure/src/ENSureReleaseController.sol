// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReleaseRegistry {
    function getResolver(string calldata label) external view returns (address);
}

interface IReleaseOwnerHelper {
    function findExactOwner(bytes calldata name) external view returns (address);
    function findExactRegistry(bytes calldata name) external view returns (address);
}

interface IReleaseResolver {
    function setContenthash(bytes calldata name, bytes calldata hash) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function multicall(bytes[] calldata calls) external returns (bytes[] memory);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface IReleaseProfile {
    function contenthash(bytes32 node) external view returns (bytes memory);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @notice Owner-signed, preview-bound releases for prod.ensure.eth on Sepolia.
/// @dev Unaudited v2 protocol; see docs/RELEASE_CONTROLLER.md. The live project owner
///      must sign AND submit. There is no publisher, recovery-key or arbitrary-call path.
contract ENSureReleaseController {
    uint256 public constant SEPOLIA_CHAIN_ID = 11155111;
    bytes public constant PROJECT_DNS = hex"06656e737572650365746800";
    bytes public constant PROD_DNS = hex"0470726f6406656e737572650365746800";
    bytes public constant PREVIEW_DNS = hex"077072657669657706656e737572650365746800";
    string public constant KEY_RELEASE = "ensure.release";
    string public constant KEY_MANIFEST = "ensure.manifest";
    string public constant KEY_APPROVAL = "ensure.approval";
    string public constant KEY_BUILD = "ensure.build";
    bytes32 public constant PROMOTE_TYPEHASH = keccak256(
        "Promote(bytes32 contenthashHash,string buildPointer,bytes32 manifestDigest,bytes32 commitDigest,uint64 sequence,bytes32 expectedCurrentReleaseId,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant ROLLBACK_TYPEHASH = keccak256(
        "Rollback(bytes32 targetReleaseId,uint64 sequence,bytes32 expectedCurrentReleaseId,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Promote {
        bytes32 contenthashHash;
        string buildPointer;
        bytes32 manifestDigest;
        bytes32 commitDigest;
        uint64 sequence;
        bytes32 expectedCurrentReleaseId;
        uint256 nonce;
        uint256 deadline;
    }

    struct Rollback {
        bytes32 targetReleaseId;
        uint64 sequence;
        bytes32 expectedCurrentReleaseId;
        uint256 nonce;
        uint256 deadline;
    }

    struct Release {
        bool exists;
        bytes contenthash;
        string buildPointer;
        bytes32 manifestDigest;
        bytes32 commitDigest;
        address approver;
        uint64 approvedAt;
        uint64 firstSequence;
    }

    struct Transition {
        uint64 sequence;
        bytes32 fromReleaseId;
        bytes32 toReleaseId;
        address authorizer;
        uint64 timestamp;
        bool isRollback;
        bytes32 actionDigest;
        bytes proof;
    }

    IReleaseOwnerHelper public immutable helper;
    IReleaseRegistry public immutable productionRegistry;
    IReleaseResolver public immutable productionResolver;
    IReleaseResolver public immutable previewResolver;
    bytes32 public immutable projectNode;
    bytes32 public immutable prodNode;
    bytes32 public immutable previewNode;
    uint64 public immutable baselineSequence;
    uint64 public lastSequence;
    bytes32 public currentReleaseId;
    bool public paused;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => Release) private _releases;
    Transition[] private _transitions;
    uint256 private _entered = 1;

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
    error WrongChain();
    error InvalidConfig();
    error NotOwner();
    error InvalidOwnerContext();
    error InvalidSignature();
    error InvalidNonce();
    error ApprovalExpired();
    error InvalidSequence();
    error CurrentReleaseMismatch();
    error ResolverMismatch();
    error PreviewContenthashMismatch();
    error PreviewBuildMismatch();
    error InvalidArtifact();
    error ReleaseExists();
    error UnknownRelease();
    error PromotionsPaused();
    error InvalidPauseState();
    error WriteVerificationFailed();
    error Reentrancy();

    modifier guarded() {
        if (block.chainid != SEPOLIA_CHAIN_ID) revert WrongChain();
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(
        IReleaseOwnerHelper helper_,
        IReleaseRegistry registry_,
        IReleaseResolver prod_,
        IReleaseResolver preview_,
        uint64 baselineSequence_
    ) {
        if (block.chainid != SEPOLIA_CHAIN_ID) revert WrongChain();
        if (
            address(helper_).code.length == 0 || address(registry_).code.length == 0 || address(prod_).code.length == 0
                || address(preview_).code.length == 0 || address(prod_) == address(preview_)
                || baselineSequence_ == type(uint64).max
        ) revert InvalidConfig();
        helper = helper_;
        productionRegistry = registry_;
        productionResolver = prod_;
        previewResolver = preview_;
        projectNode = _namehash(PROJECT_DNS, 0);
        prodNode = _namehash(PROD_DNS, 0);
        previewNode = _namehash(PREVIEW_DNS, 0);
        baselineSequence = baselineSequence_;
        lastSequence = baselineSequence_;
        currentOwner();
        _checkProdRouting();
        _checkPreviewRouting();
    }

    /// @dev The official helper reads current ENS ownership, not a cached owner/token ID.
    function currentOwner() public view returns (address owner) {
        owner = helper.findExactOwner(PROJECT_DNS);
        if (owner == address(0) || helper.findExactRegistry(PROJECT_DNS) != address(productionRegistry)) {
            revert InvalidOwnerContext();
        }
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("ENSureReleaseController"), keccak256("2"), block.chainid, address(this)
            )
        );
    }

    function hashPromote(Promote calldata p) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    PROMOTE_TYPEHASH,
                    p.contenthashHash,
                    keccak256(bytes(p.buildPointer)),
                    p.manifestDigest,
                    p.commitDigest,
                    p.sequence,
                    p.expectedCurrentReleaseId,
                    p.nonce,
                    p.deadline
                )
            )
        );
    }

    function hashRollback(Rollback calldata r) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    ROLLBACK_TYPEHASH, r.targetReleaseId, r.sequence, r.expectedCurrentReleaseId, r.nonce, r.deadline
                )
            )
        );
    }

    function promote(bytes calldata contenthashBytes, Promote calldata p, bytes calldata signature)
        external
        guarded
        returns (bytes32 releaseId)
    {
        address owner = _requireOwner();
        if (paused) revert PromotionsPaused();
        _checkAction(owner, p.sequence, p.expectedCurrentReleaseId, p.nonce, p.deadline);
        bytes32 digest = hashPromote(p);
        _checkSignature(owner, digest, signature);
        _validateArtifact(contenthashBytes, p);
        _checkProdRouting();
        _checkPreviewRouting();
        if (keccak256(_readContenthash(previewResolver, PREVIEW_DNS, previewNode)) != p.contenthashHash) {
            revert PreviewContenthashMismatch();
        }
        if (!_equal(_readText(previewResolver, PREVIEW_DNS, previewNode, KEY_BUILD), p.buildPointer)) {
            revert PreviewBuildMismatch();
        }
        releaseId = keccak256(
            abi.encode(
                projectNode, p.contenthashHash, keccak256(bytes(p.buildPointer)), p.manifestDigest, p.commitDigest
            )
        );
        if (_releases[releaseId].exists) revert ReleaseExists();
        _releases[releaseId] = Release(
            true,
            contenthashBytes,
            p.buildPointer,
            p.manifestDigest,
            p.commitDigest,
            owner,
            uint64(block.timestamp),
            p.sequence
        );
        bytes memory proof = abi.encode(uint8(2), uint8(1), domainSeparator(), p, signature);
        bytes32 previous = currentReleaseId;
        _record(releaseId, owner, p.sequence, digest, false, proof);
        _apply(releaseId, p.sequence, proof);
        emit ReleasePromoted(releaseId, previous, owner, p.sequence, digest);
    }

    function rollback(Rollback calldata r, bytes calldata signature) external guarded {
        address owner = _requireOwner();
        _checkAction(owner, r.sequence, r.expectedCurrentReleaseId, r.nonce, r.deadline);
        bytes32 digest = hashRollback(r);
        _checkSignature(owner, digest, signature);
        if (!_releases[r.targetReleaseId].exists) revert UnknownRelease();
        _checkProdRouting();
        bytes memory proof = abi.encode(uint8(2), uint8(2), domainSeparator(), r, signature);
        bytes32 previous = currentReleaseId;
        _record(r.targetReleaseId, owner, r.sequence, digest, true, proof);
        _apply(r.targetReleaseId, r.sequence, proof);
        emit ReleaseRolledBack(r.targetReleaseId, previous, owner, r.sequence, digest);
    }

    function pause() external guarded {
        address owner = _requireOwner();
        if (paused) revert InvalidPauseState();
        paused = true;
        emit Paused(owner);
    }

    function unpause() external guarded {
        address owner = _requireOwner();
        if (!paused) revert InvalidPauseState();
        paused = false;
        emit Unpaused(owner);
    }

    /// @notice Invalidates every signed action below newNonce for the current owner.
    function cancelNonce(uint256 newNonce) external guarded {
        address owner = _requireOwner();
        uint256 old = nonces[owner];
        if (newNonce <= old || newNonce == type(uint256).max) revert InvalidNonce();
        nonces[owner] = newNonce;
        emit NonceCancelled(owner, old, newNonce);
    }

    function getRelease(bytes32 releaseId) external view returns (Release memory) {
        return _releases[releaseId];
    }

    function transitionCount() external view returns (uint256) {
        return _transitions.length;
    }

    function getTransition(uint256 index) external view returns (Transition memory) {
        return _transitions[index];
    }

    function _requireOwner() private view returns (address owner) {
        owner = currentOwner();
        if (msg.sender != owner) revert NotOwner();
    }

    function _checkAction(address owner, uint64 sequence, bytes32 expected, uint256 nonce, uint256 deadline)
        private
        view
    {
        if (nonce != nonces[owner]) revert InvalidNonce();
        if (block.timestamp > deadline) revert ApprovalExpired();
        if (lastSequence == type(uint64).max || sequence != lastSequence + 1) revert InvalidSequence();
        if (expected != currentReleaseId) revert CurrentReleaseMismatch();
    }

    function _checkSignature(address owner, bytes32 digest, bytes calldata signature) private pure {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert InvalidSignature();
    }

    function _validateArtifact(bytes calldata ch, Promote calldata p) private pure {
        // CIDv1 raw or dag-pb, SHA2-256. No paths/IPNS/alternate encodings.
        if (
            ch.length != 38 || ch[0] != 0xe3 || ch[1] != 0x01 || ch[2] != 0x01 || (ch[3] != 0x55 && ch[3] != 0x70)
                || ch[4] != 0x12 || ch[5] != 0x20 || keccak256(ch) != p.contenthashHash
                || p.manifestDigest == bytes32(0) || p.commitDigest == bytes32(0)
        ) revert InvalidArtifact();
        // Raw or dag-pb CIDv1 SHA2-256, lower-case base32, with canonical padding.
        bytes memory ptr = bytes(p.buildPointer);
        bytes memory prefix = hex"697066733a2f2f6261666b726569";
        bytes memory dagPbPrefix = bytes("ipfs://bafybei");
        if (ptr.length != 66) revert InvalidArtifact();
        bool rawHeader = true;
        bool dagPbHeader = true;
        for (uint256 i; i < prefix.length; ++i) {
            if (ptr[i] != prefix[i]) rawHeader = false;
            if (ptr[i] != dagPbPrefix[i]) dagPbHeader = false;
        }
        if (!rawHeader && !dagPbHeader) revert InvalidArtifact();
        bytes memory alphabet = bytes("abcdefghijklmnopqrstuvwxyz234567");
        for (uint256 i = prefix.length; i < ptr.length; ++i) {
            bool valid = false;
            for (uint256 j; j < 32; ++j) {
                if (ptr[i] == alphabet[j]) {
                    valid = true;
                    if ((i == prefix.length && j >= 8) || (i == ptr.length - 1 && j % 4 != 0)) {
                        revert InvalidArtifact();
                    }
                    break;
                }
            }
            if (!valid) revert InvalidArtifact();
        }
    }

    function _record(bytes32 id, address owner, uint64 sequence, bytes32 digest, bool isRollback, bytes memory proof)
        private
    {
        _transitions.push(
            Transition(sequence, currentReleaseId, id, owner, uint64(block.timestamp), isRollback, digest, proof)
        );
        currentReleaseId = id;
        lastSequence = sequence;
        nonces[owner]++;
    }

    function _apply(bytes32 id, uint64 sequence, bytes memory proof) private {
        Release storage r = _releases[id];
        string memory releaseText = _decimal(sequence);
        string memory proofText = _hex(proof);
        bytes[] memory calls = new bytes[](5);
        calls[0] = abi.encodeCall(IReleaseResolver.setContenthash, (PROD_DNS, r.contenthash));
        calls[1] = abi.encodeCall(IReleaseResolver.setText, (PROD_DNS, KEY_RELEASE, releaseText));
        calls[2] = abi.encodeCall(IReleaseResolver.setText, (PROD_DNS, KEY_MANIFEST, r.buildPointer));
        calls[3] = abi.encodeCall(IReleaseResolver.setText, (PROD_DNS, KEY_APPROVAL, proofText));
        calls[4] = abi.encodeCall(IReleaseResolver.setText, (PROD_DNS, KEY_BUILD, r.buildPointer));
        productionResolver.multicall(calls);
        if (
            keccak256(_readContenthash(productionResolver, PROD_DNS, prodNode)) != keccak256(r.contenthash)
                || !_equal(_readText(productionResolver, PROD_DNS, prodNode, KEY_RELEASE), releaseText)
                || !_equal(_readText(productionResolver, PROD_DNS, prodNode, KEY_MANIFEST), r.buildPointer)
                || !_equal(_readText(productionResolver, PROD_DNS, prodNode, KEY_APPROVAL), proofText)
                || !_equal(_readText(productionResolver, PROD_DNS, prodNode, KEY_BUILD), r.buildPointer)
        ) {
            revert WriteVerificationFailed();
        }
    }

    function _checkProdRouting() private view {
        if (productionRegistry.getResolver("prod") != address(productionResolver)) revert ResolverMismatch();
    }

    function _checkPreviewRouting() private view {
        if (productionRegistry.getResolver("preview") != address(previewResolver)) revert ResolverMismatch();
    }

    function _readContenthash(IReleaseResolver resolver, bytes memory dns, bytes32 node)
        private
        view
        returns (bytes memory)
    {
        return abi.decode(resolver.resolve(dns, abi.encodeCall(IReleaseProfile.contenthash, (node))), (bytes));
    }

    function _readText(IReleaseResolver resolver, bytes memory dns, bytes32 node, string memory key)
        private
        view
        returns (string memory)
    {
        return abi.decode(resolver.resolve(dns, abi.encodeCall(IReleaseProfile.text, (node, key))), (string));
    }

    function _typed(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _equal(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _decimal(uint64 n) private pure returns (string memory) {
        if (n == 0) return "0";
        uint64 v = n;
        uint256 length = 0;
        while (v != 0) {
            length++;
            v /= 10;
        }
        bytes memory out = new bytes(length);
        while (n != 0) {
            out[--length] = bytes1(uint8(48 + n % 10));
            n /= 10;
        }
        return string(out);
    }

    function _hex(bytes memory value) private pure returns (string memory) {
        bytes memory out = new bytes(2 + value.length * 2);
        out[0] = "0";
        out[1] = "x";
        bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < value.length; ++i) {
            out[2 + i * 2] = digits[uint8(value[i]) >> 4];
            out[3 + i * 2] = digits[uint8(value[i]) & 15];
        }
        return string(out);
    }

    function _namehash(bytes memory name, uint256 offset) private pure returns (bytes32) {
        uint256 len = uint8(name[offset]);
        if (len == 0) return bytes32(0);
        bytes memory label = new bytes(len);
        for (uint256 i; i < len; ++i) {
            label[i] = name[offset + 1 + i];
        }
        return keccak256(abi.encodePacked(_namehash(name, offset + len + 1), keccak256(label)));
    }
}
