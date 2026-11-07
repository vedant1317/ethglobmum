import {test} from 'vitest';
import assert from 'node:assert/strict';
import {hashTypedData,keccak256,toBytes} from 'viem';
import {domain,types} from '../scripts/ensure-manifest.js';
test('Solidity and viem EIP-712 digest interoperability vector',()=>{
 const coreHash=keccak256(toBytes('JCS canonical core fixture'));
 assert.equal(hashTypedData({domain:domain(11155111),types,primaryType:'ReleaseApproval',message:{coreHash}}),'0x2a76b70734b088366bd8dd7d71a4330d1ee8b0c7afd849dc7a513b46e056e8f2');
});
