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
  source: "explicit" | "quoter" | "pool-price";
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
  /// Marginal fallback when there is no Quoter.
  stateView?: Address;
}

/// The floor a swap leg carries. Refuses rather than guesses: with no explicit floor, no Quoter and no StateView
/// there is nothing to bound the swap with, and an unbounded swap is not a program anyone should sign.
export async function swapFloor(req: SwapFloorRequest): Promise<SwapFloor> {
  if (req.slippageBps < 0 || req.slippageBps >= 10_000) throw new Error("slippage must be within [0, 10000) bps");
  if (req.explicit !== undefined) {
    return { minOut: req.explicit, source: "explicit", estimate: req.explicit, slippageBps: 0 };
  }
  const cut = (estimate: bigint): bigint => (estimate * BigInt(10_000 - req.slippageBps)) / 10_000n;

  if (req.quoter) {
    const out = await quoteExactInputSingle(req.call, req.quoter, req.key, req.tokenIn, req.amountIn);
    if (out !== undefined) return { minOut: cut(out), source: "quoter", estimate: out, slippageBps: req.slippageBps };
  }
  if (req.stateView) {
    const sqrtPriceX96 = await readSqrtPriceX96(req.call, req.stateView, req.key);
    if (sqrtPriceX96 !== undefined) {
      const out = outAtPoolPrice(req.key, sqrtPriceX96, req.tokenIn, req.amountIn);
      if (out > 0n) return { minOut: cut(out), source: "pool-price", estimate: out, slippageBps: req.slippageBps };
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
