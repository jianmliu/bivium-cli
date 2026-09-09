// The v4 pool a strategy's swap leg runs on: its key, its id, and the floor (`minOut`) the leg is bounded by.
//
// A swap is the one part of a program whose result is not fixed in advance — a fill's price is the signed offer's
// tick, but a swap's output is whatever the pool gives. So the leg carries a floor, and the floor is where the
// caller's intent lives. This module produces one, from the best source available:
//
//   `quoter`     the v4 Quoter simulates the actual swap, so the number carries the pool's DEPTH. Exact enough to
//                bound a large trade. Needs the Quoter's address, which is a per-deployment fact (`v4Quoter`).
//   `pool-price` the pool's current price from StateView's `slot0`, less the fee tier. Marginal, so it ignores
//                depth and reads HIGH for any size the pool cannot absorb.
//
// A high floor is the safe direction: the swap returns less than the floor and the whole program reverts, rather
// than executing at a price nobody agreed to. That is why `pool-price` is usable at all — but it is an estimate,
// it says so in the result, and `--min-out` always overrides both.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import type { Address, Hex } from "../types.ts";
import type { PoolKey } from "../settler.ts";

/// One `eth_call`, so this module needs no client of its own and a test needs no chain.
export type EthCall = (to: Address, data: Hex) => Promise<Hex>;

const POOL_KEY_ABI = [{
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
}] as const;

/// A v4 pool id is the hash of its key, and a key's currencies are SORTED — which is why the caller names two
/// tokens and this module decides which is currency0 rather than trusting an argument order.
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key as never]));
}

/// Does this key name exactly the market's two tokens? The router checks the same thing and reverts `PoolMismatch`;
/// checking it here turns a reverted transaction into a refusal to build one.
export function poolKeyCarries(key: PoolKey, tokenA: Address, tokenB: Address): boolean {
  const pair = [key.currency0.toLowerCase(), key.currency1.toLowerCase()].sort().join();
  return pair === [tokenA.toLowerCase(), tokenB.toLowerCase()].sort().join();
}

const GET_SLOT0 = "0xc815641c"; // StateView.getSlot0(bytes32)

/// `sqrtPriceX96` for a pool, or undefined when the pool has never been initialised (slot0 reads back zero).
export async function readSqrtPriceX96(call: EthCall, stateView: Address, key: PoolKey): Promise<bigint | undefined> {
  const raw = await call(stateView, `${GET_SLOT0}${poolIdOf(key).slice(2)}` as Hex);
  if (!raw || raw === "0x" || raw.length < 66) return undefined;
  const sqrtPriceX96 = BigInt(`0x${raw.slice(2, 66)}`);
  return sqrtPriceX96 > 0n ? sqrtPriceX96 : undefined;
}

const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96;

/// What the pool's CURRENT price would give for `amountIn`, less the fee tier — exact bigint arithmetic on
/// `sqrtPriceX96`, no floats. Marginal: it is the price of the next infinitesimal unit, so for any size the pool
/// cannot absorb it reads high. `swapFloor` is what turns it into a bound.
export function outAtPoolPrice(key: PoolKey, sqrtPriceX96: bigint, tokenIn: Address, amountIn: bigint): bigint {
  if (sqrtPriceX96 <= 0n || amountIn <= 0n) return 0n;
  const zeroForOne = key.currency0.toLowerCase() === tokenIn.toLowerCase();
  if (!zeroForOne && key.currency1.toLowerCase() !== tokenIn.toLowerCase()) {
    throw new Error("tokenIn is not one of the pool's currencies");
  }
  // v4 takes its fee on the input, in hundredths of a bip.
  const afterFee = (amountIn * BigInt(1_000_000 - key.fee)) / 1_000_000n;
  const p = sqrtPriceX96 * sqrtPriceX96; // currency1 per currency0, X192
  return zeroForOne ? (afterFee * p) / Q192 : (afterFee * Q192) / p;
}

const GET_LIQUIDITY = "0xfa6793d5"; // StateView.getLiquidity(bytes32)

/// The liquidity in range at the pool's current price, or undefined when it reads back zero — which is a pool with
/// nothing to trade against, not a pool worth quoting.
export async function readLiquidity(call: EthCall, stateView: Address, key: PoolKey): Promise<bigint | undefined> {
  const raw = await call(stateView, `${GET_LIQUIDITY}${poolIdOf(key).slice(2)}` as Hex);
  if (!raw || raw === "0x" || raw.length < 66) return undefined;
  const liquidity = BigInt(`0x${raw.slice(2, 66)}`);
  return liquidity > 0n ? liquidity : undefined;
}

