import { getAddress, keccak256, parseAbi, type Account, type Address } from "viem";
import { SettlerClient, poolKeyFor, settlerAbi, type ExecutionBounds } from "../sdk/settler.ts";
import { formatAmount } from "../sdk/math.ts";
import { ZERO_ADDRESS, type DeploymentProfile, type MarketParams, type Position } from "../sdk/types.ts";

const MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const MANAGER_HASH = "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626";
const UINT256_MAX = (1n << 256n) - 1n;
type Values = Record<string, string | boolean | undefined>;
const boundedOnly = ["bounded-jit-wrapper", "bounded-jit-code-hash", "deadline", "max-debt", "max-loan-balance", "max-collateral-balance"];
const relationshipsAbi = parseAbi([
  "function BIVIUM() view returns (address)",
  "function SETTLER() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
]);

/** Check route intent before market reads or signing-key access. No bounded flags silently affect old routes. */
export function validateSettlementRouteFlags(values: Values): void {
  if (["via-jit", "via-morpho", "via-jit-bounded"].filter((key) => values[key] === true).length > 1) {
    throw new Error("choose one of --via-jit / --via-morpho / --via-jit-bounded");
  }
  if (!values["via-jit-bounded"]) {
    const flag = boundedOnly.find((key) => values[key] !== undefined);
    if (flag) throw new Error(`--${flag} requires --via-jit-bounded`);
  } else {
    for (const key of [...boundedOnly, "min-profit"]) required(values, key);
  }
}

function required(values: Values, flag: string): string {
  const value = values[flag];
  if (typeof value !== "string" || !value) throw new Error(`missing --${flag}`);
  return value;
}

/** Decimal strings only, no rounding or exponent/hex syntax; cap digit count before constructing a bigint. */
function uintAmount(value: string, decimals: number, flag: string): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || value.length > 336 || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`--${flag} must be a non-negative decimal uint256 amount`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals || (decimals === 0 && value.includes("."))) throw new Error(`--${flag} has invalid decimal precision`);
  const digits = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (digits.length > 78) throw new Error(`--${flag} exceeds uint256`);
  const amount = BigInt(digits);
  if (amount > UINT256_MAX) throw new Error(`--${flag} exceeds uint256`);
  return amount;
}

function nonzeroAddress(value: string, flag: string): Address {
  if (!/^0x[\da-fA-F]{40}$/.test(value) || value.toLowerCase() === ZERO_ADDRESS) throw new Error(`--${flag} must be a nonzero address`);
  try { return getAddress(value); } catch { throw new Error(`--${flag} must be a valid address`); }
}

function poolInteger(values: Values, flag: string, fallback: string, max: number, min: number): number {
  const value = values[flag] ?? fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 8 || Number(value) < min || Number(value) > max) {
    throw new Error(`--${flag} must be an integer in [${min}, ${max}]`);
  }
  return Number(value);
}

