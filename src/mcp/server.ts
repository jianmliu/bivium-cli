// bivium-mcp — the CLI's agent twin: the strategy toolbox as MCP tools over stdio.
//
// Deliberately hand-rolled: MCP is newline-delimited JSON-RPC 2.0 with three methods that matter
// here (`initialize`, `tools/list`, `tools/call`) and a pure `handle(message)` core keeps the whole
// thing hermetically testable without pulling `@modelcontextprotocol/sdk` (+ zod) into a repo that
// is otherwise viem-only. Swapping in the official transport later is a one-file change.
//
// Scope is READ-ONLY on purpose: list the catalog, list markets, quote, plan. Nothing here signs
// or sends — execution stays with the CLI (`borrow execute`, `trade buy`, …) under the user's key,
// which is the "preview and execute are separate calls" rule from the design note.
import { createInterface } from "node:readline";
import { BiviumClient } from "../sdk/client.ts";
import { loadProfile } from "../sdk/profile.ts";
import { catalogJson } from "../sdk/strategies/catalog.ts";
import {
  gatherStrategyInputs,
  gatheredToJson,
  loadDiscoveredMarkets,
  planFromGathered,
  poolRowsFor,
  type GatherRequest,
  type PoolRow,
  type SpotRef,
  type BookLoader,
} from "../sdk/strategies/index.ts";
import { classifyLine, humanStrike } from "../sdk/strategies/lines.ts";
import { fetchStrategyPositions, type HttpPositionsResult, type HttpQuoteLoader } from "../sdk/strategies/http.ts";
import type { DeploymentProfile } from "../sdk/types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "bivium-strategies", version: "0.1.0" } as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Injection points so the core can be driven without a network or a chain. */
export interface McpDeps {
  profile: DeploymentProfile;
  client?: BiviumClient;
  /** Pre-fetched rows / spot / book — tests, or a host that already holds them. */
  overrides?: { rows?: PoolRow[]; spot?: SpotRef; book?: BookLoader; parity?: HttpQuoteLoader | false; positions?: (taker: string) => Promise<HttpPositionsResult> };
  now?: () => bigint;
}