/// What the pool would ACTUALLY give for `amountIn`, moving the price as it goes. Same exact-bigint arithmetic the
/// pool itself uses within one liquidity range: selling `currency0` walks `sqrtPrice` down, selling `currency1`
/// walks it up, and the output is the area that walk sweeps.
///
/// This is what `outAtPoolPrice` is not. That one prices the next infinitesimal unit, so on a thin pool it reads
/// high by however much the trade would move the price — 500 mCASHCAT against a 3.2e15 pool quoted 151 bUSD
/// marginally and returned 139, and a floor cut from the marginal number reverted the whole program `TooLittleOut`.
///
/// One caveat, and it is the reason a slippage cut still belongs on top: this assumes the swap stays inside the
/// current range. Crossing an initialised tick puts less liquidity behind the rest of the trade, so a swap large
/// enough to cross returns LESS than this says. It is a much tighter bound than the marginal price, never a
/// guarantee.
export function outAtDepth(
  key: PoolKey,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tokenIn: Address,
  amountIn: bigint,
): bigint {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n || amountIn <= 0n) return 0n;
  const zeroForOne = key.currency0.toLowerCase() === tokenIn.toLowerCase();
  if (!zeroForOne && key.currency1.toLowerCase() !== tokenIn.toLowerCase()) {
    throw new Error("tokenIn is not one of the pool's currencies");
  }
  const afterFee = (amountIn * BigInt(1_000_000 - key.fee)) / 1_000_000n;
  if (zeroForOne) {
    // Selling currency0: sqrtP' = L·Q96·sqrtP / (L·Q96 + dx·sqrtP), and the currency1 out is L·(sqrtP − sqrtP')/Q96.
    const numerator = liquidity * Q96;
    const next = (numerator * sqrtPriceX96) / (numerator + afterFee * sqrtPriceX96);
    return (liquidity * (sqrtPriceX96 - next)) / Q96;
  }
  // Selling currency1: sqrtP' = sqrtP + dy·Q96/L, and the currency0 out is L·Q96·(sqrtP' − sqrtP)/(sqrtP'·sqrtP).
  const next = sqrtPriceX96 + (afterFee * Q96) / liquidity;
  return (liquidity * Q96 * (next - sqrtPriceX96)) / (next * sqrtPriceX96);
}

/// How far the pool's price moves against a trade of this size, in basis points of the marginal quote. Zero on a
/// trade the pool barely notices; large is the signal that a size wants splitting, not a bigger slippage tolerance.
export function priceImpactBps(marginalOut: bigint, depthOut: bigint): number {
  if (marginalOut <= 0n || depthOut >= marginalOut) return 0;
  return Number(((marginalOut - depthOut) * 10_000n) / marginalOut);
}

/// The v4 Quoter's own entry, declared rather than hand-assembled: the selector is whatever this signature hashes
/// to, which is the only way to be sure it is the right one.
const QUOTER_ABI = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "poolKey", ...POOL_KEY_ABI[0] },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

/// The Quoter's own simulation of the swap: depth-aware, and the number to bound a real trade with. Undefined when
/// the call reverts — a pool with no liquidity, or a Quoter that is not this one.
export async function quoteExactInputSingle(
  call: EthCall,
  quoter: Address,
  key: PoolKey,
  tokenIn: Address,
  amountIn: bigint,
): Promise<bigint | undefined> {
  const zeroForOne = key.currency0.toLowerCase() === tokenIn.toLowerCase();
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: key as never, zeroForOne, exactAmount: amountIn, hookData: "0x" }] as never,
  });
  try {
    const raw = await call(quoter, data);
    if (!raw || raw === "0x") return undefined;
    const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: raw }) as [bigint, bigint];
    return amountOut > 0n ? amountOut : undefined;
  } catch {
    return undefined;
  }
}

export interface SwapFloor {
  minOut: bigint;
  /// What produced the estimate the floor was cut from, so a caller can say so rather than imply precision.
  source: "explicit" | "quoter" | "pool-depth" | "pool-price";
  /// How far this size moves the pool against itself, in bps of the marginal quote. Only meaningful for
  /// "pool-depth"; zero elsewhere, because nothing else in this file knows.
  impactBps: number;
  /// The estimate before the slippage cut; equal to `minOut` for `explicit`.
  estimate: bigint;
  slippageBps: number;
}

export interface SwapFloorRequest {
  call: EthCall;
  key: PoolKey;
  tokenIn: Address;
  amountIn: bigint;
  slippageBps: number;
  /// An explicit floor short-circuits everything: the caller has decided.
  explicit?: bigint;
  /// Depth-aware when present.
  quoter?: Address;
  /// The pool's own price and depth when there is no Quoter. With `stateView` this reads BOTH slot0 and the
  /// liquidity in range, and prices the trade against that depth rather than against the marginal price.
  stateView?: Address;
  /// Refuse rather than quote when the size moves the pool further than this. A floor can always be cut deep
  /// enough to pass, and doing that on a thin pool is how a caller signs away the difference; a size that moves the
  /// price this far wants splitting. Zero disables the check.
  maxImpactBps?: number;
}

