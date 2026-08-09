# Bivium CLI + SDK Design

**Status:** approved for implementation
**Date:** 2026-08-09
**Origin:** distilled from the manual `cast`-driven WBTC market lifecycle executed against the Sepolia
multi-loan candidate core (`0x344BA9909d952D0d404f37Cc9C93c40A35F35c07`) on 2026-08-09: deploy mock
collateral → fund maker liquidity → sign a resting bid → borrower fill → repay → reclaim collateral.
Every numeric assertion in the SDK test suite is a golden vector confirmed by that on-chain run.

## Problem

The only ways to exercise a Bivium market today are the frontend UI and ad-hoc `cast` incantations.
The UI is coupled to one ABI lineage and one deployment at build time; `cast` incantations are
error-prone exactly where Bivium is least forgiving (offer tuple encoding, EIP-712 ratification
digests, strike/principal/collateral rounding). During the 2026-08-09 session the live preview UI was
ABI-incompatible with the live core (17-field domain-bound offers vs the deployed 15-field core), and
the only working path was hand-built calldata. That path should be a supported, tested tool — for
operators seeding markets, acceptance runners, and agents driving testnet flows.

## Goals

- A TypeScript SDK (`src/sdk`) that encodes the full market lifecycle with **exact integer math**
  mirroring core rounding, usable as a library by scripts, solvers, and the CLI.
- A thin CLI (`bivium <noun> <verb>`) over the SDK covering the proven lifecycle:
  market identity/state, maker funding + offer signing, borrower quote/fill, repay, reclaim, claim,
  and mock-token minting for testnets.
- **Deployment-profile pinning**: every invocation is scoped to a profile file that pins
  `{chainId, core, signatureRatifier, rpcUrl, abiProfile}`. The SDK refuses to run against a core
  whose ABI lineage does not match the profile (fail closed, verified on-chain).

## Non-goals

- No relayer publication (the live relayer speaks the domain-bound 17-field schema; this tool's
  `core-v1` profile targets the 15-field lineage — offers are exchanged as signed JSON files).
- No support for manager pools, RFQ intent routers, vaults, or JIT funding (script lanes exist in
  their own repos).
- No mainnet warnings silenced: mock-token commands refuse to run when the profile does not mark the
  token `mintable`.
- No custody: the CLI signs with a locally provided key and never persists or logs it.

## ABI profiles

The Bivium core has two live ABI lineages:

| Profile | MarketParams | Offer | computeId input | Example deployment |
|---|---|---|---|---|
| `core-v1` | 6 fields | 15 fields | 6-field tuple | Sepolia multi-loan candidate `0x344BA9…` (vendored pin `a9372d4`) |
| `core-v2` | 8 fields (`chainId`, `bivium` prefixed) | 17 fields | 8-field tuple | Sepolia Router V3 core `0x3d6083…` (bivium-core `origin/dev` lineage) |

Both lineages are implemented behind a single adapter boundary (`src/sdk/lineage.ts`); everything
above it speaks the 6 economic market fields and the adapter injects the profile's `{chainId, core}`
domain where the lineage requires it. The profile loader rejects unknown values, and `BiviumClient.verifyProfile()`
calls the on-chain `computeId` with a canary tuple and requires it to equal the SDK's local hash —
a wrong-lineage core reverts (missing selector) or mismatches, and every write path refuses to start.
This check exists because the failure it guards against actually happened (see Origin).

## Deployment profile file

