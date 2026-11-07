// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ENSureReleaseController,
    IReleaseOwnerHelper,
    IReleaseRegistry,
    IReleaseResolver
} from "../src/ENSureReleaseController.sol";

interface ReleaseDeployVm {
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Compile-only preparation. Do not run/broadcast without a separately approved deployment.
/// @dev Uses the caller's external signer; never reads a private key. Baseline must be reviewed live.
contract DeployReleaseController {
    ReleaseDeployVm private constant vm = ReleaseDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event ControllerDeployed(address indexed controller, uint64 baselineSequence);

    function run() external returns (ENSureReleaseController controller) {
        require(block.chainid == 11155111, "Sepolia only");
        uint256 baseline = vm.envUint("CONTROLLER_BASELINE_SEQUENCE");
        require(baseline < type(uint64).max, "invalid baseline");
        vm.startBroadcast();
        controller = new ENSureReleaseController(
            IReleaseOwnerHelper(0xd453e5Bdb62CC3beA84341B1e306319C8Ffd7DFe),
            IReleaseRegistry(0x9A322BAc469a3d03185730e8eCF0035389206F8B),
            IReleaseResolver(0x114BcCDDF4B2D33f50C215f57455b0341fEE3Bb7),
            IReleaseResolver(0x75b4dCA2604585c81ce4E24c9879E1aBF1514Bcf),
            uint64(baseline)
        );
        vm.stopBroadcast();
        emit ControllerDeployed(address(controller), uint64(baseline));
    }
}
