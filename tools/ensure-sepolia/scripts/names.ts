import { bytesToHex, type Hex } from 'viem';
import { normalize } from 'viem/ens';
export function dnsEncode(input: string): Hex {
  const name = normalize(input); const parts: number[] = [];
  for (const label of name.split('.')) {
    const b = new TextEncoder().encode(label);
    if (b.length === 0 || b.length > 63) throw new Error('MVP DNS label must be 1..63 UTF-8 bytes');
    parts.push(b.length, ...b);
  }
  parts.push(0); if (parts.length > 255) throw new Error('MVP DNS name exceeds 255 bytes');
  return bytesToHex(new Uint8Array(parts));
}