```json
{
  "name": "sepolia-multiloan-v1",
  "abiProfile": "core-v1",
  "chainId": 11155111,
  "core": "0x344BA9909d952D0d404f37Cc9C93c40A35F35c07",
  "signatureRatifier": "0x0cE9bA63a31f3252aF9918E0Fe7DF0c4745f3323",
  "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
  "tokens": {
    "USDC": { "address": "0x1DbF8Dee40739cd2b17C12EC63A67499F9796278", "decimals": 6,  "mintable": true },
    "GHO":  { "address": "0x84b610ea0b055A6aD8475543C0A53fC9b66c0919", "decimals": 18, "mintable": true },
    "WETH": { "address": "0x8E87161d2827613FE129daF8FA330460F95d629C", "decimals": 18, "mintable": true },
    "WBTC": { "address": "0x822c57AEf2766ddd9aA570B53bF2917f0cF07761", "decimals": 8,  "mintable": true }
  }
}
```

Rules: addresses are normalized to EIP-55 checksums at load; `tokens` is an allowlist for symbol
resolution and the *only* thing that authorizes `mock mint`; token `decimals` are cross-checked
against on-chain `decimals()` before any write that uses them.

## CLI surface

Global flags: `--profile <path>` (or `BIVIUM_PROFILE` env), `--key-env <NAME>` (env var holding the
signing key, default `BIVIUM_PK`; keys are never accepted as argv), `--json` (machine output).

Market identity comes from either `--offer <file>` (params embedded in a signed offer) or explicit
flags: `--loan <symbol|addr> --collateral <symbol|addr> --maturity <unix> (--floor <human price> |
--strike <raw>) [--allow-partial] [--gate <addr>]`.

```
bivium market id        # compute + print the market id (also cross-checks on-chain computeId)
bivium market state     # MarketState (touched/activeCredit/repaidCredit/activeCollateral/claimedCredit)
bivium read position   --account <addr>
bivium read credit     --account <addr>
bivium read liquidity  --account <addr>

bivium maker set-ratifier [--off]      # register/unregister the profile's SignatureRatifier
bivium maker fund       --assets <human>          # approve-exact + fund (lender escrow)
bivium maker withdraw-liquidity --assets <human> [--receiver <addr>]
bivium maker make-offer --side buy|sell (--tick <n> | --apr-bps <n>) --max-units <human>
                        [--ttl <seconds>] [--out <file>]
    # builds the 15-field offer, EIP-712-signs Ratify(commitment) against the profile ratifier,
    # verifies RATIFIED via eth_call, writes {offer, signature, commitment} JSON

bivium offer status     --offer <file>   # window, consumed/cap, maker liquidity, RATIFIED precheck

bivium borrow quote     --offer <file> [--units <human>]
    # price (WAD + human), principal (floor), required collateral (ceil), implied simple APR
bivium borrow execute   --offer <file> --units <human> [--receiver <addr>]
    # preflight (quote + all offer-status checks) → approve-exact collateral → simulate → fill
    # → verify received principal equals the quote exactly

bivium repay            (--offer <file> | market flags) --assets <human>
bivium reclaim          (--offer <file> | market flags) [--receiver <addr>]   # withdrawCollateral
bivium claim            (--offer <file> | market flags) --units <human> [--receiver <addr>]

bivium mock mint        --token <symbol|addr> --to <addr> --amount <human>   # profile-gated
```

## Safety invariants (all enforced in the SDK, not the CLI)

