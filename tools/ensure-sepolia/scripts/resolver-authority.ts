import { keccak256, toBytes, type Address } from 'viem';
import { S, T } from './config.js';
import { RECORD_KEYS } from './owner-promote-shared.js';
export type RoleRead = (method:'hasRootRoles'|'hasRoles',args:readonly unknown[])=>Promise<unknown>;
// Admin bits confer role-management authority; accept either write or matching admin authority.
export async function hasReleaseAuthority(read:RoleRead,signer:Address) {
 const content = await Promise.all([read('hasRootRoles',[S,signer]),read('hasRootRoles',[S<<128n,signer])]);
 const text = await Promise.all(RECORD_KEYS.map(async key=>{
  const resource=BigInt(keccak256(toBytes(key)));
  const roles=await Promise.all([read('hasRoles',[resource,T,signer]),read('hasRoles',[resource,T<<128n,signer])]);
  return roles.some(Boolean);
 }));
 return content.some(Boolean)&&text.every(Boolean);
}
