// Signed-offer relayer client — speaks the wire protocol of the frontend's Cloudflare relayer
// (functions/api/offers.ts): 17-field domain-bound offers with every bigint as a decimal string.
//
//   GET    /offers?chainId&bivium&loanToken&collateralToken&maturity&strike&allowPartialRepay&gate&ratifier
//          → [{ offer, signature, commitment, available }]
//   POST   /offers  { offer, signature, commitment }
//   DELETE /offers  { commitment, signature: EIP-191("bivium-cancel:<commitment>"), offer }
//
// The relayer is custody-free and off the fund-critical path — `core.fill` re-checks every
// economic invariant on-chain — so a bad relayer can only censor or mis-rank, never move funds.
// The client still fails CLOSED on parsing: any malformed row poisons the whole response
// ({ok:false}), and {ok:false, reason} (relayer down) is kept distinct from {ok:true, offers:[]}
// (a healthy but empty book).
import { getAddress, isAddress } from "viem";
import { adapterFor, type ChainDomain } from "./lineage.ts";
import { entryFromSignedOffer, offerActiveAt, type BookEntry } from "./orderbook.ts";
import { MAX_TICK, TICK_SPACING } from "./tick.ts";
import type { Address, Hex, MarketParams, Offer } from "./types.ts";

/** Everything the relayer client needs from a profile. */
export interface RelayerDomain {
  chainId: number;
  core: Address;
  abiProfile: "core-v1" | "core-v2";
  signatureRatifier: Address;
  /** The ratifier this book is keyed by. Omit to key by `signatureRatifier` (the pre-setter default). */
  ratifier?: Address;
  relayerUrl: string;
}

export type RelayerBookResult = { ok: true; entries: BookEntry[] } | { ok: false; reason: string };

/** The wire protocol carries 17-field domain-bound offers — only the core-v2 lineage has them. */
export function requireRelayerV2(abiProfile: "core-v1" | "core-v2"): void {
  if (abiProfile !== "core-v2") {
    throw new Error(
      `relayer wire protocol is 17-field domain-bound (core-v2); profile is ${abiProfile} — refusing`,
    );
  }
}

/** Serialize an offer into the 17-field wire shape (bigints as decimal strings, domain first). */
export function wireOffer(domain: ChainDomain, offer: Offer): Record<string, string | boolean> {
  return {
    chainId: BigInt(domain.chainId).toString(),
    bivium: domain.core,
    loanToken: offer.loanToken,
    collateralToken: offer.collateralToken,
    maturity: offer.maturity.toString(),
    strike: offer.strike.toString(),
    allowPartialRepay: offer.allowPartialRepay,
    gate: offer.gate,
    maker: offer.maker,
    buy: offer.buy,
    tick: offer.tick.toString(),
    maxUnits: offer.maxUnits.toString(),
    maxAssets: offer.maxAssets.toString(),
    start: offer.start.toString(),
    expiry: offer.expiry.toString(),
    group: offer.group,
    ratifier: offer.ratifier,
  };
}

/** The EIP-191 message a maker signs to delist an order (matches the relayer's _offerVerify). */
export function cancelMessage(commitment: Hex): string {
  return `bivium-cancel:${commitment.toLowerCase()}`;
}

const offersUrl = (relayerUrl: string) => `${relayerUrl.replace(/\/$/, "")}/offers`;

const U256_MAX = (1n << 256n) - 1n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviveAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value, { strict: false }) ? (getAddress(value) as Address) : null;
}

function reviveUint(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const revived = BigInt(value);
  return revived <= U256_MAX ? revived : null;
}

const isBytes32 = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isSignature = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Strict field-by-field revival of one relayer row into a BookEntry. Returns null on ANY
 * deviation: bad types, market-identity mismatch with the requested market, structural
 * violations, or an embedded commitment that does not equal the one recomputed from the offer
 * fields via the profile's lineage adapter (the embedded value is untrusted).
 */
