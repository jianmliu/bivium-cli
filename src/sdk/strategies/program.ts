// A strategy as a StrategyRouter leg program (bivium-core `docs/strategy-router.md` §3-4, contract
// `src/periphery/StrategyRouter.sol`). `buildPlan` describes what a strategy does in steps a human reads; this
// module emits what the chain executes: an ordered `Leg[]` whose every bound is filled from the quote, ready to
// abi-encode into one `execute(Leg[], deadline)` call.
//
// The two are deliberately separate. A plan is advisory and covers the sequential and intent modes as well; a
// program is the router mode alone, and every number in it is a limit the transaction reverts on. Nothing here
// reaches the chain: the builder is pure, the caller signs and sends.
//
// **Why bounds and not amounts.** The fill's price is fixed by the signed offer's tick, so a fill's cost and the
// collateral it demands are exact and this module computes them. Only the swap is uncertain, so it carries the
// caller's floor (`minOut`), and the collateral top-up is bounded by what the swap is guaranteed to deliver:
// `maxTopUp = collateral - minOut`. A worse pool than the caller accepted reverts the whole program rather than
// quietly drawing more of their money.
import { encodeAbiParameters } from "viem";
import { collateralForDebt } from "../math.ts";
import { tickToPrice } from "../tick.ts";
import { WAD, type Address, type Hex, type MarketParams, type Offer } from "../types.ts";
import type { PoolKey } from "../settler.ts";
import type { StrategyResolution } from "./types.ts";

/// The deployment the structs are bound to. The router is core-v2 periphery, and a core-v2 `MarketParams` and
/// `Offer` carry the chain and the core as their first two fields — the SDK's own types are lineage-agnostic and
/// leave them off, so every encoder here puts them back exactly as `adapterFor("core-v2")` does. Encoding an offer
/// without them would hash to a different commitment and the ratifier would refuse it.
export interface ChainDomain {
  chainId: number | bigint;
  core: Address;
}

const bound = <T extends object>(domain: ChainDomain, value: T) =>
  ({ chainId: BigInt(domain.chainId), bivium: domain.core, ...value });

/// All a program needs of a resolution: which strategy, at what strike, about which pair. A caller with a signed
/// offer in hand has every one of these without a spot feed — a program's bounds come from the offer and the pool,
/// never from a mark.
export type ProgramView = Pick<StrategyResolution, "strategy" | "strike" | "asset" | "numeraire" | "line">;

// The v4 pool a swap leg runs on is the settler's `PoolKey` — one definition of a pool in this SDK, and its
// sorting rule (`poolKeyFor`) with it. The router checks the key names the market's own two tokens, so choosing a
// pool is a choice of fee tier and hook, never of pair.
export type { PoolKey } from "../settler.ts";

/// The contract's `LegKind`, in its declaration order — the enum is an ABI uint8 and the order is the contract's.
export const LEG_KIND = {
  FILL_BID: 0,
  FILL_ASK: 1,
  SWAP: 2,
  PULL: 3,
  REPAY: 4,
  WITHDRAW: 5,
  FLASH: 6,
} as const;
export type LegKindName = keyof typeof LEG_KIND;

export interface Leg {
  kind: number;
  /// The kind's payload, abi-encoded. Opaque to the router until the leg runs.
  data: Hex;
}

const ADDRESS = { type: "address" } as const;
const UINT256 = { type: "uint256" } as const;
const BOOL = { type: "bool" } as const;
const BYTES = { type: "bytes" } as const;
const BYTES32 = { type: "bytes32" } as const;

const MARKET_PARAMS = {
  type: "tuple",
  components: [
    { name: "chainId", ...UINT256 },
    { name: "bivium", ...ADDRESS },
    { name: "loanToken", ...ADDRESS },
    { name: "collateralToken", ...ADDRESS },
    { name: "maturity", ...UINT256 },
    { name: "strike", ...UINT256 },
    { name: "allowPartialRepay", ...BOOL },
    { name: "gate", ...ADDRESS },
  ],
} as const;

const OFFER = {
  type: "tuple",
  components: [
    { name: "chainId", ...UINT256 },
    { name: "bivium", ...ADDRESS },
    { name: "loanToken", ...ADDRESS },
    { name: "collateralToken", ...ADDRESS },
    { name: "maturity", ...UINT256 },
    { name: "strike", ...UINT256 },
    { name: "allowPartialRepay", ...BOOL },
    { name: "gate", ...ADDRESS },
    { name: "maker", ...ADDRESS },
    { name: "buy", ...BOOL },
    { name: "tick", ...UINT256 },
    { name: "maxUnits", ...UINT256 },
    { name: "maxAssets", ...UINT256 },
    { name: "start", ...UINT256 },
    { name: "expiry", ...UINT256 },
    { name: "group", ...BYTES32 },
    { name: "ratifier", ...ADDRESS },
  ],
} as const;