const jsonReplacer = (_: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
export const toJsonText = (value: unknown): string => JSON.stringify(value, jsonReplacer, 2);

const viewProps = {
  strategy: { type: "string", description: "catalog id, e.g. short | leveredLong | lendQuote" },
  asset: { type: "string", description: "profile token symbol or address the view is about" },
  counter: { type: "string", description: "the other leg of a relative strategy (pairShort)" },
  size: { type: "string", description: "human amount in the asset's units (numeraire units for lendQuote)" },
  maturity: { type: ["string", "integer"], description: "an existing maturity (unix seconds) — pick from market_list" },
  bufferPct: { type: "number", description: "strike distance from spot in the OTM direction, percent, positive = OTM" },
  aprBps: { type: ["string", "integer"], description: "price the fill at a target simple APR (bps) instead of the live book" },
  priceWad: { type: "string", description: "explicit WAD fill price (1e18 = par)" },
  sigma: { type: "number", description: "annualised realised volatility (7.11 = 711%) for P(exercise); the feed's sigma21d is used when present" },
  source: { type: "string", enum: ["relayer", "chain"], description: "market discovery source (default: relayer when the profile has one)" },
  fromBlock: { type: ["string", "integer"], description: "chain-scan start block (default: profile.coreDeploymentBlock)" },
  chunkBlocks: { type: ["string", "integer"], description: "getLogs blocks per call for chain scans (default 900; e.g. 200000 on RPCs that allow it)" },
} as const;

export const TOOLS: ToolDef[] = [
  {
    name: "strategy_list",
    description: "The strategy catalog: id, name, group, side/line, legs, worst-case form, mirror, inputs. Read this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "market_list",
    description: "Discovered markets with pair, product line, human strike (numeraire per asset), maturity — pick a maturity here before quoting. Join existing markets; never invent one.",
    inputSchema: { type: "object", properties: { source: viewProps.source, fromBlock: viewProps.fromBlock, chunkBlocks: viewProps.chunkBlocks }, additionalProperties: false },
  },
  {
    name: "strategy_quote",
    description: "Resolve the nearest strike rung for a view and return the confirm-screen numbers: prepay, premium, worstCase (+form), bestCase, breakEven, boundary, exerciseProbability, payoff curve. Estimates are off the pair feed's spot; execution is bounded by minOut. Surface worstCase to the user before anything is spent.",
    inputSchema: { type: "object", required: ["strategy", "asset", "size", "maturity", "bufferPct"], properties: viewProps, additionalProperties: false },
  },
  {
    name: "strategy_plan",
    description: "The quote plus a bounded execution plan: mode (intent | router | sequential — the last is NOT atomic), steps, and hard limits maxLoss / minOut / deadline / quoteId. Never executes; run the steps with the CLI under the user's key.",
    inputSchema: {
      type: "object",
      required: ["strategy", "asset", "size", "maturity", "bufferPct"],
      properties: {
        ...viewProps,
        router: { type: "string", description: "deployed StrategyRouter address, if any" },
        minOut: { type: "string", description: "human floor for the swap leg (required when the strategy swaps)" },
        ttlSeconds: { type: ["string", "integer"], description: "plan validity window (default 600)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "strategy_positions",
    description: "An account's holdings read as strategies (from the app's /api/strategies/positions): candidate kinds per position, the two roads at maturity priced against each other, lender outcome, 48h urgency, auto-settle arm state, and the exact core action that exits. Read-only.",
    inputSchema: { type: "object", properties: { taker: { type: "string", description: "the account address" } }, required: ["taker"] },
  },
];

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}
function big(v: unknown, name: string): bigint | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(s);
}
function num(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function gatherRequestFrom(args: Record<string, unknown>, deps: McpDeps): GatherRequest {
  const strategy = str(args.strategy);
  const asset = str(args.asset);
  const size = str(args.size);
  const maturity = big(args.maturity, "maturity");
  const bufferPct = num(args.bufferPct, "bufferPct");
  if (!strategy || !asset || !size || maturity === undefined || bufferPct === undefined) {
    throw new Error("strategy, asset, size, maturity and bufferPct are required");
  }
  const source = str(args.source);
  if (source !== undefined && source !== "relayer" && source !== "chain") throw new Error("source must be relayer or chain");
  return {
    strategy,
    asset,
    counter: str(args.counter),
    size,
    maturity,
    bufferPct,
    priceWad: big(args.priceWad, "priceWad"),
    aprBps: big(args.aprBps, "aprBps"),
    sigmaAnnual: num(args.sigma, "sigma"),
    market: { source, fromBlock: big(args.fromBlock, "fromBlock"), chunkSize: big(args.chunkBlocks, "chunkBlocks") },
    now: deps.now?.(),
    rows: deps.overrides?.rows,
    spot: deps.overrides?.spot,
    book: deps.overrides?.book,
    parity: deps.overrides?.parity,
  };
}

export function createStrategyMcp(deps: McpDeps) {
  const { profile } = deps;

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "strategy_list":
        return { count: catalogJson().length, strategies: catalogJson() };
      case "market_list": {
        const rows = deps.overrides?.rows ?? (await poolRowsFor(profile, deps.client, await loadDiscoveredMarkets(profile, deps.client, { source: str(args.source) as "relayer" | "chain" | undefined, fromBlock: big(args.fromBlock, "fromBlock"), chunkSize: big(args.chunkBlocks, "chunkBlocks") })));
        return {
          count: rows.length,
          markets: rows.map((r) => {
            const line = classifyLine(r.loanSymbol, r.collateralSymbol);
            return {
              id: r.market.id,
              pair: `${r.collateralSymbol ?? r.market.params.collateralToken}/${r.loanSymbol ?? r.market.params.loanToken}`,
              line,
              loanToken: r.market.params.loanToken,
              collateralToken: r.market.params.collateralToken,
              maturity: r.market.params.maturity,
              strike: r.market.params.strike,
              strikeHuman: line ? humanStrike(line, r.market.params.strike, r.loanDecimals, r.collateralDecimals) : null,
              gate: r.market.params.gate,
            };
          }),
        };
      }
      case "strategy_quote": {
        const g = await gatherStrategyInputs(profile, deps.client, gatherRequestFrom(args, deps));
        return gatheredToJson(g);
      }
      case "strategy_plan": {
        const g = await gatherStrategyInputs(profile, deps.client, gatherRequestFrom(args, deps));
        const router = str(args.router);
        const plan = planFromGathered(profile, g, {
          router: router as `0x${string}` | undefined,
          minOut: str(args.minOut),
          ttlSeconds: big(args.ttlSeconds, "ttlSeconds"),
        });
        return { ...gatheredToJson(g), plan };
      }
      case "strategy_positions": {
        const taker = str(args.taker);
        if (!taker) throw new Error("taker is required");
        const result = await (deps.overrides?.positions ?? ((t: string) => fetchStrategyPositions(profile.relayerUrl, t)))(taker);
        if (!result.ok) throw new Error(`positions unavailable — not an empty account: ${result.reason}`);
        return result;
      }
      default:
        throw new Error(`unknown tool ${JSON.stringify(name)}`);
    }
  }

  /** One JSON-RPC message in → one response out (null for notifications). Never throws. */
  async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    const req = message as Partial<JsonRpcRequest>;
    const id = req?.id ?? null;
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    }
    if (req.method.startsWith("notifications/")) return null; // e.g. notifications/initialized
    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
          };
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
        case "tools/call": {
          const p = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
          const name = typeof p.name === "string" ? p.name : "";
          const args = (p.arguments && typeof p.arguments === "object" ? p.arguments : {}) as Record<string, unknown>;
          try {
            const result = await callTool(name, args);
            return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: toJsonText(result) }], structuredContent: JSON.parse(toJsonText(result)) } };
          } catch (error) {
            // Tool-level failures are results with isError (the agent reads the message), not protocol errors.
            const text = error instanceof Error ? error.message : String(error);
            return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
          }
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
      }
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
  }

  return { tools: TOOLS, handle, callTool };
}

/** Serve over stdio: one JSON-RPC message per line in, one per line out; diagnostics to stderr. */
export async function serveStdio(deps: McpDeps): Promise<void> {
  const mcp = createStrategyMcp(deps);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stderr.write(`bivium-mcp: ${SERVER_INFO.name} ${SERVER_INFO.version} on profile ${deps.profile.name} (read-only tools: ${TOOLS.map((t) => t.name).join(", ")})\n`);
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      continue;
    }
    const response = await mcp.handle(message);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }
}

/** Entry point: `bivium-mcp [--profile <path>]` (or BIVIUM_PROFILE). */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const i = argv.indexOf("--profile");
  const profilePath = (i >= 0 ? argv[i + 1] : undefined) ?? process.env.BIVIUM_PROFILE;
  if (!profilePath) {
    process.stderr.write("bivium-mcp: no profile — pass --profile <path> or set BIVIUM_PROFILE\n");
    process.exit(1);
  }
  const profile = loadProfile(profilePath);
  await serveStdio({ profile, client: new BiviumClient(profile) });
}

if (process.argv[1] && /server\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`bivium-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