/** Explicit CAI-only route. All local, deployment and indicative-position checks precede the account callback. */
export async function executeBoundedKeeper(
  profile: DeploymentProfile,
  market: { params: MarketParams; loanDecimals: number; collateralDecimals: number },
  borrower: Address,
  values: Values,
  account: () => Account,
) {
  validateSettlementRouteFlags(values);
  if (profile.chainId !== 46630) throw new Error("--via-jit-bounded requires chain 46630");
  const settler = profile.maturitySettler;
  if (!settler) throw new Error("profile has no maturitySettler for this chain");
  const wrapper = nonzeroAddress(required(values, "bounded-jit-wrapper"), "bounded-jit-wrapper");
  const hash = required(values, "bounded-jit-code-hash");
  if (!/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error("--bounded-jit-code-hash must be bytes32");
  const bounds: ExecutionBounds = {
    deadline: uintAmount(required(values, "deadline"), 0, "deadline"),
    maxDebt: uintAmount(required(values, "max-debt"), market.loanDecimals, "max-debt"),
    maxLoanBalance: uintAmount(required(values, "max-loan-balance"), market.loanDecimals, "max-loan-balance"),
    maxCollateralBalance: uintAmount(required(values, "max-collateral-balance"), market.collateralDecimals, "max-collateral-balance"),
  };
  const minProfit = uintAmount(required(values, "min-profit"), market.loanDecimals, "min-profit");
  if (minProfit === 0n) throw new Error("--min-profit must be positive (gross loan-token surplus; gas is still payable)");
  const p = market.params;
  if (p.maturity < 0n || p.maturity > UINT256_MAX || bounds.deadline > p.maturity) throw new Error("--deadline must be <= market maturity (uint256)");
  if (p.strike < 0n || p.strike > UINT256_MAX) throw new Error("market strike must be uint256");
  if (p.loanToken.toLowerCase() === p.collateralToken.toLowerCase() || [p.loanToken, p.collateralToken].some((token) => token.toLowerCase() === ZERO_ADDRESS)) throw new Error("bounded pool pair must contain distinct nonzero loan/collateral ERC20 currencies");
  const hooks = values["pool-hooks"] ?? ZERO_ADDRESS;
  if (typeof hooks !== "string" || hooks.toLowerCase() !== ZERO_ADDRESS) throw new Error("bounded route requires zero pool hooks");
  const key = poolKeyFor(p.collateralToken, p.loanToken,
    poolInteger(values, "pool-fee", "3000", 0xffffff, 0),
    poolInteger(values, "pool-spacing", "60", 0x7fffff, 1), ZERO_ADDRESS);
  const explicitAsk = typeof values.ask === "string" ? uintAmount(values.ask, market.collateralDecimals, "ask") : undefined;
  const reader = new SettlerClient(profile, undefined, settler);
  await reader.verifyProfile();
  const snapshot = await reader.pub.getBlock();
  if (snapshot.number === null) throw new Error("bounded route requires a mined chain snapshot");
  if (snapshot.timestamp >= bounds.deadline) throw new Error("--deadline must be after the chain snapshot timestamp");
  const blockNumber = snapshot.number;
  const [wrapperCode, managerCode] = await Promise.all([
    reader.pub.getCode({ address: wrapper, blockNumber }), reader.pub.getCode({ address: MANAGER, blockNumber }),
  ]);
  if (!wrapperCode || wrapperCode === "0x") throw new Error("bounded wrapper has no runtime code");
  if (keccak256(wrapperCode).toLowerCase() !== hash.toLowerCase()) throw new Error("bounded wrapper runtime code hash mismatch");
  if (!managerCode || managerCode === "0x") throw new Error("reviewed PoolManager has no runtime code");
  if (keccak256(managerCode) !== MANAGER_HASH) throw new Error("reviewed PoolManager runtime code hash mismatch");
  const relation = (address: Address, functionName: "BIVIUM" | "SETTLER" | "POOL_MANAGER") => reader.pub.readContract({ address, abi: relationshipsAbi, functionName, blockNumber });
  const [bivium, boundSettler, poolManager, settlerBivium] = await Promise.all([
    relation(wrapper, "BIVIUM"), relation(wrapper, "SETTLER"), relation(wrapper, "POOL_MANAGER"), relation(settler, "BIVIUM"),
  ]);
  if (bivium.toLowerCase() !== profile.core.toLowerCase()) throw new Error("bounded wrapper BIVIUM mismatch");
  if (boundSettler.toLowerCase() !== settler.toLowerCase()) throw new Error("bounded wrapper SETTLER mismatch");
  if (poolManager.toLowerCase() !== MANAGER) throw new Error("bounded wrapper POOL_MANAGER mismatch");
  if (settlerBivium.toLowerCase() !== profile.core.toLowerCase()) throw new Error("settler BIVIUM mismatch");
  const id = reader.marketId(p);
  const [[minKeptBps, enabled], position] = await Promise.all([
    reader.pub.readContract({ address: settler, abi: settlerAbi, functionName: "authorizations", args: [id, borrower], blockNumber }),
    reader.pub.readContract({ address: profile.core, abi: reader.adapter.coreAbi, functionName: "position", args: [id, borrower], blockNumber } as never) as Promise<Position>,
  ]);
  if (!enabled) throw new Error("borrower has not armed this market");
  if (position.debt === 0n) throw new Error("no debt to settle");
  if (position.debt > bounds.maxDebt) throw new Error("indicative debt exceeds --max-debt");
  let ask = explicitAsk;
  if (ask === undefined) {
    const floor = await reader.pub.readContract({ address: settler, abi: settlerAbi, functionName: "floorOf", args: [position.collateral, BigInt(minKeptBps)], blockNumber });
    ask = await reader.pub.readContract({ address: settler, abi: settlerAbi, functionName: "maxAsk", args: [position.collateral, p.maturity, floor], blockNumber });
  }
  const writer = new SettlerClient(profile, account(), settler);
  const tx = await writer.settleWithFlashBounded(wrapper, p, borrower, ask, key, minProfit, bounds);
  return {
    settled: true, viaJitBounded: true, wrapper, tx: tx.hash,
    indicativeDebt: formatAmount(position.debt, market.loanDecimals),
    ask: formatAmount(ask, market.collateralDecimals),
    snapshotTimestamp: snapshot.timestamp.toString(), snapshotBlockNumber: blockNumber.toString(),
    // TxResult confirms success, but contains no authenticated settlement-event notional or profit.
    actualNotional: null,
  };
}