const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", ...ADDRESS },
    { name: "currency1", ...ADDRESS },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", ...ADDRESS },
  ],
} as const;

/// `Leg` is `{uint8, bytes}` at the ABI level, so an inner program is not a recursive type — the router decodes
/// each payload only when the leg runs, and its own validation is what keeps the nesting at depth one.
const LEG = {
  type: "tuple",
  components: [{ name: "kind", type: "uint8" }, { name: "data", ...BYTES }],
} as const;
const LEG_ARRAY = { type: "tuple[]", components: LEG.components } as const;

export const LEG_TUPLE_ARRAY = LEG_ARRAY;

const FILL_BID = {
  type: "tuple",
  components: [
    { name: "offer", ...OFFER },
    { name: "ratifierData", ...BYTES },
    { name: "units", ...UINT256 },
    { name: "maxTopUp", ...UINT256 },
    { name: "minPrincipal", ...UINT256 },
    { name: "inner", ...LEG_ARRAY },
  ],
} as const;

const FILL_ASK = {
  type: "tuple",
  components: [
    { name: "ask", ...OFFER },
    { name: "ratifierData", ...BYTES },
    { name: "units", ...UINT256 },
    { name: "maxCost", ...UINT256 },
  ],
} as const;

const SWAP = {
  type: "tuple",
  components: [
    { name: "key", ...POOL_KEY },
    { name: "tokenIn", ...ADDRESS },
    { name: "amountIn", ...UINT256 },
    { name: "minOut", ...UINT256 },
  ],
} as const;

const PULL = { type: "tuple", components: [{ name: "token", ...ADDRESS }, { name: "amount", ...UINT256 }] } as const;
const REPAY = { type: "tuple", components: [{ name: "params", ...MARKET_PARAMS }, { name: "assets", ...UINT256 }] } as const;
const WITHDRAW = { type: "tuple", components: [{ name: "params", ...MARKET_PARAMS }] } as const;

const FLASH = {
  type: "tuple",
  components: [
    { name: "key", ...POOL_KEY },
    { name: "token", ...ADDRESS },
    { name: "amount", ...UINT256 },
    { name: "settleToken", ...ADDRESS },
    { name: "maxSettleIn", ...UINT256 },
    { name: "inner", ...LEG_ARRAY },
  ],
} as const;

// ---- Leg constructors ---------------------------------------------------------------------------------------

export function fillBidLeg(args: {
  domain: ChainDomain;
  offer: Offer;
  ratifierData?: Hex;
  units: bigint;
  maxTopUp: bigint;
  minPrincipal: bigint;
  inner?: Leg[];
}): Leg {
  const inner = (args.inner ?? []).map((leg) => ({ kind: leg.kind, data: leg.data }));
  return {
    kind: LEG_KIND.FILL_BID,
    data: encodeAbiParameters([FILL_BID], [{
      offer: bound(args.domain, args.offer) as never,
      ratifierData: args.ratifierData ?? "0x",
      units: args.units,
      maxTopUp: args.maxTopUp,
      minPrincipal: args.minPrincipal,
      inner,
    }] as never),
  };
}

export function fillAskLeg(args: { domain: ChainDomain; ask: Offer; ratifierData?: Hex; units: bigint; maxCost: bigint }): Leg {
  return {
    kind: LEG_KIND.FILL_ASK,
    data: encodeAbiParameters([FILL_ASK], [{
      ask: bound(args.domain, args.ask) as never,
      ratifierData: args.ratifierData ?? "0x",
      units: args.units,
      maxCost: args.maxCost,
    }] as never),
  };
}

/// `amountIn: 0` spends the whole scratch balance — which is how a bid's principal becomes the collateral it posts
/// without the caller having to know the principal in advance.
export function swapLeg(args: { key: PoolKey; tokenIn: Address; amountIn?: bigint; minOut: bigint }): Leg {
  return {
    kind: LEG_KIND.SWAP,
    data: encodeAbiParameters([SWAP], [{
      key: args.key as never,
      tokenIn: args.tokenIn,
      amountIn: args.amountIn ?? 0n,
      minOut: args.minOut,
    }] as never),
  };
}

