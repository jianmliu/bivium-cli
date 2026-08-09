// In-process signed-offer relayer stub — a faithful node:http implementation of the wire protocol
// observed in the frontend's functions/api/offers.ts (GET query = full market identity, POST
// {offer, signature} with EIP-712 Ratify verification, DELETE with the EIP-191
// `bivium-cancel:<commitment>` signature). Used by test/relayer.test.ts and the anvil e2e run;
// NEVER a production server.
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { getAddress, recoverAddress, recoverMessageAddress } from "viem";
import { adapterFor } from "../../src/sdk/lineage.ts";
import { offerFromJson } from "../../src/sdk/offer.ts";
import { ratifyDigest } from "../../src/sdk/ratify.ts";
import { cancelMessage } from "../../src/sdk/relayer.ts";
import type { Address, Hex } from "../../src/sdk/types.ts";

export interface StubRow {
  offer: Record<string, string | boolean>;
  signature: string;
  commitment: string;
  available?: string;
}

export interface RelayerStub {
  url: string;
  rows: StubRow[];
  /** Failure injection for client fail-closed tests. */
  mode: "ok" | "http500" | "not-array";
  close(): Promise<void>;
}

const IDENTITY_FIELDS = [
  "chainId",
  "bivium",
  "loanToken",
  "collateralToken",
  "maturity",
  "strike",
  "allowPartialRepay",
  "gate",
  "ratifier",
] as const;

const lc = (v: unknown) => String(v).toLowerCase();

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function startRelayerStub(opts: { chainId: number; core: Address; port?: number }): Promise<RelayerStub> {
  const { chainId } = opts;
  const core = getAddress(opts.core) as Address;
  const adapter = adapterFor("core-v2");
  const domain = { chainId, core };
  const rows: StubRow[] = [];
  const stub: RelayerStub = { url: "", rows, mode: "ok", close: async () => {} };

  /** Wire 17-field offer → economic 15-field Offer, or null when structurally invalid. */
  const reviveWire = (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return null;
    const { chainId: wireChain, bivium, ...rest } = raw as Record<string, unknown>;
    if (String(wireChain) !== String(chainId) || lc(bivium) !== lc(core)) return null;
    try {
      return offerFromJson(rest);
    } catch {
      return null;
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (stub.mode === "http500") return respond(500, { error: "injected failure" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.endsWith("/offers")) return respond(404, { error: "not found" });

      if (req.method === "GET") {
        if (stub.mode === "not-array") return respond(200, { unexpected: true });
        for (const f of IDENTITY_FIELDS) {
          if (!url.searchParams.get(f)) return respond(400, { error: "complete valid market identity required" });
        }
        if (url.searchParams.get("chainId") !== String(chainId) || lc(url.searchParams.get("bivium")) !== lc(core)) {
          return respond(200, []);
        }
        const matches = rows.filter((row) =>
          IDENTITY_FIELDS.every((f) => f === "ratifier"
            ? lc(row.offer.ratifier) === lc(url.searchParams.get("ratifier"))
            : lc(row.offer[f]) === lc(url.searchParams.get(f))),
        );
        return respond(200, matches.map((r) => ({
          ...r,
          available: String(r.offer.maxAssets === "0" ? r.offer.maxUnits : r.offer.maxAssets),
        })));
      }

      if (req.method === "POST") {
        const body = (await readBody(req)) as { offer?: unknown; signature?: unknown } | null;
        if (!body?.offer || !body?.signature) return respond(400, { error: "missing offer/signature" });
        const offer = reviveWire(body.offer);
        if (!offer) return respond(400, { error: "malformed offer" });
        if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
          return respond(400, { error: "malformed signature" });
        }
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        if (offer.expiry <= nowSec) return respond(400, { error: "offer expired" });
        if (offer.expiry > offer.maturity - 3_600n) {
          return respond(400, { error: "offer must expire at least one hour before market maturity" });
        }
        const commitment = adapter.offerCommitment(domain, offer);
        let signer: Address;
        try {
          signer = await recoverAddress({
            hash: ratifyDigest(chainId, offer.ratifier, commitment),
            signature: body.signature as Hex,
          });
        } catch {
          return respond(400, { error: "signature recovery failed" });
        }
        if (lc(signer) !== lc(offer.maker)) return respond(401, { error: "signer is neither the maker nor a registered signer" });
        const stored = { offer: body.offer as StubRow["offer"], signature: body.signature, commitment };
        const existing = rows.findIndex((r) => lc(r.commitment) === lc(commitment));
        if (existing >= 0) rows[existing] = stored;
        else rows.push(stored);
        return respond(200, { ok: true, commitment });
      }

      if (req.method === "DELETE") {
        const body = (await readBody(req)) as { commitment?: unknown; signature?: unknown; offer?: unknown } | null;
        const commitment = typeof body?.commitment === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.commitment) ? body.commitment : null;
        const signature = typeof body?.signature === "string" && /^0x[0-9a-fA-F]+$/.test(body.signature) ? body.signature : null;
        const offered = body?.offer ? reviveWire(body.offer) : null;
        if (!commitment || !signature || !offered || lc(adapter.offerCommitment(domain, offered)) !== lc(commitment)) {
          return respond(400, { error: "missing or invalid commitment/signature/offer" });
        }
        const index = rows.findIndex((r) => lc(r.commitment) === lc(commitment));
        if (index < 0) return respond(404, { error: "unknown commitment" });
        let signer: Address | null = null;
        try {
          signer = await recoverMessageAddress({ message: cancelMessage(commitment as Hex), signature: signature as Hex });
        } catch {
          signer = null;
        }
        if (!signer || lc(signer) !== lc(rows[index].offer.maker)) {
          return respond(401, { error: "cancel signer is not the order's maker" });
        }
        rows.splice(index, 1);
        return respond(200, { ok: true, removed: 1 });
      }

      return respond(405, { error: "method not allowed" });
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub internal error" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub did not bind a TCP port");
  stub.url = `http://127.0.0.1:${address.port}`;
  stub.close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return stub;
}

// Standalone mode for the anvil e2e transcript: tsx test/helpers/relayer-stub.ts <chainId> <core> [port]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [chainId, core, port] = process.argv.slice(2);
  if (!chainId || !core) {
    console.error("usage: tsx test/helpers/relayer-stub.ts <chainId> <core> [port]");
    process.exit(1);
  }
  const stub = await startRelayerStub({ chainId: Number(chainId), core: core as Address, port: port ? Number(port) : 0 });
  console.log(`relayer stub listening at ${stub.url} (chain ${chainId}, core ${core})`);
}
