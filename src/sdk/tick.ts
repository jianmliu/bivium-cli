import { WAD } from "./types.ts";

export const MAX_TICK = 5820n;
export const TICK_SPACING = 4n;
const TICK_CENTER = 2910;
const TICK_DELTA = Math.log(1.005); // float seed for the inverse only; forward map is exact
const LN_STEP_WAD = 4_987_541_511_039_073n;

// Exact BigInt port of SignedWadMath.wadExp (matches EVM sdiv truncation and arithmetic shifts,
// which affect the last wei). Same algorithm the frontend uses to mirror TickLib on-chain.
function wadExp(x: bigint): bigint {
  if (x <= -42_139_678_854_452_767_551n) return 0n;
  if (x >= 135_305_999_368_893_231_589n) throw new RangeError("EXP_OVERFLOW");

  x = (x << 78n) / 5n ** 18n;

  const ln2 = 54_916_777_467_707_473_351_141_471_128n;
  const k = ((x << 96n) / ln2 + (1n << 95n)) >> 96n;
  x -= k * ln2;

  let y = x + 1_346_386_616_545_796_478_920_950_773_328n;
  y = ((y * x) >> 96n) + 57_155_421_227_552_351_082_224_309_758_442n;
  let p = y + x - 94_201_549_194_550_492_254_356_042_504_812n;
  p = ((p * y) >> 96n) + 28_719_021_644_029_726_153_956_944_680_412_240n;
  p = p * x + (4_385_272_521_454_847_904_659_076_985_693_276n << 96n);

  let q = x - 2_855_989_394_907_223_263_936_484_059_900n;
  q = ((q * x) >> 96n) + 50_020_603_652_535_783_019_961_831_881_945n;
  q = ((q * x) >> 96n) - 533_845_033_583_426_703_283_633_433_725_380n;
  q = ((q * x) >> 96n) + 3_604_857_256_930_695_427_073_651_918_091_429n;
  q = ((q * x) >> 96n) - 14_423_608_567_350_463_180_887_372_962_807_573n;
  q = ((q * x) >> 96n) + 26_449_188_498_355_588_339_934_803_723_976_023n;

  const r = p / q;
  return (r * 3_822_833_074_963_236_453_042_738_258_902_158_003_155_416_615_667n) >> (195n - k);
}

/**
 * Exact mirror of TickLib.tickToPrice. The grid is LOGISTIC:
 *   price(tick) = WAD / (1 + e^{δ·(CENTER − tick)}), price(MAX_TICK) pinned to exactly WAD.
 */
export function tickToPrice(tick: bigint): bigint {
  if (tick >= MAX_TICK) return WAD;
  const clamped = tick < 0n ? 0n : tick;
  const z = LN_STEP_WAD * (BigInt(TICK_CENTER) - clamped);
  return (WAD * WAD) / (WAD + wadExp(z));
}

/**
 * Inverse lookup onto the spaced grid, drift-corrected against the exact forward map.
 *   roundUp=false → largest grid tick with price ≤ target (BUY bid side).
 *   roundUp=true  → smallest grid tick with price ≥ target (SELL ask side).
 */
export function priceToTick(priceWad: bigint, roundUp: boolean): bigint {
  const p = Number(priceWad) / 1e18;
  if (p <= 0) return 0n;
  if (p >= 1) return MAX_TICK;
  const exact = TICK_CENTER + Math.log(p / (1 - p)) / TICK_DELTA;
  let t = roundUp ? Math.ceil(exact / 4) * 4 : Math.floor(exact / 4) * 4;
  if (t < 0) t = 0;
  if (t > Number(MAX_TICK)) t = Number(MAX_TICK);
  if (roundUp) {
    while (t < Number(MAX_TICK) && tickToPrice(BigInt(t)) < priceWad) t += 4;
    while (t - 4 >= 0 && tickToPrice(BigInt(t - 4)) >= priceWad) t -= 4;
  } else {
    while (t > 0 && tickToPrice(BigInt(t)) > priceWad) t -= 4;
    while (t + 4 <= Number(MAX_TICK) && tickToPrice(BigInt(t + 4)) <= priceWad) t += 4;
  }
  return BigInt(t);
}

const YEAR_SECONDS = 365n * 24n * 3600n;
const BPS = 10_000n;

/** Zero-coupon price implied by a simple APR over a term: price = 1 / (1 + apr·t/year), floored. */
export function priceFromSimpleAprBps(aprBps: bigint, secondsToMaturity: bigint): bigint {
  if (aprBps < 0n || secondsToMaturity <= 0n) throw new RangeError("apr and term must be positive");
  return (WAD * YEAR_SECONDS * BPS) / (YEAR_SECONDS * BPS + aprBps * secondsToMaturity);
}

/** Simple APR (bps, floored) implied by a zero-coupon price over a term. */
export function simpleAprBpsFromPrice(priceWad: bigint, secondsToMaturity: bigint): bigint {
  if (priceWad <= 0n || priceWad > WAD || secondsToMaturity <= 0n) throw new RangeError("bad price/term");
  return ((WAD - priceWad) * YEAR_SECONDS * BPS) / (priceWad * secondsToMaturity);
}