1. **No floats touch identity or money.** Strikes, amounts, prices, and ticks are BigInt end to end;
   human decimal inputs are parsed exactly and rejected if they need more precision than the token has
   (`60000` × 1e34 → strike, never `Math.round`). The float-seeded inverse tick lookup is corrected
   against the exact forward map before use (port of the frontend's drift insurance).
2. **Core rounding is mirrored, not approximated.** `principal = ⌊units·price/1e18⌋`,
   `collateral = ⌈debt·1e36/strike⌉` — pinned by golden vectors from the live run
   (600 face @ tick 3936 → 596.425814 USDC, 0.01 WBTC).
3. **Simulate before send.** Every write runs `eth_call` simulation first so custom errors surface
   with names instead of gas-estimation noise.
4. **Exact allowances.** Approvals are for the precise amount of the action, never unlimited.
5. **Post-conditions are balance deltas.** `borrow execute` and `maker fund` verify the recipient's
   balance moved by exactly the predicted amount, in the spirit of core's exact-transfer accounting.
6. **Ratification is prechecked.** An offer is only written/accepted if the profile ratifier returns
   the `RATIFIED` magic (`keccak256("bivium.ratifier.ratified")`) for its commitment via `eth_call`.
7. **Keys via env indirection or 0600 files only**; never argv, never logged, never echoed in errors.

## Offer interchange format

`maker make-offer` output (all bigints as decimal strings; addresses checksummed):

```json
{
  "schemaVersion": 1,
  "abiProfile": "core-v1",
  "chainId": 11155111,
  "core": "0x344BA9…",
  "offer": { "loanToken": "0x…", "collateralToken": "0x…", "maturity": "1788828951",
             "strike": "6…0", "allowPartialRepay": false, "gate": "0x0…0", "maker": "0x…",
             "buy": true, "tick": "3936", "maxUnits": "600000000", "maxAssets": "0",
             "start": "…", "expiry": "…", "group": "0x…", "ratifier": "0x…" },
  "commitment": "0x…",
  "signature": "0x…"
}
```

Consumers must recompute the commitment from the offer fields and reject on mismatch, and must check
`chainId`/`core`/`abiProfile` against their own profile before use (the file is portable; the
authority is the chain).

## Acceptance

- `npm test` green: golden vectors for tick→price (3936 → 994043024418464930), market ids
  (WETH/USDC `0x8f8e4fee…`, WBTC/USDC `0x1d707a46…`), offer commitment (`0xcc0e619e…`),
  ratify digest (`0xa7652332…`), principal/collateral rounding, exact decimal parsing.
- Read-only smoke against the live profile: `market id` cross-check passes, `market state` renders
  the WBTC market's post-repay state (`repaidCredit = 600000000`).
- A full testnet lifecycle (fund → make-offer → borrow → repay → reclaim) reproduces the 2026-08-09
  session using only `bivium` commands.

## TBV (whole vault) extension

Drives one deployed TBV family — `TBVVaultFactory` / `TBVVault1155` / `TBVCollateralManager` /
`TBVCollateralReceipt` + a redemption implementation — against the domain-bound core-v2 lineage.
The profile grows an optional `tbv` section
(`{factory, manager, receipt, vaultToken, keeper, redemption, redemptionAsset}`, all validated
addresses); TBV commands fail cleanly when it is absent, and every TBV write first runs
`verifyTbv()`: the section must equal the manager's own immutable bindings and the manager's frozen
`BORROW_AUTHORIZATION_TYPEHASH` must equal the SDK's locally recomputed typed-data hash
(`0x6f35331f5a3a01fe3ed68b1169936085c630eee7fb0e4d875643494c1ed74084`).

### Command group

```
tbv create-vault --token-id <n> --amount <units> [--receiver <addr>]
tbv vault-status --token-id <n>
tbv fund --token-id <n> --gate <addr> [--maturity <unix>] [--strike <raw>]
tbv cancel-funding --token-id <n>
tbv borrow --token-id <n> --offer <file> [--deadline <s>]
tbv repay --token-id <n>
tbv redeem-delivered --position-id <bytes32>
```

- `create-vault` runs the testnet redemption's issuer-only `approveCreation` then
  `factory.createVault` with empty creationData; the signing key must be the redemption issuer
  (the deployer on the local stack). Vault token ids and amounts are raw unitless integers.
- `fund` reads the market entirely from the canonical gate (`CHAIN_ID/BIVIUM/LOAN_TOKEN/
  COLLATERAL_TOKEN/MATURITY/STRIKE/MARKET_ID`), cross-checks the SDK's market hash against the
  gate's `MARKET_ID` and the factory's `isCanonicalGate`, reads `expectedFundingNonce` from the
  chain, and pre-validates the whole-lot quote (`tbvQuote` mirrors `TBVMath.quote`, including the
  ceil-inverse round-trip check). Optional `--maturity/--strike` flags are cross-checks only.
- `borrow` takes a standard signed-offer file. The manager constrains the offer: it must be a
  resting BUY bid whose maker is the family's KEEPER role and whose market prefix equals the funded
  market. The CLI rebuilds the `BorrowAuthorization` from the live on-chain `VaultPosition`
  (amount/receiptAmount/positionAccount/marketId/fundingNonce, `face` = the exact maximum face),
  signs it with the borrower key, and submits `manager.borrow(auth, sig, offer, ratifierData)`.
  Postcondition: the borrower's loan-token delta equals the locally quoted principal exactly.
- `repay` approves the exact face to the manager and calls `manager.repay`; postconditions require
  the complete vault back in the owner's ERC-1155 balance and state `Repaid`.
- `redeem-delivered` releases one defaulted vault to the keeper by its
  `keccak256(abi.encode(token, tokenId, fundingNonce))` position id.

### BorrowAuthorization signing model

EIP-712 with the SignatureRatifier's minimal domain — `EIP712Domain(uint256 chainId,address
verifyingContract)`, verifyingContract = the manager, no name/version — over the 15-field frozen
struct `BorrowAuthorization(uint256 chainId,address manager,address bivium,address token,uint256
tokenId,uint256 amount,uint256 receiptAmount,address positionAccount,bytes32 marketId,uint256
fundingNonce,uint256 face,bytes32 offerCommitment,address borrower,uint256 deadline,uint256
intentNonce)`. The manager only accepts a signature from the vault's original owner, the fields are
all pinned to the live position (any cancel bumps `fundingNonce` and invalidates every outstanding
authorization), `offerCommitment` binds the exact keeper bid (`hashOffer`), and `intentNonce` is
single-use per borrower. Before signing, the SDK cross-checks its local digest against
`manager.borrowAuthorizationDigest(auth)` and refuses on mismatch.

### Local-anvil acceptance

`script/DeployTBVLocal.s.sol` (bivium-core worktree) deploys core + SignatureRatifier + 6-decimal
mock USDC, then redemption → exposure asset → receipt → factory (→ vault token) → manager in the
canonical `vm.computeCreateAddress` order, then one `createMarketGate(31337, USDC, now+30d, 1e42)`
— strike 1e42 = 1.000000 USDC face per whole vault unit, so whole-lot math is exact. Fresh anvil +
account 0 as deployer gives the stable addresses pinned in `profiles/anvil-tbv-local.json`; the
KEEPER role is account 0 itself (the maker EOA), the redemption issuer is the deployer. The
recorded acceptance run uses only `bivium` commands: maker `mock mint` → `maker set-ratifier` →
`maker fund` (gated market) → `maker make-offer --gate …` → `tbv create-vault` (receiver = account
1) → borrower `tbv fund` → `tbv borrow` (received 99.182134 USDC for 100 face at tick 3872) →
`tbv repay` (exact 100 face) → `tbv vault-status` shows `Repaid`, fundingNonce bumped to 1, and
the complete vault back in the owner's balance. `test/tbv.test.ts` pins the typehash, a
chain-verified BorrowAuthorization digest, positionId hashes, and the whole-lot quote math as
offline golden vectors.

## DCN trading extension (2026-08-10)

Secondary trading of existing credit (DCN) against resting signed offers, layered on the same
lineage-adapter/profile discipline. New SDK modules: `orderbook.ts` (pure BigInt book math),
`relayer.ts` (wire client), `trade.ts` (`TradeClient extends BiviumClient`).

### Command group

```
book list   [market flags] [--depth N] (--source files --dir <path> | --source relayer)
trade buy   [market flags] (--units X | --spend Y [--exact-spend]) [--limit-tick N] [--dry-run] (--source …)
trade sell  [market flags] --units X [--limit-tick N] [--dry-run] (--source …)
order list  --maker <addr> [market flags] (--source …)
order cancel --offer <file>
maker make-offer … [--publish]
```

Book sources: `files` loads every `*.json` SignedOfferFile in `--dir` (each strictly validated by
`parseSignedOfferFile` against the profile; other-market files skipped); `relayer` GETs
`profile.relayerUrl` (new OPTIONAL profile field, http(s)-validated). Both are then reconciled
against the core's `consumed` counters before display/planning — an unreadable counter fails the
whole batch closed (`reconcileConsumedEntries`).

### Sweep semantics

A market order is planned off-chain (`planSweepByFace` / `planSweepBySpend` / `planExactSpend`,
frontend-pinned vectors) and executed as ONE core `multicall` of encoded `fill` calls, so a
multi-level sweep is atomic. Cost rounding is BY MAKER DIRECTION, mirroring `_fill`: maker-buy
bids floor (`units·price/WAD`), maker-sell asks ceil. `--limit-tick` is the slippage bound —
higher tick = higher price, so a buy keeps `tick ≤ limit` and a sell keeps `tick ≥ limit`.

Preflight per fill: `[start, expiry]` window against the chain block time, SelfDeal
(taker ≠ maker), `isRatifier` + `isRatified == RATIFIED`, and side-specific solvency:

- **buy (take asks)**: a resting ask can only TRANSFER the maker's existing credit — `_moveClaim`
  reverts `OnlyTakerMayBorrow` if the maker's balance would cross zero — so the client prechecks
  `creditOf(maker) ≥ Σ planned units` per maker, approves the exact total cost, and postconditions
  `creditOf` delta == +units and loan-token delta == −cost.
- **sell (take bids)**: proceeds come from the bid maker's pre-funded `liquidityOf` (prechecked
  per maker). **Maturity nuance**: a pure secondary transfer of existing credit is legal at/after
  maturity — `MaturityPassed` only guards the origination branch — so the borrow-path matured
  guard is deliberately NOT reused; the client instead requires `creditOf(taker) ≥ units` so the
  fill can never slip into new-debt origination, and approves no collateral. Postconditions:
  credit delta == −units, loan delta == +proceeds.

`order cancel` = on-chain `setConsumed(group, offerCap, maker)` (cap = `maxAssets` when
assets-capped else `maxUnits`; the authority — kills the signature forever, only the maker key may
run it) + relayer DELETE when configured. A relayer delist failure is a warning, never an error.

### Relayer wire protocol + fail-closed rules

core-v2 ONLY (17-field domain-bound offers; `requireRelayerV2` rejects v1 profiles with a clear
error). GET query = full market identity incl. `chainId`/`bivium` + `ratifier`; POST body
`{offer, signature, commitment}` with bigints as decimal strings; DELETE body
`{commitment, signature, offer}` where the signature is EIP-191 over
`bivium-cancel:<lowercase commitment>` by the maker (the public Ratify signature cannot
authenticate a cancel).

Client-side revival is strict: every field type-checked, structural invariants enforced
(units-xor-assets cap, tick grid, `start ≤ expiry ≤ maturity − 1h`), market identity must equal
the requested market, and the commitment is RECOMPUTED via the profile's lineage adapter and must
match the embedded one. Any bad row → the WHOLE response is `{ok:false, reason}`; expired-window
offers are merely skipped. `{ok:false}` (relayer down/poisoned) is kept distinct from
`{ok:true, offers:[]}` (healthy empty book); the CLI renders the former as
"relayer unavailable — not an empty book" and exits 1. Tests drive the client against an
in-process `node:http` stub (`test/helpers/relayer-stub.ts`) implementing the observed protocol,
including commitment-tamper poisoning and cancel-signer auth; the same stub backs the recorded
anvil e2e (`--publish` → `book list --source relayer` → `order cancel` delist → stub down →
loud failure).
