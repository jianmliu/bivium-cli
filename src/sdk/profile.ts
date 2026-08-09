import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import type { Address, DeploymentProfile, TbvSection, TokenInfo } from "./types.ts";

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`profile ${label} missing`);
  return getAddress(value) as Address;
}

/** Load + validate a deployment profile. Unknown abiProfile values are rejected (fail closed). */
export function loadProfile(path: string): DeploymentProfile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw.abiProfile !== "core-v1" && raw.abiProfile !== "core-v2") {
    throw new Error(`unsupported abiProfile ${JSON.stringify(raw.abiProfile)} — supported: "core-v1", "core-v2"`);
  }
  if (typeof raw.name !== "string" || !raw.name) throw new Error("profile name missing");
  if (typeof raw.chainId !== "number" || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new Error("profile chainId must be a positive integer");
  }
  if (typeof raw.rpcUrl !== "string" || !/^https?:\/\//.test(raw.rpcUrl)) throw new Error("profile rpcUrl must be http(s)");
  const tokens: Record<string, TokenInfo> = {};
  if (raw.tokens !== undefined) {
    if (typeof raw.tokens !== "object" || raw.tokens === null) throw new Error("profile tokens must be an object");
    for (const [symbol, info] of Object.entries(raw.tokens as Record<string, Record<string, unknown>>)) {
      if (typeof info.decimals !== "number" || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 36) {
        throw new Error(`token ${symbol} decimals invalid`);
      }
      tokens[symbol] = {
        address: requireAddress(info.address, `tokens.${symbol}.address`),
        decimals: info.decimals,
        mintable: info.mintable === true,
      };
    }
  }
  let tbv: TbvSection | undefined;
  if (raw.tbv !== undefined) {
    if (typeof raw.tbv !== "object" || raw.tbv === null) throw new Error("profile tbv must be an object");
    const t = raw.tbv as Record<string, unknown>;
    tbv = {
      factory: requireAddress(t.factory, "tbv.factory"),
      manager: requireAddress(t.manager, "tbv.manager"),
      receipt: requireAddress(t.receipt, "tbv.receipt"),
      vaultToken: requireAddress(t.vaultToken, "tbv.vaultToken"),
      keeper: requireAddress(t.keeper, "tbv.keeper"),
      redemption: requireAddress(t.redemption, "tbv.redemption"),
      redemptionAsset: requireAddress(t.redemptionAsset, "tbv.redemptionAsset"),
    };
  }
  return {
    name: raw.name,
    abiProfile: raw.abiProfile,
    chainId: raw.chainId,
    core: requireAddress(raw.core, "core"),
    signatureRatifier: requireAddress(raw.signatureRatifier, "signatureRatifier"),
    rpcUrl: raw.rpcUrl,
    tokens,
    tbv,
  };
}

/** Resolve a --token flag value (profile symbol or raw address) to {address, decimals?}. */
export function resolveToken(
  profile: DeploymentProfile,
  value: string,
): { address: Address; info?: TokenInfo; symbol?: string } {
  const bySymbol = profile.tokens?.[value];
  if (bySymbol) return { address: bySymbol.address, info: bySymbol, symbol: value };
  const address = getAddress(value) as Address;
  const entry = Object.entries(profile.tokens ?? {}).find(([, t]) => t.address === address);
  return entry ? { address, info: entry[1], symbol: entry[0] } : { address };
}