/// The floor a swap leg carries. Refuses rather than guesses: with no explicit floor, no Quoter and no StateView
/// there is nothing to bound the swap with, and an unbounded swap is not a program anyone should sign.
export async function swapFloor(req: SwapFloorRequest): Promise<SwapFloor> {
  if (req.slippageBps < 0 || req.slippageBps >= 10_000) throw new Error("slippage must be within [0, 10000) bps");
  if (req.explicit !== undefined) {
    return { minOut: req.explicit, source: "explicit", estimate: req.explicit, slippageBps: 0, impactBps: 0 };
  }
  const cut = (estimate: bigint): bigint => (estimate * BigInt(10_000 - req.slippageBps)) / 10_000n;

  if (req.quoter) {
    const out = await quoteExactInputSingle(req.call, req.quoter, req.key, req.tokenIn, req.amountIn);
    if (out !== undefined) return { minOut: cut(out), source: "quoter", estimate: out, slippageBps: req.slippageBps, impactBps: 0 };
  }
  if (req.stateView) {
    const [sqrtPriceX96, liquidity] = await Promise.all([
      readSqrtPriceX96(req.call, req.stateView, req.key),
      readLiquidity(req.call, req.stateView, req.key),
    ]);
    if (sqrtPriceX96 !== undefined) {
      const marginal = outAtPoolPrice(req.key, sqrtPriceX96, req.tokenIn, req.amountIn);
      // With the depth in range, price the trade against it. The marginal number stays only as the reference the
      // impact is measured from — it is what the trade would get if it were infinitesimal.
      if (liquidity !== undefined) {
        const out = outAtDepth(req.key, sqrtPriceX96, liquidity, req.tokenIn, req.amountIn);
        const impactBps = priceImpactBps(marginal, out);
        if (out > 0n) {
          if (req.maxImpactBps !== undefined && req.maxImpactBps > 0 && impactBps > req.maxImpactBps) {
            throw new Error(
              `this size moves the pool ${(impactBps / 100).toFixed(2)}%, past the ${(req.maxImpactBps / 100).toFixed(2)}% `
                + "you allowed — split it, or raise the limit knowing the pool is what pays",
            );
          }
          return { minOut: cut(out), source: "pool-depth", estimate: out, slippageBps: req.slippageBps, impactBps };
        }
      }
      if (marginal > 0n) return { minOut: cut(marginal), source: "pool-price", estimate: marginal, slippageBps: req.slippageBps, impactBps: 0 };
    }
  }
  throw new Error(
    "no floor for the swap leg: pass --min-out, or give the profile a v4Quoter (depth-aware) or v4StateView "
      + "(the pool's current price) to estimate one from",
  );
}

/// The mirror of `swapFloor` for the other swap shape: the most of `tokenIn` an exact-OUTPUT of `amountOut` should
/// cost. A flash unwind buys its repayment back exact-output, so this is the bound on how much of the freed
/// collateral it may consume — the number that decides whether closing is worth it at all.
///
/// Only the pool's current price backs it: the Quoter's exact-output entry is a different call and this SDK does
/// not carry it, so a caller who needs depth-aware certainty passes the ceiling explicitly.
export async function swapCeiling(req: {
  call: EthCall;
  key: PoolKey;
  tokenIn: Address;
  amountOut: bigint;
  slippageBps: number;
  explicit?: bigint;
  stateView?: Address;
}): Promise<{ maxIn: bigint; source: "explicit" | "pool-price"; estimate: bigint; slippageBps: number }> {
  if (req.slippageBps < 0 || req.slippageBps >= 10_000) throw new Error("slippage must be within [0, 10000) bps");
  if (req.explicit !== undefined) {
    return { maxIn: req.explicit, source: "explicit", estimate: req.explicit, slippageBps: 0 };
  }
  if (!req.stateView) {
    throw new Error("no ceiling for the buy-back: pass --max-settle-in, or give the profile a v4StateView to price it from");
  }
  const sqrtPriceX96 = await readSqrtPriceX96(req.call, req.stateView, req.key);
  if (sqrtPriceX96 === undefined) throw new Error("the pool has no price to bound the buy-back with");
  // Invert the marginal price: what `amountOut` of the other currency costs in `tokenIn`, fee included.
  const zeroForOne = req.key.currency0.toLowerCase() === req.tokenIn.toLowerCase();
  if (!zeroForOne && req.key.currency1.toLowerCase() !== req.tokenIn.toLowerCase()) {
    throw new Error("tokenIn is not one of the pool's currencies");
  }
  const p = sqrtPriceX96 * sqrtPriceX96;
  const beforeFee = zeroForOne ? (req.amountOut * Q192 + p - 1n) / p : (req.amountOut * p + Q192 - 1n) / Q192;
  const estimate = (beforeFee * 1_000_000n + BigInt(1_000_000 - req.key.fee) - 1n) / BigInt(1_000_000 - req.key.fee);
  return {
    maxIn: (estimate * BigInt(10_000 + req.slippageBps)) / 10_000n,
    source: "pool-price",
    estimate,
    slippageBps: req.slippageBps,
  };
}
