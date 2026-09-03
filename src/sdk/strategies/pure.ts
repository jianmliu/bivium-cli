// `@bivium/cli/strategies` — the L1 surface of the strategy toolbox: the pure math, and nothing behind it but
// viem's hashing helpers. No chain client, no filesystem, no fetch, no profile: this entry bundles into a
// Cloudflare Worker, a browser tab, or a Node process alike, which is what lets the frontend's /api/strategies
// Functions run THIS implementation instead of a float port of it. One set of numbers — the ones a human sees on
// the confirm screen and the ones an agent executes on — from one place.
//
// Everything with a side effect (discovery, the relayer, gathering a live quote, the HTTP parity check) stays
// behind the package root (`@bivium/cli`) and is deliberately not re-exported here. test/package-surface.test.ts
// pins this: the runtime import closure of this file must stay inside the allowlist there.
export * from "./types.ts";
export * from "./lines.ts";
export * from "./probability.ts";
export * from "./payoff.ts";
export * from "./catalog.ts";
export * from "./resolve.ts";
export * from "./quote.ts";
// The leg program and the pool a swap leg runs on. Both are pure: `program.ts` only encodes, and every chain read
// in `pools.ts` is handed in as an `EthCall`, so the browser supplies viem and this entry keeps its no-I/O promise.
export * from "./program.ts";
export * from "./pools.ts";
export { STRIKE_SCALE, WAD, ZERO_ADDRESS, type Address, type Hex, type MarketParams, type Offer } from "../types.ts";
export { collateralForDebt, debtForCollateral, principalForUnits, floorFromStrike, strikeFromFloor, parseAmount, formatAmount } from "../math.ts";
export { computeMarketId } from "../market.ts";
export type { DiscoveredMarket } from "../discovery.ts";
