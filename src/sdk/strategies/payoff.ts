// Maturity payoffs — exact bigint, one variable (S_T). Every function returns the P&L vs the
// position's OWN initial outlay/stake, in numeraire native units, plus the boundary the user must
// understand (worst case + its FORM, best case, break-even). No liquidation exists structurally, so
// none is modelled: a borrower's only decisions at maturity are "repay" or "let the collateral go",
// and the rational one is taken.
import { collateralForDebt, debtForCollateral, principalForUnits } from "../math.ts";
import { WAD } from "../types.ts";
import type { Payoff, PayoffPoint, PxWad, WorstCaseForm } from "./types.ts";

const pow10 = (d: number): bigint => 10n ** BigInt(d);

/** Value of `assetAmount` (asset native) at price `px` (numeraire per whole asset), in numeraire native. Floor. */
export function valueInNumeraire(assetAmount: bigint, px: PxWad, assetDecimals: number, numeraireDecimals: number): bigint {
  return (assetAmount * px * pow10(numeraireDecimals)) / (WAD * pow10(assetDecimals));
}

/** Asset (native) that `numeraireAmount` buys at `px`. Floor. */
export function assetForNumeraire(numeraireAmount: bigint, px: PxWad, assetDecimals: number, numeraireDecimals: number): bigint {
  if (px <= 0n) throw new RangeError("price must be positive");
  return (numeraireAmount * WAD * pow10(assetDecimals)) / (px * pow10(numeraireDecimals));
}

/** The S at which `assetAmount` is worth exactly `numeraireAmount` — a boundary price. Floor. */
export function priceWhereWorth(assetAmount: bigint, numeraireAmount: bigint, assetDecimals: number, numeraireDecimals: number): PxWad {
  if (assetAmount <= 0n) throw new RangeError("asset amount must be positive");
  return (numeraireAmount * WAD * pow10(assetDecimals)) / (assetAmount * pow10(numeraireDecimals));
}

export interface Decimals {
  assetDecimals: number;
  numeraireDecimals: number;
}

/** Sample a payoff function on [0, ceiling] plus the exact anchor prices, sorted by S. */
export function samplePayoff(
  pnl: (S: PxWad) => bigint,
  anchors: PxWad[],
  ceiling: PxWad,
  points = 41,
): PayoffPoint[] {
  const grid = new Set<bigint>();
  for (let i = 0; i < points; i++) grid.add((ceiling * BigInt(i)) / BigInt(points - 1));
  for (const a of anchors) if (a >= 0n && a <= ceiling) grid.add(a);
  return [...grid].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((S) => ({ S, pnl: pnl(S) }));
}

function ceilingFor(spot: PxWad, strike: PxWad): PxWad {
  const top = spot > strike ? spot : strike;
  return (top * 5n) / 2n; // 2.5× the larger of spot/strike — the plot's right edge
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A. Borrow the asset and sell it — `short` (options line) and `pairShort` (exchange line).
//    loan = asset, collateral = numeraire. The borrower's prepay IS the worst case.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface BorrowSellInputs extends Decimals {
  /** Face units of the asset borrowed (asset native). */
  units: bigint;
  /** WAD fill price of the lender's bid taken. */
  priceWad: bigint;
  /** Spot, numeraire per whole asset. */
  spot: PxWad;
  /** Core strike of the market (loan=asset per collateral=numeraire). */
  strike: bigint;
}

export interface BorrowSellResult {
  /** Asset actually received now = floor(units·price). */
  received: bigint;
  /** Numeraire from selling `received` at spot (estimate). */
  sold: bigint;
  /** Collateral the core locks for `units` of debt (numeraire native, exact). */
  collateral: bigint;
  /** The fixed-rate cost: the asset NOT received, valued at spot. */
  premium: bigint;
  /** collateral − sold: what the user tops up. Equals the worst loss. */
  prepay: bigint;
  /** S above which the rational borrower forfeits the collateral (human strike). */
  forfeitAbove: PxWad;
  payoff: Payoff;
}

