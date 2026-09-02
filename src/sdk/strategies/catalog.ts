// Strategy catalog v1. Machine-readable: `GET /api/strategies` returns this verbatim so an agent can
// read each strategy's inputs, legs, payoff shape and constraints without a UI. Names are what a
// user sees; ids are stable API identifiers. Legs are EXISTING core actions — nothing new.
import type { InputField, StrategyDef } from "./types.ts";

const asset: InputField = { name: "asset", type: "address", required: true, description: "the asset the view is about" };
const counter: InputField = { name: "counter", type: "address", required: true, description: "the other leg of a relative strategy" };
const size: InputField = { name: "size", type: "bigint", required: true, description: "size in the asset's native units" };
const maturity: InputField = { name: "maturity", type: "maturity", required: true, description: "an existing maturity (weekly series default: nearest Friday)" };
const bufferPct: InputField = { name: "bufferPct", type: "number", required: true, description: "strike buffer vs spot in the OTM direction, percent" };

export const STRATEGIES: readonly StrategyDef[] = [
  // ── 看空 ──
  {
    id: "short",
    name: "无清算做空",
    oneLiner: "借入资产并立即卖出。跌了买回还币；涨破 K 就放弃抵押——亏损封顶，中途没人能动你的仓位。",
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
    name: "有地板的杠杆多头",
    oneLiner: "抵押 C 借现金，现金再买 C。杠杆上限由 strike 决定，最坏结果是交割 C——永远不会被针打爆。",
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
    name: "带薪止盈",
    oneLiner: "出借 asset，收固定 premium；涨到 K 被叫走 = 在目标价止盈。一张会付你钱的限价卖单。",
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
    name: "带薪抄底",
    oneLiner: "出借现金，收 premium；C 跌到 K 被指派 = 以目标价买入。一张会付你钱的限价买单。",
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
    inputs: [asset, size, maturity, bufferPct],
  },
  {
    id: "shortVol",
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

export function getStrategy(id: string): StrategyDef {
  const s = STRATEGIES.find((d) => d.id === id);
  if (!s) throw new Error(`unknown strategy ${JSON.stringify(id)}`);
  return s;
}

/** The catalog in JSON-safe form (no bigints inside, so this is a straight copy). */
export function catalogJson(): readonly StrategyDef[] {
  return STRATEGIES;
}
