import type { Address, Hex } from "../types.ts";

export type Amount = { raw: string; decimals: number; human: string; token: Address };
export type Warning = { code: string; severity: "info" | "warning" | "critical"; message: string };
export type Snapshot = {
  chainId: number; core: Address; blockNumber: string; blockHash: Hex;
  blockTimestamp: string; observedAt: string;
  coverage: "complete" | "partial" | "unknown"; omitted: string[];
};
export type Result<T> = {
  schemaVersion: 1; data: T; snapshot: Snapshot | null;
  warnings: Warning[]; nextActions: { tool: string; reason: string }[];
};
export type ToolFailure = { code: string; message: string; retryable: boolean; field?: string; nextAction?: string };
export class ActionError extends Error implements ToolFailure {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly field?: string, readonly nextAction?: string) {
    super(`${code}: ${message}`);
    this.name = "ActionError";
  }
}
export type UnsignedTx = { chainId: number; from: Address; to: Address; data: Hex; value: string };
export type Prepared =
  | { kind: "ready"; previewId: string; transaction: UnsignedTx; expiresAt: string }
  | { kind: "prerequisites"; previewId: string; transactions: UnsignedTx[]; repreviewRequired: true };
export function result<T>(data: T, snapshot: Snapshot | null, warnings: Warning[] = [], nextActions: Result<T>["nextActions"] = []): Result<T> {
  return { schemaVersion: 1, data, snapshot, warnings, nextActions };
}
