import type { DeploymentProfile, MarketParams } from './types.ts';

const CORE = '0x2ff12244e430be82a8cdb13ee4faa31777bda9e4';
const MNVDA = '0xb0f5bb3028a46ab101b29a540e304ae3a5bbe877';
const BUSD = '0x628626de13dd4b5b1cb80d468c261c15df00d717';
const WAD_SQUARED = 10n ** 36n;
export type ReferenceTokens = Pick<MarketParams, 'loanToken' | 'collateralToken'>;
export interface MockReferenceMetadata {
  mock: true;
  source: string;
  /** Source observation and exclusive expiry, in Unix seconds. */
  observedAt: number;
  expiresAt: number;
}
export interface MockReference extends MockReferenceMetadata {
  mnvdaBusdWad: bigint;
  loanPerCollateralWad: bigint;
}

/** Addresses and deployment identity, never caller-provided ticker names, select this feed. */
export function mockReferenceDirection(profile: DeploymentProfile, tokens: Partial<ReferenceTokens>): 'direct' | 'inverse' | null {
  if (profile.chainId !== 46630 || profile.core.toLowerCase() !== CORE) return null;
  const loan = tokens.loanToken?.toLowerCase(), collateral = tokens.collateralToken?.toLowerCase();
  if (loan === BUSD && collateral === MNVDA) return 'direct';
  if (loan === MNVDA && collateral === BUSD) return 'inverse';
  return null;
}

/** A matching Mock domain fails closed: no alternate source or synthetic observation time. */
export async function fetchMockReference(profile: DeploymentProfile, tokens: ReferenceTokens): Promise<MockReference | null> {
  const direction = mockReferenceDirection(profile, tokens);
  if (!direction || !profile.relayerUrl) return null;
  const source = `${profile.relayerUrl.replace(/\/$/, '')}/mock-refill-spot`;
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || body.version !== 1 || body.pair !== 'MNVDA-BUSD' || body.mock !== true) return null;
    if (typeof body.mnvdaBusdWad !== 'string' || !/^[1-9][0-9]{0,77}$/.test(body.mnvdaBusdWad)) return null;
    const mnvdaBusdWad = BigInt(body.mnvdaBusdWad);
    if (mnvdaBusdWad >= 1n << 256n) return null;
    const observedAt = body.observedAt, now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now || now - observedAt >= 1800 || !Number.isSafeInteger(observedAt + 1800)) return null;
    const loanPerCollateralWad = direction === 'direct' ? mnvdaBusdWad : WAD_SQUARED / mnvdaBusdWad;
    if (loanPerCollateralWad <= 0n) return null;
    return { mock: true, source, observedAt, expiresAt: observedAt + 1800, mnvdaBusdWad, loanPerCollateralWad };
  } catch { return null; }
}
