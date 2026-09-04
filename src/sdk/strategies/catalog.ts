// Strategy catalog v1. Machine-readable: `GET /api/strategies` returns this verbatim so an agent can
// read each strategy's inputs, legs, payoff shape and constraints without a UI. Names are what a
// user sees; ids are stable API identifiers. Legs are EXISTING core actions — nothing new.
import type { InputField, StrategyDef } from "./types.ts";

const asset: InputField = { name: "asset", type: "address", required: true, description: "the asset the view is about" };
const counter: InputField = { name: "counter", type: "address", required: true, description: "the other leg of a relative strategy" };
const size: InputField = { name: "size", type: "bigint", required: true, description: "size in the asset's native units" };
const maturity: InputField = { name: "maturity", type: "maturity", required: true, description: "an existing future maturity from market discovery; use the venue's listed tenor, not an assumed weekly expiry" };
const bufferPct: InputField = { name: "bufferPct", type: "number", required: true, description: "strike buffer vs spot in the OTM direction, percent" };

export const STRATEGIES: readonly StrategyDef[] = [
  // ── 看空 ──
  {
    id: "short",
    initialRelease: true,
    outcomeLabels: ["Repay borrowed asset", "Forfeit quote collateral"],
    name: "无清算做空",
    oneLiner: "借入 Meme 并卖出；到期前可买回还币，或放弃抵押交割。展示盈亏平衡价、开仓成本与最大损失，期间无价格触发清算。",
    group: "bearish",
    side: "borrow",
    line: "options",
    legs: [
      { line: "options", side: "borrow", kind: "fill-bid", note: "take a lender's BUY bid, receiver = router" },
      { line: "options", side: "borrow", kind: "swap", note: "swap asset → numeraire inside the callback" },
    ],
    requires: ["swap", "router"],
    holdingRequired: "quote",
    worstCaseForm: "forfeit-collateral",
    otmDirection: "above",
    mirrorOf: "lendAsset",
    quotable: true,
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "pairShort",
    initialRelease: false,
    outcomeLabels: ["Repay borrowed asset", "Forfeit counter collateral"],
    name: "相对做空",
    oneLiner: "抵押 counter 借 asset，卖成 counter。押的是比率而不是美元价，两腿各自的插针互相抵消。",
    group: "relative",
    side: "borrow",
    line: "exchange",
    legs: [
      { line: "exchange", side: "borrow", kind: "fill-bid", note: "take a lender's BUY bid" },
      { line: "exchange", side: "borrow", kind: "swap", note: "swap asset → counter (direct pool or two hops)" },
    ],
    requires: ["swap", "router"],
    holdingRequired: "counter",
    worstCaseForm: "forfeit-collateral",
    otmDirection: "above",
    mirrorOf: "lendAsset",
    quotable: true,
    inputs: [asset, counter, size, maturity, bufferPct],
  },
  // ── 看多 ──
  {
    id: "leveredLong",
    initialRelease: true,
    outcomeLabels: ["Repay borrowed quote", "Deliver asset collateral"],
    name: "有地板的杠杆多头",
    oneLiner: "抵押 Meme 借入报价资产，再买入更多 Meme。兼容 Router 可原子执行；展示盈亏平衡价、杠杆与最大损失，期间无价格触发清算。",
    group: "bullish",
    side: "borrow",
    line: "credit",
    legs: [
      { line: "credit", side: "borrow", kind: "fill-bid", note: "take a lender's BUY bid, receiver = router" },
      { line: "credit", side: "borrow", kind: "swap", note: "swap numeraire → asset; initial + bought = collateral" },
    ],
    requires: ["swap", "router"],
    holdingRequired: "asset",
    worstCaseForm: "deliver-collateral",
    otmDirection: "below",
    mirrorOf: "lendQuote",
    quotable: true,
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "protectivePut",
    initialRelease: false,
    outcomeLabels: ["Repay and retain asset", "Deliver asset at strike"],
    name: "保护性看跌",
    oneLiner: "持有 C，抵押借出现金并持有现金。等价于给 C 买了一张到期以 K 卖出的保险。",
    group: "bullish",
    side: "borrow",
    line: "credit",
    legs: [{ line: "credit", side: "borrow", kind: "fill-bid", note: "take a lender's BUY bid; principal to the user's wallet, no swap" }],
    requires: [],
    holdingRequired: "asset",
    worstCaseForm: "premium",
    otmDirection: "below",
    mirrorOf: "lendQuote",
    quotable: true,
    inputs: [asset, size, maturity, bufferPct],
  },
  // ── 持有并收益 ──
  {
    id: "lendAsset",
    initialRelease: true,
    outcomeLabels: ["Asset repaid", "Asset called away"],
    name: "带薪止盈",
    oneLiner: "存入 Meme 并挂出借报价，成交后赚取期限收益；到期按实际还款比例收到 Meme、报价抵押资产或两者组合，可用于目标价卖出。",
    group: "yield",
    side: "lend",
    line: "options",
    legs: [{ line: "options", side: "lend", kind: "fill-ask", note: "Lend now: eat the ask (or rest a rate order)" }],
    requires: [],
    holdingRequired: "asset",
    worstCaseForm: "called-away",
    otmDirection: "above",
    mirrorOf: "short",
    quotable: true,
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "lendQuote",
    initialRelease: true,
    outcomeLabels: ["Quote repaid", "Asset assigned at target"],
    name: "带薪抄底",
    oneLiner: "存入报价资产并挂出借报价，成交后赚取期限收益；到期可能收到 Meme 抵押品，可用于目标价买入，但抵押品归零可损失本金。",
    group: "yield",
    side: "lend",
    line: "credit",
    legs: [{ line: "credit", side: "lend", kind: "fill-ask", note: "Lend now: eat the ask" }],
    requires: [],
    holdingRequired: "quote",
    worstCaseForm: "assigned",
    otmDirection: "below",
    mirrorOf: "leveredLong",
    quotable: true,
    inputs: [asset, size, maturity, bufferPct],
  },
  // ── 波动与组合(需要 Router 或前端编排;暂不可作为单一单位报价)──
  {
    id: "straddle",
    initialRelease: false,
    outcomeLabels: ["Downside leg pays", "Upside leg pays"],
    name: "做多波动(跨式)",
    oneLiner: "credit 线 borrow + options 线 borrow，同 K 同 T。",
    group: "volatility",
    side: "borrow",
    line: "credit",
    legs: [
      { line: "credit", side: "borrow", kind: "fill-bid", note: "leg 1" },
      { line: "options", side: "borrow", kind: "fill-bid", note: "leg 2 — same K, same T (weekly series aligned to Friday)" },
    ],
    requires: ["router"],
    holdingRequired: "asset",
    worstCaseForm: "premium",
    otmDirection: "below",
    quotable: false,
    // Not one market, so not `quotable` — but resolvable and priceable through `resolveStraddle`/`quoteStraddle`,
    // which compose the two single-leg positions rather than inventing a third kind of arithmetic.
    composite: true,
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "shortVol",
    initialRelease: false,
    outcomeLabels: ["Both legs expire", "One or both legs assigned"],
    name: "做空波动",
    oneLiner: "两条线同时 lend。两次 take ask，纯前端编排即可。",
    group: "volatility",
    side: "lend",
    line: "credit",
    legs: [
      { line: "credit", side: "lend", kind: "fill-ask", note: "leg 1" },
      { line: "options", side: "lend", kind: "fill-ask", note: "leg 2" },
    ],
    requires: [],
    holdingRequired: "asset",
    worstCaseForm: "assigned",
    otmDirection: "below",
    quotable: false,
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "collar",
    initialRelease: false,
    outcomeLabels: ["Protected downside delivery", "Upside called away"],
    name: "领口",
    oneLiner: "credit 线 borrow + options 线 lend，同一资产(资产需同时是某市场抵押与另一市场借出资产)。",
    group: "hold",
    side: "borrow",
    line: "credit",
    legs: [
      { line: "credit", side: "borrow", kind: "fill-bid", note: "protective leg" },
      { line: "options", side: "lend", kind: "fill-ask", note: "financing leg" },
    ],
    requires: ["router"],
    holdingRequired: "asset",
    worstCaseForm: "deliver-collateral",
    otmDirection: "below",
    quotable: false,
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "spread",
    initialRelease: false,
    outcomeLabels: ["Both legs expire", "Spread settles between strikes", "Maximum spread payout"],
    name: "价差",
    oneLiner: "同 pair 两档 strike 一借一贷(ladder 已有多档 rung;需 Router 支持混合 fill + take)。",
    group: "relative",
    side: "borrow",
    line: "credit",
    legs: [
      { line: "credit", side: "borrow", kind: "fill-bid", note: "rung A" },
      { line: "credit", side: "lend", kind: "fill-ask", note: "rung B" },
    ],
    requires: ["router"],
    holdingRequired: "asset",
    worstCaseForm: "premium",
    otmDirection: "below",
    quotable: false,
    inputs: [asset, size, maturity, bufferPct],
  },
];

export const STRATEGY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  earnOnHoldings: "lendAsset",
  buyAtTarget: "lendQuote",
  cappedRiskShort: "short",
});

/** Stable discovery order shared by the SDK and CLI; flags are the single source of membership. */
export function initialReleaseIds(): string[] {
  return STRATEGIES.filter((strategy) => strategy.initialRelease).map((strategy) => strategy.id).sort();
}

export function getStrategy(id: string): StrategyDef {
  const stableId = STRATEGY_ALIASES[id] ?? id;
  const s = STRATEGIES.find((d) => d.id === stableId);
  if (!s) throw new Error(`unknown strategy ${JSON.stringify(id)}`);
  return s;
}

/** The catalog in JSON-safe form (no bigints inside, so this is a straight copy). */
export function catalogJson(): readonly StrategyDef[] {
  return STRATEGIES;
}
