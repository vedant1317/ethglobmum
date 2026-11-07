// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessController, IBalance} from "../src/AccessController.sol";
import {DeployRegistry} from "../src/DeployRegistry.sol";
import {EnsOwned, IUniversalHelper} from "../src/EnsOwned.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract MockHelper is IUniversalHelper {
    address public owner;

    function setOwner(address o) external {
        owner = o;
    }

    function findExactOwner(bytes calldata) external view returns (address) {
        return owner;
    }
}

contract MockToken is IBalance {
    mapping(address => uint256) public balanceOf;

    function set(address a, uint256 v) external {
        balanceOf[a] = v;
    }
}

contract BaseTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER = address(0xA);
    address private constant PUBLISHER = address(0xB);
    address private constant STRANGER = address(0xC);
    // "preview.lifeboat.eth" DNS-encoded
    bytes private constant NAME = hex"0770726576696577086c696665626f617403657468" hex"00";

    MockHelper private helper;
    DeployRegistry private registry;
    AccessController private access;
    MockToken private token;
    bytes32 private node;

    function setUp() public {
        helper = new MockHelper();
        helper.setOwner(OWNER);
        registry = new DeployRegistry(helper);
        access = new AccessController(helper);
        token = new MockToken();
        node = registry.namehash(NAME, 0);
    }

    function _eq(bool a, bool b) private pure {
        require(a == b, "unexpected bool");
    }

    function test_namehash_matches_known_value() public view {
        // namehash("eth")
        bytes memory eth = hex"03657468" hex"00";
        require(
            this.hash(eth) == 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae,
            "namehash(eth) is wrong"
        );
    }

    function hash(bytes calldata n) external view returns (bytes32) {
        return registry.namehash(n, 0);
    }

    function test_only_name_owner_sets_publisher() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(EnsOwned.NotNameOwner.selector, node, STRANGER));
        registry.setPublisher(NAME, PUBLISHER, true);
    }

    function test_unknown_publisher_cannot_log() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(abi.encodeWithSelector(DeployRegistry.NotPublisher.selector, node, PUBLISHER));
        registry.logDeploy(node, "cid", "preview", "");
    }

    function test_log_and_history_newest_first() public {
        vm.prank(OWNER);
        registry.setPublisher(NAME, PUBLISHER, true);
        vm.prank(PUBLISHER);
        registry.logDeploy(node, "one", "preview", "");
        vm.prank(PUBLISHER);
        registry.logDeploy(node, "two", "preview", "");
        require(registry.deployCount(node) == 2, "count");
        DeployRegistry.Deploy[] memory h = registry.getDeployHistory(node, 0, 10);
        require(h.length == 2 && keccak256(h[0].cid) == keccak256("two"), "newest first");
        require(registry.getDeployHistory(node, 1, 10).length == 1, "offset");
        require(registry.getDeployHistory(node, 5, 10).length == 0, "past end");
    }

    function test_rejects_bad_env_and_empty_cid() public {
        vm.prank(OWNER);
        registry.setPublisher(NAME, PUBLISHER, true);
        vm.prank(PUBLISHER);
        vm.expectRevert(DeployRegistry.InvalidEnv.selector);
        registry.logDeploy(node, "cid", "nope", "");
        vm.prank(PUBLISHER);
        vm.expectRevert(DeployRegistry.EmptyCid.selector);
        registry.logDeploy(node, "", "preview", "");
    }

    function test_revoked_publisher_cannot_log() public {
        vm.prank(OWNER);
        registry.setPublisher(NAME, PUBLISHER, true);
        vm.prank(OWNER);
        registry.setPublisher(NAME, PUBLISHER, false);
        vm.prank(PUBLISHER);
        vm.expectRevert(abi.encodeWithSelector(DeployRegistry.NotPublisher.selector, node, PUBLISHER));
        registry.logDeploy(node, "cid", "preview", "");
    }

    function test_public_by_default() public view {
        _eq(access.checkAccess(node, STRANGER), true);
    }

    function test_only_owner_sets_policy() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(EnsOwned.NotNameOwner.selector, node, STRANGER));
        access.setPolicy(NAME, AccessController.Policy.ALLOWLIST, AccessController.Standard.ERC20, address(0), 0, 0);
    }

    function test_allowlist() public {
        vm.prank(OWNER);
        access.setPolicy(NAME, AccessController.Policy.ALLOWLIST, AccessController.Standard.ERC20, address(0), 0, 0);
        _eq(access.checkAccess(node, PUBLISHER), false);
        vm.prank(OWNER);
        access.setAllowlisted(NAME, PUBLISHER, true);
        _eq(access.checkAccess(node, PUBLISHER), true);
    }

    function test_token_gate_and_dao() public {
        vm.prank(OWNER);
        access.setPolicy(NAME, AccessController.Policy.TOKEN_GATED, AccessController.Standard.ERC20, address(token), 5, 0);
        token.set(PUBLISHER, 4);
        _eq(access.checkAccess(node, PUBLISHER), false);
        token.set(PUBLISHER, 5);
        _eq(access.checkAccess(node, PUBLISHER), true);
        vm.prank(OWNER);
        access.setPolicy(NAME, AccessController.Policy.DAO, AccessController.Standard.ERC1155, address(token), 9, 0);
        _eq(access.checkAccess(node, PUBLISHER), true); // DAO forces ERC-721 and a minimum of 1
    }

    function test_token_policy_needs_token() public {
        vm.prank(OWNER);
        vm.expectRevert(AccessController.InvalidToken.selector);
        access.setPolicy(NAME, AccessController.Policy.TOKEN_GATED, AccessController.Standard.ERC20, address(0), 1, 0);
    }

    function test_pause_and_resume() public {
        vm.prank(OWNER);
        access.setPolicy(NAME, AccessController.Policy.ALLOWLIST, AccessController.Standard.ERC20, address(0), 0, 0);
        vm.prank(OWNER);
        access.setAllowlisted(NAME, PUBLISHER, true);
        vm.prank(OWNER);
        access.pause(NAME);
        _eq(access.checkAccess(node, PUBLISHER), false);
        vm.prank(OWNER);
        access.unpause(NAME);
        _eq(access.checkAccess(node, PUBLISHER), true);
    }
}