export function pullLeg(args: { token: Address; amount: bigint }): Leg {
  return { kind: LEG_KIND.PULL, data: encodeAbiParameters([PULL], [{ token: args.token, amount: args.amount }] as never) };
}

export function repayLeg(args: { domain: ChainDomain; params: MarketParams; assets: bigint }): Leg {
  return {
    kind: LEG_KIND.REPAY,
    data: encodeAbiParameters([REPAY], [{ params: bound(args.domain, args.params) as never, assets: args.assets }] as never),
  };
}

export function withdrawLeg(args: { domain: ChainDomain; params: MarketParams }): Leg {
  return {
    kind: LEG_KIND.WITHDRAW,
    data: encodeAbiParameters([WITHDRAW], [{ params: bound(args.domain, args.params) as never }] as never),
  };
}

export function flashLeg(args: {
  key: PoolKey;
  token: Address;
  amount: bigint;
  settleToken: Address;
  maxSettleIn: bigint;
  inner: Leg[];
}): Leg {
  return {
    kind: LEG_KIND.FLASH,
    data: encodeAbiParameters([FLASH], [{
      key: args.key as never,
      token: args.token,
      amount: args.amount,
      settleToken: args.settleToken,
      maxSettleIn: args.maxSettleIn,
      inner: args.inner.map((leg) => ({ kind: leg.kind, data: leg.data })),
    }] as never),
  };
}

// ---- The programs -------------------------------------------------------------------------------------------

export interface OpenProgramOptions {
  /// The deployment the offer belongs to; its chain and core bind every struct the program encodes.
  domain: ChainDomain;
  /// The signed bid or ask the fill takes.
  offer: Offer;
  ratifierData?: Hex;
  /// Face units of the leg. Defaults to the quote's.
  units?: bigint;
  /// The pool the swap leg runs on. Required for the strategies that carry one.
  poolKey?: PoolKey;
  /// The swap's floor, in the bought token's native units. Required with `poolKey`; it is also what bounds the
  /// collateral top-up, so a caller who will not name it cannot bound their outlay either.
  minOut?: bigint;
  /// The router's own fee, so this builder's `minPrincipal` is the number the router will actually hand over.
  feeBps?: bigint;
  /// Override the derived top-up ceiling (native units of the collateral token).
  maxTopUp?: bigint;
  /// Override the derived principal floor (native units of the loan token).
  minPrincipal?: bigint;
}

export interface ProgramBuild {
  legs: Leg[];
  /// What the builder derived, so a caller can show the bounds it is about to sign for.
  derived: {
    units: bigint;
    /// What the core will pay for the fill, exactly: the tick fixes it.
    cost: bigint;
    /// The router's skim off the premium.
    fee: bigint;
    /// What reaches the account (or the next leg) after the skim.
    principal: bigint;
    /// What the strike demands for `units`.
    collateral: bigint;
    maxTopUp: bigint;
    minPrincipal: bigint;
  };
}

/// The fee the router skims off a bid leg: a share of the PREMIUM, never of the notional, floored — the same
/// arithmetic as `OriginationFee.quoteFee`, so the floor this builder signs for is the one the router enforces.
export function originationFee(units: bigint, cost: bigint, feeBps: bigint): bigint {
  if (feeBps <= 0n) return 0n;
  const premium = units > cost ? units - cost : 0n;
  const fee = (premium * feeBps) / 10_000n;
  return fee > cost ? cost : fee;
}

/// What the core charges for a fill of `units` at the offer's tick, rounded the way the core rounds it: down for a
/// bid (the taker borrows less), up for an ask (the taker pays more). Always toward the resting maker.
export function fillCost(offer: Offer, units: bigint): bigint {
  const price = tickToPrice(offer.tick);
  return offer.buy ? (units * price) / WAD : (units * price + WAD - 1n) / WAD;
}

