// Resolution: turn a VIEW (asset, direction, size, tenor, buffer) into a concrete market. The user
// never picks a market — the engine picks the rung whose buffer is closest to the one asked for,
// and when nothing is close it hands back the two nearest rungs so the UI/agent can offer them.
// Ranking uses floats (advisory); the chosen rung's exact core strike is what amounts use.
import { getAddress } from "viem";
import { getStrategy } from "./catalog.ts";
import { classifyLine, humanStrike, orientation } from "./lines.ts";
import type { PoolRow, PxWad, StrategyResolution, StrategySpec } from "./types.ts";

/** Buffer realised by a rung, signed in the strategy's OTM direction (positive = OTM). */
export function realizedBufferPct(strikeHuman: PxWad, spot: PxWad, otmDirection: "above" | "below"): number {
  const ratio = Number(strikeHuman) / Number(spot);
  return (otmDirection === "above" ? ratio - 1 : 1 - ratio) * 100;
}

export interface ResolveOptions {
  /** Rungs whose realised buffer differs from the request by more than this are "no match". */
  tolerancePct?: number;
  stables?: ReadonlySet<string>;
}

export function resolveStrategy(
  spec: StrategySpec,
  rows: PoolRow[],
  spot: PxWad,
  options: ResolveOptions = {},
): StrategyResolution {
  const strategy = getStrategy(spec.strategyId);
  if (!strategy.quotable) throw new Error(`strategy ${strategy.id} needs the Router before it can be resolved as one unit`);
  if (spot <= 0n) throw new RangeError("spot must be positive");
  const asset = getAddress(spec.asset);
  const counter = spec.counter ? getAddress(spec.counter) : undefined;

  const candidates: { row: PoolRow; strike: bigint; strikeHuman: PxWad; buffer: number }[] = [];
  for (const row of rows) {
    const line = classifyLine(row.loanSymbol, row.collateralSymbol, options.stables);
    if (line !== strategy.line) continue;
    if (row.market.params.maturity !== spec.maturity) continue;
    const o = orientation(line, row);
    if (getAddress(o.asset) !== asset) continue;
    if (strategy.line === "exchange" && counter && getAddress(o.numeraire) !== counter) continue;
    const strike = row.market.params.strike;
    const strikeHuman = humanStrike(line, strike, row.loanDecimals, row.collateralDecimals);
    candidates.push({ row, strike, strikeHuman, buffer: realizedBufferPct(strikeHuman, spot, strategy.otmDirection) });
  }
  if (candidates.length === 0) {
    throw new Error(`no ${strategy.line} market for this asset at maturity ${spec.maturity.toString()}`);
  }
  candidates.sort((a, b) => Math.abs(a.buffer - spec.bufferPct) - Math.abs(b.buffer - spec.bufferPct));
  const best = candidates[0];
  const tolerance = options.tolerancePct ?? 5;
  const matched = Math.abs(best.buffer - spec.bufferPct) <= tolerance;
  const alternatives = matched ? [] : candidates.slice(0, 2).map((c) => c.row);
  const o = orientation(strategy.line, best.row);
  return {
    strategy,
    row: best.row,
    side: strategy.side,
    line: strategy.line,
    strike: best.strike,
    strikeHuman: best.strikeHuman,
    realizedBufferPct: best.buffer,
    alternatives,
    asset: o.asset,
    numeraire: o.numeraire,
    assetDecimals: o.assetDecimals,
    numeraireDecimals: o.numeraireDecimals,
  };
}