function reviveRow(raw: unknown, domain: RelayerDomain, params: MarketParams): BookEntry | null {
  if (!isRecord(raw) || !isRecord(raw.offer)) return null;
  const s = raw.offer;

  const chainId = reviveUint(s.chainId);
  const bivium = reviveAddress(s.bivium);
  const loanToken = reviveAddress(s.loanToken);
  const collateralToken = reviveAddress(s.collateralToken);
  const gate = reviveAddress(s.gate);
  const maker = reviveAddress(s.maker);
  const ratifier = reviveAddress(s.ratifier);
  if (
    chainId === null || chainId === 0n || bivium === null || loanToken === null ||
    collateralToken === null || gate === null || maker === null || ratifier === null ||
    typeof s.allowPartialRepay !== "boolean" || typeof s.buy !== "boolean" ||
    !isBytes32(s.group) || !isSignature(raw.signature) || !isBytes32(raw.commitment)
  ) {
    return null;
  }

  const maturity = reviveUint(s.maturity);
  const strike = reviveUint(s.strike);
  const tick = reviveUint(s.tick);
  const maxUnits = reviveUint(s.maxUnits);
  const maxAssets = reviveUint(s.maxAssets);
  const start = reviveUint(s.start);
  const expiry = reviveUint(s.expiry);
  if (
    maturity === null || strike === null || tick === null || maxUnits === null ||
    maxAssets === null || start === null || expiry === null
  ) {
    return null;
  }

  // Market identity: the row must be FOR the requested market (incl. the domain and ratifier).
  if (
    chainId !== BigInt(domain.chainId) ||
    !sameAddress(bivium, domain.core) ||
    !sameAddress(loanToken, params.loanToken) ||
    !sameAddress(collateralToken, params.collateralToken) ||
    maturity !== params.maturity ||
    strike !== params.strike ||
    s.allowPartialRepay !== params.allowPartialRepay ||
    !sameAddress(gate, params.gate) ||
    !sameAddress(ratifier, domain.ratifier ?? domain.signatureRatifier)
  ) {
    return null;
  }

  // Structural invariants the core/relayer enforce.
  if (
    (maxUnits === 0n) === (maxAssets === 0n) ||
    tick > MAX_TICK ||
    tick % TICK_SPACING !== 0n ||
    start > expiry ||
    expiry > maturity - 3_600n
  ) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "available") && reviveUint(raw.available) === null) {
    return null;
  }

  const offer: Offer = {
    loanToken,
    collateralToken,
    maturity,
    strike,
    allowPartialRepay: s.allowPartialRepay,
    gate,
    maker,
    buy: s.buy,
    tick,
    maxUnits,
    maxAssets,
    start,
    expiry,
    group: s.group,
    ratifier,
  };
  const commitment = adapterFor(domain.abiProfile).offerCommitment(
    { chainId: domain.chainId, core: domain.core },
    offer,
  );
  if (commitment.toLowerCase() !== raw.commitment.toLowerCase()) return null;
  return entryFromSignedOffer(offer, commitment, raw.signature);
}

/**
 * GET the resting signed book for one market. `{ok:false, reason}` = the relayer itself is
 * unreachable/erroring or served a poisoned batch — NOT an empty book; callers must not treat it
 * as one.
 */
export async function fetchRelayerBook(
  domain: RelayerDomain,
  params: MarketParams,
  { timeoutMs = 8_000, nowSec = BigInt(Math.floor(Date.now() / 1000)) }: { timeoutMs?: number; nowSec?: bigint } = {},
): Promise<RelayerBookResult> {
  requireRelayerV2(domain.abiProfile);
  const q = new URLSearchParams({
    chainId: String(domain.chainId),
    bivium: domain.core,
    loanToken: params.loanToken,
    collateralToken: params.collateralToken,
    maturity: params.maturity.toString(),
    strike: params.strike.toString(),
    allowPartialRepay: String(params.allowPartialRepay),
    gate: params.gate,
    ratifier: domain.ratifier ?? domain.signatureRatifier,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${offersUrl(domain.relayerUrl)}?${q}`, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `relayer responded ${res.status}` };
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return { ok: false, reason: "relayer response is not an offer array" };
    const entries: BookEntry[] = [];
    for (const row of raw) {
      const entry = reviveRow(row, domain, params);
      // One bad row poisons the WHOLE batch: a relayer that serves garbage cannot be trusted to
      // have served the good rows completely either.
      if (entry === null) return { ok: false, reason: "relayer served a malformed or mismatched row" };
      if (!offerActiveAt(entry.offer, nowSec)) continue;
      entries.push(entry);
    }
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, reason: `relayer unreachable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

/** POST a signed offer to the relayer. Throws with the server's error on rejection. */
export async function publishSignedOffer(
  domain: RelayerDomain,
  offer: Offer,
  signature: Hex,
  { timeoutMs = 8_000 }: { timeoutMs?: number } = {},
): Promise<{ commitment: Hex }> {
  requireRelayerV2(domain.abiProfile);
  const chainDomain: ChainDomain = { chainId: domain.chainId, core: domain.core };
  const commitment = adapterFor(domain.abiProfile).offerCommitment(chainDomain, offer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(offersUrl(domain.relayerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: wireOffer(chainDomain, offer), signature, commitment }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`relayer rejected offer (${res.status}): ${typeof body.error === "string" ? body.error : "unknown error"}`);
    }
    return { commitment };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * DELETE the maker's own order from the relayer book. `cancelSignature` is an EIP-191
 * personal_sign over `cancelMessage(commitment)` by the maker key. Throws on rejection — callers
 * that treat the relayer as advisory (on-chain cancel is the authority) catch and warn.
 */
export async function deleteSignedOffer(
  domain: RelayerDomain,
  offer: Offer,
  commitment: Hex,
  cancelSignature: Hex,
  { timeoutMs = 8_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  requireRelayerV2(domain.abiProfile);
  const chainDomain: ChainDomain = { chainId: domain.chainId, core: domain.core };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(offersUrl(domain.relayerUrl), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitment, signature: cancelSignature, offer: wireOffer(chainDomain, offer) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`relayer refused delist (${res.status}): ${typeof body.error === "string" ? body.error : "unknown error"}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
