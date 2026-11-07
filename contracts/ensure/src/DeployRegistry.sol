// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnsOwned, IUniversalHelper} from "./EnsOwned.sol";

/// @notice Public history of what was published to a name. A record, not a source of truth.
contract DeployRegistry is EnsOwned {
    struct Deploy {
        bytes cid;
        address publisher;
        uint64 timestamp;
        string env;
        string meta;
    }

    mapping(bytes32 node => mapping(address publisher => bool)) public isPublisher;
    mapping(bytes32 node => Deploy[]) private _history;

    event PublisherSet(bytes32 indexed node, address indexed publisher, bool allowed);
    event Deployed(bytes32 indexed node, uint256 indexed index, address indexed publisher, bytes cid, string env);

    error NotPublisher(bytes32 node, address caller);
    error EmptyCid();
    error InvalidEnv();

    constructor(IUniversalHelper helper_) EnsOwned(helper_) {}

    function setPublisher(bytes calldata dnsName, address publisher, bool allowed) external {
        bytes32 node = _requireOwner(dnsName);
        isPublisher[node][publisher] = allowed;
        emit PublisherSet(node, publisher, allowed);
    }

    function logDeploy(bytes32 node, bytes calldata cid, string calldata env, string calldata meta) external {
        if (!isPublisher[node][msg.sender]) revert NotPublisher(node, msg.sender);
        if (cid.length == 0) revert EmptyCid();
        bytes32 e = keccak256(bytes(env));
        if (e != keccak256("production") && e != keccak256("staging") && e != keccak256("preview")) revert InvalidEnv();
        _history[node].push(Deploy(cid, msg.sender, uint64(block.timestamp), env, meta));
        emit Deployed(node, _history[node].length - 1, msg.sender, cid, env);
    }

    function deployCount(bytes32 node) external view returns (uint256) {
        return _history[node].length;
    }

    /// @notice Newest first.
    function getDeployHistory(bytes32 node, uint256 offset, uint256 limit) external view returns (Deploy[] memory out) {
        Deploy[] storage h = _history[node];
        if (offset >= h.length) return new Deploy[](0);
        uint256 count = h.length - offset < limit ? h.length - offset : limit;
        out = new Deploy[](count);
        for (uint256 i; i < count; ++i) out[i] = h[h.length - 1 - offset - i];
    }
}
