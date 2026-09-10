import { createPublicClient, http } from "viem";
import { adapterFor } from "../lineage.ts";
import { fetchRelayerMarkets, type DiscoveredMarket } from "../discovery.ts";
import { ZERO_ADDRESS, type Address, type DeploymentProfile, type Hex, type MarketParams } from "../types.ts";
import type { BookEntry } from "../orderbook.ts";
import { ActionError, type Snapshot } from "./types.ts";

export type ContractRead = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint; account?: Address };
export interface ActionRpc {
  getChainId(): Promise<number>;
  getBlock(args?: { blockNumber?: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  readContract(request: ContractRead): Promise<unknown>;
  call?(request: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex }>;
  simulateContract?(request: ContractRead): Promise<unknown>;
  getBytecode?(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  getTransactionReceipt?(args: { hash: Hex }): Promise<{ status: string; blockNumber: bigint; blockHash: Hex }>;
  getTransaction?(args: { hash: Hex }): Promise<{ blockNumber: bigint | null }>;
}
export interface ActionContextOptions {
  profile: DeploymentProfile;
  /** An in-process test/host injection, never exposed as tool arguments. */
  rpc?: ActionRpc;
  markets?: (signal?: AbortSignal) => Promise<DiscoveredMarket[]>;
  now?: () => number;
  /** Host-side test/runtime budget; no tool argument can raise this deadline. */
  rpcTimeoutMs?: number;
  book?: (params: MarketParams, signal?: AbortSignal) => Promise<{ entries: BookEntry[]; source: string; observedAt?: string; coverage?: "complete" | "partial" | "unknown" }>;
}
export type ReadContext = {
  chainId: number; core: Address; account: Address;
  blockNumber: bigint; blockHash: Hex; timestamp: bigint;
  snapshot: Snapshot; rpc: ActionRpc; signal?: AbortSignal;
};
const CANARY: MarketParams = { loanToken: ZERO_ADDRESS, collateralToken: ZERO_ADDRESS, maturity: 1n, strike: 1n, allowPartialRepay: false, gate: ZERO_ADDRESS };

/** Fixed deployment, bounded RPC concurrency, no account signer or wallet methods. */
export class ActionContext {
  readonly profile: DeploymentProfile;
  readonly adapter;
  readonly rpc: ActionRpc;
  readonly now: () => number;
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly options: ActionContextOptions) {
    this.profile = options.profile;
    this.adapter = adapterFor(this.profile.abiProfile);
    this.now = options.now ?? Date.now;
    this.rpc = options.rpc ?? this.rpcFor();
  }
  private rpcFor(signal?: AbortSignal): ActionRpc {
    const timeout = this.options.rpcTimeoutMs ?? 8_000;
    return createPublicClient({ transport: http(this.profile.rpcUrl, {
      timeout, retryCount: 0,
      fetchFn: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) }),
    }) }) as unknown as ActionRpc;
  }
  async limited<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= 8) await new Promise<void>((resolve, reject) => {
      const start = () => { signal?.removeEventListener("abort", abort); this.active++; resolve(); };
      const abort = () => { this.waiting = this.waiting.filter((f) => f !== start); reject(signal?.reason); };
      this.waiting.push(start);
      signal?.addEventListener("abort", abort, { once: true });
    }); else this.active++;
    try { signal?.throwIfAborted(); return await run(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
  async pin(account: Address = ZERO_ADDRESS, signal?: AbortSignal): Promise<ReadContext> {
    const rpc = this.options.rpc ?? this.rpcFor(signal);
    try {
      const chain = await this.limited(() => rpc.getChainId(), signal);
      if (chain !== this.profile.chainId) throw new ActionError("DOMAIN_MISMATCH", "RPC chain differs from configured deployment");
      const block = await this.limited(() => rpc.getBlock(), signal);
      if (block.number === null || !block.hash) throw new ActionError("UPSTREAM_UNAVAILABLE", "No mined block available", true);
      const snapshot: Snapshot = { chainId: chain, core: this.profile.core, blockNumber: String(block.number), blockHash: block.hash, blockTimestamp: String(block.timestamp), observedAt: new Date(this.now()).toISOString(), coverage: "complete", omitted: [] };
      const ctx: ReadContext = { chainId: chain, core: this.profile.core, account, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, rpc, snapshot, signal };
      const actual = await this.read<Hex>(ctx, this.profile.core, this.adapter.coreAbi, "computeId", [this.adapter.chainParams(this.profile, CANARY)]);
      if (actual.toLowerCase() !== this.adapter.computeMarketId(this.profile, CANARY).toLowerCase()) throw new ActionError("DOMAIN_MISMATCH", "Core market hash disagrees with configured ABI lineage");
      return ctx;
    } catch (e) { throw upstream(e); }
  }
  async read<T>(ctx: ReadContext, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    try { return await this.limited(() => ctx.rpc.readContract({ address, abi, functionName, args, blockNumber: ctx.blockNumber }), ctx.signal) as T; }
    catch (e) { throw upstream(e); }
  }
  core<T>(ctx: ReadContext, functionName: string, args: readonly unknown[]): Promise<T> {
    return this.read(ctx, this.profile.core, this.adapter.coreAbi, functionName, args);
  }
  async markets(signal?: AbortSignal): Promise<DiscoveredMarket[]> {
    let rows: DiscoveredMarket[];
    try {
      if (this.options.markets) rows = await this.options.markets(signal);
      else {
        const response = await fetchRelayerMarkets(this.profile, { signal });
        if (!response.ok || response.suspiciousEmpty) throw new ActionError("UPSTREAM_UNAVAILABLE", response.reason ?? "Market index coverage inconsistent", true);
        rows = response.markets;
      }
    } catch (e) { throw upstream(e); }
    for (const row of rows) if (this.adapter.computeMarketId(this.profile, row.params).toLowerCase() !== row.id.toLowerCase()) throw new ActionError("DOMAIN_MISMATCH", "Market index identity mismatch");
    return rows;
  }
  async market(id: Hex, signal?: AbortSignal): Promise<DiscoveredMarket> {
    const market = (await this.markets(signal)).find((row) => row.id.toLowerCase() === id.toLowerCase());
    if (!market) throw new ActionError("MARKET_NOT_FOUND", "Unknown market; discover existing markets first");
    return market;
  }
  requireExecutable(): void {
    if (this.profile.chainId !== 46630 || this.profile.abiProfile !== "core-v2") throw new ActionError("UNSUPPORTED_ACTION", "Unsigned execution is enabled only for Robinhood testnet core-v2 (46630)");
  }
}
export function upstream(error: unknown): ActionError {
  return error instanceof ActionError ? error : new ActionError("UPSTREAM_UNAVAILABLE", error instanceof Error ? error.message : "Upstream request failed", true);
}
