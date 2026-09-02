import { encodeAbiParameters, isAddress, keccak256 } from "viem";
import type { Address, Hex } from "../types.ts";
import type { StrategyTrace } from "./types.ts";

export interface StartTraceInput {
  chainId: number | bigint;
  core: Address;
  account: Address;
  strategyId: string;
  quoteId: Hex;
  nonce: number | bigint;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function positiveInteger(value: number | bigint): boolean {
  return typeof value === "bigint"
    ? value > 0n
    : Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number | bigint): boolean {
  return typeof value === "bigint"
    ? value >= 0n
    : Number.isSafeInteger(value) && value >= 0;
}

function validateBytes32(value: Hex, name: string): void {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new Error(`${name} must be bytes32 hex`);
  }
}

export function startTrace(input: StartTraceInput): StrategyTrace {
  if (!positiveInteger(input.chainId)) throw new Error("chainId must be a positive integer");
  if (!isAddress(input.core, { strict: false })) throw new Error("core must be an address");
  if (!isAddress(input.account, { strict: false })) throw new Error("account must be an address");
  if (typeof input.strategyId !== "string" || input.strategyId.length === 0) {
    throw new Error("strategyId must be nonempty");
  }
  validateBytes32(input.quoteId, "quoteId");
  if (!nonNegativeInteger(input.nonce)) throw new Error("nonce must be a non-negative integer");

  const intentId = keccak256(encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "string" },
      { type: "bytes32" },
      { type: "uint256" },
    ],
    [BigInt(input.chainId), input.core, input.account, input.strategyId, input.quoteId, BigInt(input.nonce)],
  ));

  return {
    strategyId: input.strategyId,
    account: input.account,
    quoteId: input.quoteId,
    intentId,
  };
}

export function withOrder(trace: StrategyTrace, orderId: Hex): StrategyTrace {
  validateBytes32(orderId, "orderId");
  if (trace.orderId !== undefined) throw new Error("orderId is already set");
  return { ...trace, orderId };
}

export function withFill(trace: StrategyTrace, fillId: Hex): StrategyTrace {
  validateBytes32(fillId, "fillId");
  if (trace.orderId === undefined) throw new Error("orderId is required before fillId");
  if (trace.fillId !== undefined) throw new Error("fillId is already set");
  return { ...trace, fillId };
}
