// Market discovery — find EXISTING markets before creating new ones. Bivium markets are lazy
// (the first fund/fill creates them), so nothing on-chain enumerates them except the
// MarketTouched event stream; discovering and joining an existing market is what keeps liquidity
// from fragmenting across near-identical parameter sets.
import { getAddress, parseAbi } from "viem";
import { adapterFor, type ChainDomain } from "./lineage.ts";
import type { BiviumClient } from "./client.ts";
import type { Address, DeploymentProfile, Hex, MarketParams } from "./types.ts";

const touchedEventV1 = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; }",
  "event MarketTouched(bytes32 indexed id, MarketParams params)",
]);
const touchedEventV2 = parseAbi([
  "struct MarketParams { uint256 chainId; address bivium; address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; }",
  "event MarketTouched(bytes32 indexed id, MarketParams params)",
]);

export interface DiscoveredMarket {
  id: Hex;
  params: MarketParams;
  firstSeenBlock: bigint;
}

/**
 * Recompute the market id from decoded event params and require it to equal the indexed id.
 * A mismatch means the event was decoded with the wrong lineage (the exact failure the live
 * relayer index exhibited against a v1 core) — fail loudly, never return a half-trusted row.
 */
export function verifyTouchedMarket(
  abiProfile: DeploymentProfile["abiProfile"],
  domain: ChainDomain,
  id: Hex,
  params: MarketParams,
): void {
  const computed = adapterFor(abiProfile).computeMarketId(domain, params);
  if (computed.toLowerCase() !== id.toLowerCase()) {
    throw new Error(
      `MarketTouched id mismatch: event ${id} vs recomputed ${computed} — lineage mismatch between profile and core`,
    );
  }
}

/** Chunked MarketTouched scan straight from the chain — lineage-correct by construction. */
export async function discoverMarketsOnChain(
  client: BiviumClient,
  options: { fromBlock: bigint; chunkSize?: bigint },
): Promise<DiscoveredMarket[]> {
  await client.verifyProfile();
  const profile = client.profile;
  const eventAbi = profile.abiProfile === "core-v1" ? touchedEventV1 : touchedEventV2;
  const event = eventAbi.find((item) => item.type === "event");
  const chunk = options.chunkSize ?? 900n;
  const latest = await client.pub.getBlockNumber();
  const markets = new Map<string, DiscoveredMarket>();
  for (let from = options.fromBlock; from <= latest; from += chunk) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    const logs = await client.pub.getLogs({ address: profile.core, event: event as never, fromBlock: from, toBlock: to });
    for (const raw of logs as ReadonlyArray<unknown>) {
      const log = raw as { args: { id: Hex; params: Record<string, unknown> }; blockNumber: bigint | null };
      const args = log.args;
      const p = args.params;
      const params: MarketParams = {
        loanToken: getAddress(p.loanToken as string) as Address,
        collateralToken: getAddress(p.collateralToken as string) as Address,
        maturity: BigInt(p.maturity as bigint),
        strike: BigInt(p.strike as bigint),
        allowPartialRepay: Boolean(p.allowPartialRepay),
        gate: getAddress(p.gate as string) as Address,
      };
      if (profile.abiProfile === "core-v2") {
        // The domain fields ride inside the event params on v2 — they must match the profile.
        if (BigInt(p.chainId as bigint) !== BigInt(profile.chainId) || getAddress(p.bivium as string) !== profile.core) {
          throw new Error("MarketTouched event carries a foreign chain/core domain");
        }
      }
      verifyTouchedMarket(profile.abiProfile, { chainId: profile.chainId, core: profile.core }, args.id, params);
      if (!markets.has(args.id.toLowerCase())) {
        markets.set(args.id.toLowerCase(), { id: args.id, params, firstSeenBlock: log.blockNumber ?? from });
      }
    }
  }
  return [...markets.values()].sort((a, b) => (a.params.maturity < b.params.maturity ? -1 : 1));
}

export interface RelayerMarketsResult {
  ok: boolean;
  reason?: string;
  markets: DiscoveredMarket[];
  /** True when the index claims full healthy coverage yet lists zero markets — on a mismatched
   * lineage that is indistinguishable from an empty chain, so surface it instead of trusting it. */
  suspiciousEmpty: boolean;
}

/** GET <relayerUrl>/markets — the frontend's MarketTouched index; every row re-verified locally. */
export async function fetchRelayerMarkets(profile: DeploymentProfile): Promise<RelayerMarketsResult> {
  if (!profile.relayerUrl) return { ok: false, reason: "profile has no relayerUrl", markets: [], suspiciousEmpty: false };
  let payload: Record<string, unknown>;
  try {
    const res = await fetch(`${profile.relayerUrl.replace(/\/$/, "")}/markets`);
    if (!res.ok) return { ok: false, reason: `relayer answered ${res.status}`, markets: [], suspiciousEmpty: false };
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "relayer unreachable", markets: [], suspiciousEmpty: false };
  }
  if (String(payload.chainId) !== String(profile.chainId) || getAddress(String(payload.core)) !== profile.core) {
    return { ok: false, reason: "index serves a different chain/core domain", markets: [], suspiciousEmpty: false };
  }
  const rows = Array.isArray(payload.markets) ? payload.markets : null;
  if (!rows) return { ok: false, reason: "malformed index payload", markets: [], suspiciousEmpty: false };
  const markets: DiscoveredMarket[] = [];
  try {
    for (const row of rows as Array<Record<string, unknown>>) {
      const p = row.params as Record<string, unknown>;
      const params: MarketParams = {
        loanToken: getAddress(String(p.loanToken)) as Address,
        collateralToken: getAddress(String(p.collateralToken)) as Address,
        maturity: BigInt(String(p.maturity)),
        strike: BigInt(String(p.strike)),
        allowPartialRepay: Boolean(p.allowPartialRepay),
        gate: getAddress(String(p.gate)) as Address,
      };
      verifyTouchedMarket(profile.abiProfile, { chainId: profile.chainId, core: profile.core }, row.id as Hex, params);
      markets.push({ id: row.id as Hex, params, firstSeenBlock: BigInt(String(row.firstSeenBlock ?? 0)) });
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), markets: [], suspiciousEmpty: false };
  }
  const healthy = payload.syncing === false && payload.stale === false && payload.coverageUnknown === false;
  return { ok: true, markets, suspiciousEmpty: healthy && markets.length === 0 };
}
