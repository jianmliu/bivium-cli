import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "./types.ts";

export const gasFaucetAbi = parseAbi([
  "function DRIP() view returns (uint256)",
  "function COOLDOWN() view returns (uint256)",
  "function GLOBAL_INTERVAL() view returns (uint256)",
  "function RICH_LIMIT() view returns (uint256)",
  "function nextClaimAt(address to) view returns (uint256)",
  "function globalNextClaimAt() view returns (uint256)",
  "function claim(address to)",
]);

/**
 * Generate a throwaway wallet and persist the key to `path` with 0600 permissions.
 * Refuses to overwrite an existing file — a key file is never silently replaced.
 */
export function createWalletFile(path: string): { address: Address } {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing key file ${path}`);
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  writeFileSync(path, key + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return { address: account.address as Address };
}

/** Load a key file, enforcing owner-only permissions (mirrors the vaultbtc-borrower discipline). */
export function readKeyFile(path: string): Hex {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`key file ${path} must be mode 0600 (found ${mode.toString(8)})`);
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${path} does not contain a 32-byte hex key`);
  return raw as Hex;
}
