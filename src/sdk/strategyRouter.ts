// The client half of the StrategyRouter: read what a program will cost in fee, make sure the one grant it needs is
// in place, and send `execute(Leg[], deadline)`.
//
// The router acts for `msg.sender` and nobody else, so the only standing authority involved is the account's own
// grant of `CAP_FILL | CAP_WITHDRAW_COLLATERAL` on the core — the same shape the settler and the short router take.
// Ask-only programs (a paid limit buy, a short vol) need no grant at all: the router is the taker there, so
// `grantIfNeeded` is asked for it per program rather than assumed.
import { parseAbi } from "viem";
import { BiviumClient } from "./client.ts";
import type { Leg } from "./strategies/program.ts";
import { LEG_KIND } from "./strategies/program.ts";
import type { TxResult } from "./client.ts";
import type { Address, Hex } from "./types.ts";

export const CAP_FILL = 1n << 2n;
export const CAP_WITHDRAW_COLLATERAL = 1n << 3n;
/// What a program that borrows, repays or withdraws needs. An ask-only program needs none of it.
export const PROGRAM_CAPS = CAP_FILL | CAP_WITHDRAW_COLLATERAL;

const routerAbi = parseAbi([
  "struct Leg { uint8 kind; bytes data; }",
  "function execute(Leg[] program, uint256 deadline) returns (uint256[])",
  "function quoteLeg(uint256 units, uint256 cost) view returns (uint256 fee, uint256 principalAfterFee)",
  "function FEE_BPS() view returns (uint256)",
  "function LENDER_FEE_BPS() view returns (uint256)",
  "function FEE_RECIPIENT() view returns (address)",
  "function MAX_LEGS() view returns (uint256)",
]);

const grantAbi = parseAbi([
  "function grantOf(address authorizer, address authorized) view returns (uint256 capabilities, uint256 expiry)",
  "function grantAuthorization(address authorized, uint256 capabilities, uint256 expiry)",
]);

/// Does a program touch the account's own position? Only then is a grant involved.
export function programNeedsGrant(legs: readonly Leg[]): boolean {
  return legs.some((leg) => leg.kind !== LEG_KIND.FILL_ASK);
}

/// Whether a grant already covers a program: the bits are present and it has not expired (0 = perpetual).
export function grantCoversProgram(grant: { capabilities: bigint; expiry: bigint }, nowSec: bigint): boolean {
  if ((grant.capabilities & PROGRAM_CAPS) !== PROGRAM_CAPS) return false;
  return grant.expiry === 0n || nowSec <= grant.expiry;
}

export class StrategyRouterClient extends BiviumClient {
  constructor(
    profile: ConstructorParameters<typeof BiviumClient>[0],
    account: ConstructorParameters<typeof BiviumClient>[1],
    readonly router: Address,
  ) {
    super(profile, account);
  }

  /// One `eth_call`, for the pool reads a swap leg's floor is cut from.
  get ethCall(): (to: Address, data: Hex) => Promise<Hex> {
    return async (to, data) => (await this.pub.call({ to, data })).data ?? "0x";
  }

  feeBps(): Promise<bigint> {
    return this.pub.readContract({ address: this.router, abi: routerAbi, functionName: "FEE_BPS" }) as Promise<bigint>;
  }

  /// A missing getter on an older router or a failed RPC read is not evidence of a zero lender fee.
  async lenderFeeBps(): Promise<bigint> {
    try {
      return await this.pub.readContract({ address: this.router, abi: routerAbi, functionName: "LENDER_FEE_BPS" });
    } catch (cause) {
      throw new Error(
        `Cannot read LENDER_FEE_BPS from StrategyRouter ${this.router}; the router may be unsupported or the RPC unavailable. Verify a compatible router and RPC, then re-quote before executing; refusing to assume zero lender fee.`,
        { cause },
      );
    }
  }

  /// The router's own view of a bid leg's fee, so a caller can show the all-in number before signing.
  quoteLeg(units: bigint, cost: bigint): Promise<{ fee: bigint; principalAfterFee: bigint }> {
    return this.pub
      .readContract({ address: this.router, abi: routerAbi, functionName: "quoteLeg", args: [units, cost] })
      .then(([fee, principalAfterFee]) => ({ fee, principalAfterFee })) as Promise<{ fee: bigint; principalAfterFee: bigint }>;
  }

  grantOf(authorizer: Address): Promise<{ capabilities: bigint; expiry: bigint }> {
    return this.pub
      .readContract({ address: this.profile.core, abi: grantAbi, functionName: "grantOf", args: [authorizer, this.router] })
      .then(([capabilities, expiry]) => ({ capabilities, expiry })) as Promise<{ capabilities: bigint; expiry: bigint }>;
  }

  /// The one-time grant, with an expiry the caller chooses (0 = perpetual). Returns undefined when the account
  /// already has it — a grant is not re-sent just because a program was.
  async grantIfNeeded(expiry: bigint, nowSec: bigint): Promise<TxResult | undefined> {
    if (grantCoversProgram(await this.grantOf(this.account), nowSec)) return undefined;
    return await this.write({
      address: this.profile.core,
      abi: grantAbi,
      functionName: "grantAuthorization",
      args: [this.router, PROGRAM_CAPS, expiry],
    });
  }

  /// Approve exactly what a program may draw from the account, and no more: the router pulls a top-up or an ask's
  /// cost with `transferFrom`, and an exact allowance is what keeps a program from drawing past its own bounds.
  approveForProgram(token: Address, amount: bigint): Promise<TxResult> {
    return this.approveExact(token, this.router, amount);
  }

  execute(legs: readonly Leg[], deadline: bigint): Promise<TxResult> {
    return this.write({
      address: this.router,
      abi: routerAbi,
      functionName: "execute",
      args: [legs.map((leg) => ({ kind: leg.kind, data: leg.data })), deadline],
    });
  }
}