export function borrowSellPayoff(i: BorrowSellInputs): BorrowSellResult {
  const received = principalForUnits(i.units, i.priceWad);
  const sold = valueInNumeraire(received, i.spot, i.assetDecimals, i.numeraireDecimals);
  const collateral = collateralForDebt(i.units, i.strike);
  const premium = valueInNumeraire(i.units - received, i.spot, i.assetDecimals, i.numeraireDecimals);
  const prepay = collateral > sold ? collateral - sold : 0n;
  // Forfeit exactly when buying back `units` costs at least the collateral.
  const forfeitAbove = priceWhereWorth(i.units, collateral, i.assetDecimals, i.numeraireDecimals);
  const pnl = (S: PxWad): bigint => {
    const buyBack = valueInNumeraire(i.units, S, i.assetDecimals, i.numeraireDecimals);
    return buyBack >= collateral ? -prepay : sold - buyBack;
  };
  const breakEven = priceWhereWorth(i.units, sold, i.assetDecimals, i.numeraireDecimals);
  const payoff: Payoff = {
    points: samplePayoff(pnl, [i.spot, forfeitAbove, breakEven], ceilingFor(i.spot, forfeitAbove)),
    worstCase: { amount: -prepay, at: "S_T ≥ K", form: "forfeit-collateral" },
    bestCase: { amount: sold, at: "S_T → 0" },
    breakEven,
    boundary: forfeitAbove,
  };
  return { received, sold, collateral, premium, prepay, forfeitAbove, payoff };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// B. Hold C, borrow numeraire against it, buy more C — `leveredLong` (credit line).
//    loan = numeraire, collateral = asset. Max loss = the user's own stake; never a "liquidation".
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface LeveredLongInputs extends Decimals {
  /** Asset held and pledged (asset native). */
  holding: bigint;
  /** Numeraire face borrowed. */
  borrowFace: bigint;
  priceWad: bigint;
  spot: PxWad;
  /** Core strike (loan=numeraire per collateral=asset). */
  strike: bigint;
}

export interface LeveredLongResult {
  received: bigint;
  bought: bigint;
  /** Total collateral after buying: holding + bought (+ topUp). */
  collateralTotal: bigint;
  /** Collateral the core requires for `borrowFace` (asset native). */
  required: bigint;
  /** Extra asset the user must add when holding + bought < required. */
  topUp: bigint;
  premium: bigint;
  /** The user's own capital at risk = (holding + topUp) valued at spot. */
  stake: bigint;
  /** Below this S the rational borrower delivers the collateral (human strike). */
  deliverBelow: PxWad;
  payoff: Payoff;
}

export function leveredLongPayoff(i: LeveredLongInputs): LeveredLongResult {
  const received = principalForUnits(i.borrowFace, i.priceWad);
  const bought = assetForNumeraire(received, i.spot, i.assetDecimals, i.numeraireDecimals);
  const required = collateralForDebt(i.borrowFace, i.strike);
  const base = i.holding + bought;
  const topUp = required > base ? required - base : 0n;
  const collateralTotal = base + topUp;
  const premium = i.borrowFace - received;
  const stake = valueInNumeraire(i.holding + topUp, i.spot, i.assetDecimals, i.numeraireDecimals);
  const deliverBelow = priceWhereWorth(collateralTotal, i.borrowFace, i.assetDecimals, i.numeraireDecimals);
  const pnl = (S: PxWad): bigint => {
    const worth = valueInNumeraire(collateralTotal, S, i.assetDecimals, i.numeraireDecimals);
    return worth < i.borrowFace ? -stake : worth - i.borrowFace - stake;
  };
  const breakEven = priceWhereWorth(collateralTotal, i.borrowFace + stake, i.assetDecimals, i.numeraireDecimals);
  const ceiling = ceilingFor(i.spot, deliverBelow);
  const payoff: Payoff = {
    points: samplePayoff(pnl, [i.spot, deliverBelow, breakEven], ceiling),
    worstCase: { amount: -stake, at: "S_T below the delivery point (face ÷ total collateral; equals K only at max LTV)", form: "deliver-collateral" },
    bestCase: { amount: pnl(ceiling), at: "unbounded above (value at the plot edge, 2.5x max(spot, K))" },
    breakEven,
    boundary: deliverBelow,
  };
  return { received, bought, collateralTotal, required, topUp, premium, stake, deliverBelow, payoff };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// C. Hold C, borrow numeraire against it, KEEP the cash — `protectivePut` (credit line).
//    Equivalent to buying a put struck at K: the floor is the cash received; cost is the premium.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface ProtectivePutInputs extends Decimals {
  holding: bigint;
  /** Numeraire face borrowed; default = the max the strike allows on `holding`. */
  borrowFace?: bigint;
  priceWad: bigint;
  spot: PxWad;
  strike: bigint;
}

export interface ProtectivePutResult {
  borrowFace: bigint;
  received: bigint;
  premium: bigint;
  stake: bigint;
  deliverBelow: PxWad;
  payoff: Payoff;
}

export function protectivePutPayoff(i: ProtectivePutInputs): ProtectivePutResult {
  const borrowFace = i.borrowFace ?? debtForCollateral(i.holding, i.strike);
  const received = principalForUnits(borrowFace, i.priceWad);
  const premium = borrowFace - received;
  const stake = valueInNumeraire(i.holding, i.spot, i.assetDecimals, i.numeraireDecimals);
  const deliverBelow = priceWhereWorth(i.holding, borrowFace, i.assetDecimals, i.numeraireDecimals);
  const pnl = (S: PxWad): bigint => {
    const worth = valueInNumeraire(i.holding, S, i.assetDecimals, i.numeraireDecimals);
    return worth < borrowFace ? received - stake : worth + received - borrowFace - stake;
  };
  // pnl == 0 when worth == stake + premium (repay branch).
  const breakEven = priceWhereWorth(i.holding, stake + premium, i.assetDecimals, i.numeraireDecimals);
  const ceiling = ceilingFor(i.spot, deliverBelow);
  const payoff: Payoff = {
    points: samplePayoff(pnl, [i.spot, deliverBelow, breakEven], ceiling),
    worstCase: { amount: received - stake, at: "S_T at/below the delivery point (face ÷ holding; equals K when borrowing the max)", form: "deliver-collateral" },
    bestCase: { amount: pnl(ceiling), at: "unbounded above (value at the plot edge, 2.5x max(spot, K))" },
    breakEven,
    boundary: deliverBelow,
  };
  return { borrowFace, received, premium, stake, deliverBelow, payoff };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// D. Lend the asset, collect premium, get CALLED AWAY at K — `lendAsset` (options/exchange lender).
//    Mirror of A. "A limit sell that pays you."
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface LendAssetInputs extends Decimals {
  units: bigint;
  priceWad: bigint;
  spot: PxWad;
  strike: bigint;
}

export interface LendAssetResult {
  /** Asset lent out now = floor(units·price). */
  lent: bigint;
  /** Premium in asset units (= units − lent) and its spot value in numeraire. */
  premiumAsset: bigint;
  premium: bigint;
  /** Collateral received instead of the asset when called away (numeraire native). */
  collateral: bigint;
  stake: bigint;
  calledAwayAbove: PxWad;
  payoff: Payoff;
}

export function lendAssetPayoff(i: LendAssetInputs): LendAssetResult {
  const lent = principalForUnits(i.units, i.priceWad);
  const premiumAsset = i.units - lent;
  const premium = valueInNumeraire(premiumAsset, i.spot, i.assetDecimals, i.numeraireDecimals);
  const collateral = collateralForDebt(i.units, i.strike);
  const stake = valueInNumeraire(lent, i.spot, i.assetDecimals, i.numeraireDecimals);
  const calledAwayAbove = priceWhereWorth(i.units, collateral, i.assetDecimals, i.numeraireDecimals);
  const pnl = (S: PxWad): bigint => {
    const back = valueInNumeraire(i.units, S, i.assetDecimals, i.numeraireDecimals);
    return back >= collateral ? collateral - stake : back - stake;
  };
  const breakEven = priceWhereWorth(i.units, stake, i.assetDecimals, i.numeraireDecimals);
  const payoff: Payoff = {
    points: samplePayoff(pnl, [i.spot, calledAwayAbove, breakEven], ceilingFor(i.spot, calledAwayAbove)),
    // For a lender the boundary that matters is the CAP: upside above K goes to the borrower.
    // Downside is the asset's own price risk (identical to simply holding it) and is on the curve.
    worstCase: { amount: collateral - stake, at: "S_T ≥ K: gain capped, upside above K goes to the borrower", form: "called-away" },
    bestCase: { amount: collateral - stake, at: "S_T ≥ K" },
    breakEven,
    boundary: calledAwayAbove,
  };
  return { lent, premiumAsset, premium, collateral, stake, calledAwayAbove, payoff };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// E. Lend the numeraire, collect premium, get ASSIGNED at K — `lendQuote` (credit lender).
//    Mirror of B/C. "A limit buy that pays you."
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface LendQuoteInputs extends Decimals {
  /** Numeraire face lent. */
  face: bigint;
  priceWad: bigint;
  spot: PxWad;
  strike: bigint;
}

export interface LendQuoteResult {
  lent: bigint;
  premium: bigint;
  /** Asset received instead of repayment when assigned (asset native). */
  collateral: bigint;
  assignedBelow: PxWad;
  payoff: Payoff;
}

export function lendQuotePayoff(i: LendQuoteInputs): LendQuoteResult {
  const lent = principalForUnits(i.face, i.priceWad);
  const premium = i.face - lent;
  const collateral = collateralForDebt(i.face, i.strike);
  const assignedBelow = priceWhereWorth(collateral, i.face, i.assetDecimals, i.numeraireDecimals);
  const pnl = (S: PxWad): bigint => {
    const worth = valueInNumeraire(collateral, S, i.assetDecimals, i.numeraireDecimals);
    return worth < i.face ? worth - lent : premium;
  };
  const breakEven = priceWhereWorth(collateral, lent, i.assetDecimals, i.numeraireDecimals);
  const payoff: Payoff = {
    points: samplePayoff(pnl, [i.spot, assignedBelow, breakEven], ceilingFor(i.spot, assignedBelow)),
    worstCase: { amount: -lent, at: "S_T → 0 after being assigned at K", form: "assigned" },
    bestCase: { amount: premium, at: "S_T ≥ K" },
    breakEven,
    boundary: assignedBelow,
  };
  return { lent, premium, collateral, assignedBelow, payoff };
}

export type { WorstCaseForm };
