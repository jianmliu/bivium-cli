import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import type { Address, DeploymentProfile, TokenInfo, VaultAppSection } from "./types.ts";

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
  if (raw.relayerUrl !== undefined && (typeof raw.relayerUrl !== "string" || !/^https?:\/\//.test(raw.relayerUrl))) {
    throw new Error("profile relayerUrl must be an http(s) URL");
  }
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
  if (raw.tbv !== undefined) {
    throw new Error("profile.tbv is the retired core-tbv canary; use profile.vaultApp");
  }
  let vaultApp: VaultAppSection | undefined;
  if (raw.vaultApp !== undefined) {
    if (typeof raw.vaultApp !== "object" || raw.vaultApp === null) throw new Error("profile vaultApp must be an object");
    const v = raw.vaultApp as Record<string, unknown>;
    if (typeof v.appBlock !== "number" || !Number.isInteger(v.appBlock) || v.appBlock < 0) {
      throw new Error("profile vaultApp.appBlock must be a non-negative integer");
    }
    vaultApp = {
      registry: requireAddress(v.registry, "vaultApp.registry"),
      app: requireAddress(v.app, "vaultApp.app"),
      vaultBtc: requireAddress(v.vaultBtc, "vaultApp.vaultBtc"),
      escrow: requireAddress(v.escrow, "vaultApp.escrow"),
      tbvbtc: requireAddress(v.tbvbtc, "vaultApp.tbvbtc"),
      appBlock: v.appBlock,
    };
  }
  const gasFaucet = raw.gasFaucet === undefined ? undefined : requireAddress(raw.gasFaucet, "gasFaucet");
  if (raw.gasApi !== undefined && (typeof raw.gasApi !== "string" || !/^https?:\/\//.test(raw.gasApi))) {
    throw new Error("profile gasApi must be an http(s) URL");
  }
  if (raw.maturitySettler !== undefined && (typeof raw.maturitySettler !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.maturitySettler))) {
    throw new Error("profile maturitySettler must be an address");
  }
  if (raw.coreDeploymentBlock !== undefined && (typeof raw.coreDeploymentBlock !== "number" || !Number.isInteger(raw.coreDeploymentBlock) || raw.coreDeploymentBlock < 0)) {
    throw new Error("profile coreDeploymentBlock must be a non-negative integer");
  }
  return {
    name: raw.name,
    abiProfile: raw.abiProfile,
    chainId: raw.chainId,
    core: requireAddress(raw.core, "core"),
    signatureRatifier: requireAddress(raw.signatureRatifier, "signatureRatifier"),
    rpcUrl: raw.rpcUrl,
    relayerUrl: raw.relayerUrl as string | undefined,
    tokens,
    vaultApp,
    gasFaucet,
    gasApi: raw.gasApi as string | undefined,
    maturitySettler: raw.maturitySettler as Address | undefined,
    coreDeploymentBlock: raw.coreDeploymentBlock as number | undefined,
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
