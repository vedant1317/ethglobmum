// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniversalHelper {
    function findExactOwner(bytes calldata name) external view returns (address);
}

/// @notice Authority comes from who owns the ENSv2 name, not from a free-form string.
abstract contract EnsOwned {
    error NotNameOwner(bytes32 node, address caller);

    IUniversalHelper public immutable helper;

    constructor(IUniversalHelper helper_) {
        helper = helper_;
    }

    /// @return node The namehash of the DNS-encoded name, once the caller is proven to own it.
    function _requireOwner(bytes calldata dnsName) internal view returns (bytes32 node) {
        node = namehash(dnsName, 0);
        if (helper.findExactOwner(dnsName) != msg.sender) revert NotNameOwner(node, msg.sender);
    }

    function namehash(bytes calldata name, uint256 i) public pure returns (bytes32) {
        uint256 len = uint8(name[i]);
        if (len == 0) return bytes32(0);
        return keccak256(abi.encodePacked(namehash(name, i + 1 + len), keccak256(name[i + 1:i + 1 + len])));
    }
}
