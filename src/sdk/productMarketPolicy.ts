import type { Address } from './types.ts';

export interface ProductMarketStatus {
  delisted: boolean;
  matured: boolean;
  newBusiness: boolean;
  reasons: Array<'delisted' | 'matured'>;
}
type Domain = { chainId: number; core: Address };
type Market = { loanToken: Address; collateralToken: Address; maturity: bigint };
export function productMarketStatus(domain: Domain, params: Market, now: bigint = BigInt(Math.floor(Date.now() / 1000))): ProductMarketStatus {
  const delisted = domain.chainId === 46630
    && domain.core.toLowerCase() === '0x2ff12244e430be82a8cdb13ee4faa31777bda9e4'
    && [params.loanToken, params.collateralToken].some(token => token.toLowerCase() === '0x34a456c0365b78c5e04b97dee228207cf9cab35d');
  const matured = params.maturity <= now;
  return { delisted, matured, newBusiness: !delisted && !matured, reasons: [...(delisted ? ['delisted' as const] : []), ...(matured ? ['matured' as const] : [])] };
}
export function assertNewBusinessMarket(domain: Domain, params: Market, now?: bigint): void {
  const status = productMarketStatus(domain, params, now);
  if (!status.newBusiness) throw new Error(`PRODUCT_MARKET_POLICY: new business unavailable (${status.reasons.join(', ')})`);
}
