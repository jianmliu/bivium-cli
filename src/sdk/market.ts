import { encodeAbiParameters, keccak256 } from "viem";
import type { Hex, MarketParams } from "./types.ts";

const MARKET_PARAMS_ABI = [
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "bool" },
  { type: "address" },
] as const;

/** core-v1 market id: keccak256(abi.encode(loanToken, collateralToken, maturity, strike, allowPartialRepay, gate)). */
export function computeMarketId(params: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(MARKET_PARAMS_ABI, [
      params.loanToken,
      params.collateralToken,
      params.maturity,
      params.strike,
      params.allowPartialRepay,
      params.gate,
    ]),
  );
}
