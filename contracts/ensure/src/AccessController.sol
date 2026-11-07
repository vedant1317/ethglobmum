// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnsOwned, IUniversalHelper} from "./EnsOwned.sol";

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
}

interface IBalance1155 {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @notice Per-name access policy. Gates a site's interface only: files on IPFS stay public.
contract AccessController is EnsOwned {
    enum Policy {
        PUBLIC,
        TOKEN_GATED,
        ALLOWLIST,
        DAO,
        PAUSED
    }
    enum Standard {
        ERC20,
        ERC721,
        ERC1155
    }

    struct Config {
        Policy policy;
        Policy resumeTo;
        Standard standard;
        address token;
        uint256 minBalance;
        uint256 tokenId;
    }

    mapping(bytes32 node => Config) public configOf;
    mapping(bytes32 node => mapping(address account => bool)) public isAllowlisted;

    event PolicySet(bytes32 indexed node, Policy policy);
    event AllowlistSet(bytes32 indexed node, address indexed account, bool allowed);

    error InvalidToken();
    error InvalidPolicy();

    constructor(IUniversalHelper helper_) EnsOwned(helper_) {}

    function setPolicy(
        bytes calldata dnsName,
        Policy policy,
        Standard standard,
        address token,
        uint256 minBalance,
        uint256 tokenId
    ) external {
        bytes32 node = _requireOwner(dnsName);
        if (policy == Policy.PAUSED) revert InvalidPolicy();
        if ((policy == Policy.TOKEN_GATED || policy == Policy.DAO) && token == address(0)) revert InvalidToken();
        if (policy == Policy.DAO) {
            standard = Standard.ERC721;
            minBalance = 1;
        }
        configOf[node] = Config(policy, policy, standard, token, minBalance, tokenId);
        emit PolicySet(node, policy);
    }

    function setAllowlisted(bytes calldata dnsName, address account, bool allowed) external {
        bytes32 node = _requireOwner(dnsName);
        isAllowlisted[node][account] = allowed;
        emit AllowlistSet(node, account, allowed);
    }

    function pause(bytes calldata dnsName) external {
        bytes32 node = _requireOwner(dnsName);
        configOf[node].policy = Policy.PAUSED;
        emit PolicySet(node, Policy.PAUSED);
    }

    function unpause(bytes calldata dnsName) external {
        bytes32 node = _requireOwner(dnsName);
        configOf[node].policy = configOf[node].resumeTo;
        emit PolicySet(node, configOf[node].policy);
    }

    function checkAccess(bytes32 node, address account) external view returns (bool) {
        Config storage c = configOf[node];
        if (c.policy == Policy.PUBLIC) return true;
        if (c.policy == Policy.PAUSED) return false;
        if (c.policy == Policy.ALLOWLIST) return isAllowlisted[node][account];
        if (c.standard == Standard.ERC1155) return IBalance1155(c.token).balanceOf(account, c.tokenId) >= c.minBalance;
        return IBalance(c.token).balanceOf(account) >= c.minBalance;
    }
}
