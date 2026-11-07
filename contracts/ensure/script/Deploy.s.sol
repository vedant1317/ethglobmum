// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessController} from "../src/AccessController.sol";
import {DeployRegistry} from "../src/DeployRegistry.sol";
import {IUniversalHelper} from "../src/EnsOwned.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// forge script script/Deploy.s.sol --rpc-url "$SEPOLIA_RPC_URL" --broadcast --verify --account deployer
contract Deploy {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IUniversalHelper private constant HELPER = IUniversalHelper(0xd453e5Bdb62CC3beA84341B1e306319C8Ffd7DFe);

    event Deployed(address deployRegistry, address accessController);

    function run() external {
        vm.startBroadcast();
        DeployRegistry registry = new DeployRegistry(HELPER);
        AccessController access = new AccessController(HELPER);
        vm.stopBroadcast();
        emit Deployed(address(registry), address(access));
    }
}