/// One strategy, one program. The order is the strategy; the bounds are the caller's.
export function buildOpenProgram(res: ProgramView, opts: OpenProgramOptions): ProgramBuild {
  const id = res.strategy.id;
  const units = opts.units ?? 0n;
  if (units <= 0n) throw new Error("a program needs a positive size");
  const feeBps = opts.feeBps ?? 0n;

  if (id === "lendAsset" || id === "lendQuote") {
    if (opts.offer.buy) throw new Error(`${id} takes a resting ask, not a bid`);
    const cost = fillCost(opts.offer, units);
    return {
      legs: [fillAskLeg({ domain: opts.domain, ask: opts.offer, ratifierData: opts.ratifierData, units, maxCost: cost })],
      derived: { units, cost, fee: 0n, principal: 0n, collateral: 0n, maxTopUp: 0n, minPrincipal: 0n },
    };
  }

  if (!opts.offer.buy) throw new Error(`${id} takes a lender's bid, not an ask`);
  const cost = fillCost(opts.offer, units);
  const fee = originationFee(units, cost, feeBps);
  const principal = cost - fee;
  const collateral = collateralForDebt(units, res.strike);
  const carriesSwap = res.strategy.requires.includes("swap");

  let inner: Leg[] = [];
  let maxTopUp: bigint;
  let minPrincipal: bigint;

  if (carriesSwap) {
    if (!opts.poolKey) throw new Error(`${id} has a swap leg: a pool key is required`);
    if (opts.minOut === undefined) {
      throw new Error(`${id} has a swap leg: minOut is required — it is the swap's floor and the top-up's ceiling`);
    }
    // The swap sells what the fill produced. On the credit line that is the numeraire, bought back into the asset
    // the strike wants; on the reciprocal lines it is the asset, sold for the numeraire the strike wants. Either
    // way the collateral token is what the swap buys, so the guaranteed part of the collateral is `minOut`.
    const tokenIn = id === "leveredLong" ? res.numeraire : res.asset;
    inner = [swapLeg({ key: opts.poolKey, tokenIn, amountIn: 0n, minOut: opts.minOut })];
    maxTopUp = opts.maxTopUp ?? (collateral > opts.minOut ? collateral - opts.minOut : 0n);
    // The principal is consumed by the swap, so its own floor is not where this strategy's risk is; `minOut` is.
    minPrincipal = opts.minPrincipal ?? 0n;
  } else {
    // A plain borrow: the account posts the whole collateral and keeps the cash, so the cash is the product and
    // the fill's price fixes it exactly.
    maxTopUp = opts.maxTopUp ?? collateral;
    minPrincipal = opts.minPrincipal ?? principal;
  }

  return {
    legs: [fillBidLeg({ domain: opts.domain, offer: opts.offer, ratifierData: opts.ratifierData, units, maxTopUp, minPrincipal, inner })],
    derived: { units, cost, fee, principal, collateral, maxTopUp, minPrincipal },
  };
}

export interface UnwindProgramOptions {
  domain: ChainDomain;
  params: MarketParams;
  /// Face to clear. A partial-repay market closes in slices.
  assets: bigint;
  /// `wallet` brings the repayment from the account; `flash` borrows it from the pool and buys it back out of the
  /// freed collateral, which is what closes a position whose loan token the account no longer holds.
  via: "wallet" | "flash";
  poolKey?: PoolKey;
  /// The most of the collateral the buy-back may consume. Required for `flash`: it is the whole bound.
  maxSettleIn?: bigint;
}

export function buildUnwindProgram(opts: UnwindProgramOptions): Leg[] {
  if (opts.assets <= 0n) throw new Error("an unwind needs a positive size");
  const repay = repayLeg({ domain: opts.domain, params: opts.params, assets: opts.assets });
  const withdraw = withdrawLeg({ domain: opts.domain, params: opts.params });
  if (opts.via === "wallet") {
    return [pullLeg({ token: opts.params.loanToken, amount: opts.assets }), repay, withdraw];
  }
  if (!opts.poolKey) throw new Error("a flash unwind needs the pool the repayment is bought back on");
  if (opts.maxSettleIn === undefined) {
    throw new Error("a flash unwind needs maxSettleIn — the most of the freed collateral the buy-back may consume");
  }
  return [flashLeg({
    key: opts.poolKey,
    token: opts.params.loanToken,
    amount: opts.assets,
    settleToken: opts.params.collateralToken,
    maxSettleIn: opts.maxSettleIn,
    inner: [repay, withdraw],
  })];
}

/// Which unwind a position takes by default: a cash borrow the account can repay out of pocket, anything else out
/// of its own collateral. The caller may still choose the other.
export function defaultUnwindVia(res: ProgramView): "wallet" | "flash" {
  return res.line === "credit" && res.strategy.id === "protectivePut" ? "wallet" : "flash";
}

/// The program as `execute`'s first argument.
export function programArgs(legs: Leg[]): { kind: number; data: Hex }[] {
  return legs.map((leg) => ({ kind: leg.kind, data: leg.data }));
}
