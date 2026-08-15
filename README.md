# @bivium/cli

SDK + CLI for driving a Bivium market lifecycle from the command line — market identity, maker
funding and offer signing, borrower quote/fill, repay, reclaim, and claim. Distilled from the
2026-08-09 manual `cast` run against the Sepolia multi-loan candidate core; the test suite pins that
run's chain-verified values as golden vectors.

Design: [docs/spec/2026-08-09-bivium-cli-spec.md](docs/spec/2026-08-09-bivium-cli-spec.md)

## Install / test

```bash
npm install
npm test
```

## Quick start (Sepolia multi-loan candidate)

```bash
export BIVIUM_PROFILE=profiles/sepolia-multiloan-v1.json
export BIVIUM_PK=0x...            # signing key, via env only — never argv

# market identity (cross-checked against on-chain computeId)
npm run cli -- market id --loan USDC --collateral WBTC --maturity 1788828951 --floor 60000

# maker: register ratifier, fund, sign a resting bid at 10% APR
npm run cli -- maker set-ratifier
npm run cli -- maker fund --loan USDC --collateral WBTC --maturity 1788828951 --floor 60000 --assets 600
npm run cli -- maker make-offer --loan USDC --collateral WBTC --maturity 1788828951 --floor 60000 \
    --side buy --apr-bps 1000 --max-units 600 --out bid.json

# borrower: quote, execute, repay, reclaim
npm run cli -- borrow quote --offer bid.json
npm run cli -- borrow execute --offer bid.json --units 600
npm run cli -- repay --offer bid.json --assets 600
npm run cli -- reclaim --offer bid.json

# reads
npm run cli -- market state --offer bid.json
npm run cli -- read position --offer bid.json --account 0x...
```

## Choosing a runtime — `./bivium-run`

One launcher, three modes:

```bash
./bivium-run --runtime local  market list     # run node directly on this machine
./bivium-run --runtime docker market list     # run inside the persistent sandbox container
./bivium-run market list                      # auto: docker when a daemon is reachable, else local
./bivium-run --runtime docker shell           # interactive bash inside the sandbox
```

Docker mode provisions everything on first use (builds the image, creates the persistent
`bivium-agent` container) and reuses it afterwards, so in-container keys and open positions
survive between invocations. `BIVIUM_PK`/`BIVIUM_PROFILE` are forwarded in; an absolute host
profile path is copied into the container. In docker mode `--key-file` paths refer to the
container filesystem by design — generate keys inside the sandbox rather than copying host keys
in. `BIVIUM_RUNTIME=local|docker|auto` sets the default.

## Sandboxed agents (Docker)

Agents should not need the host machine. The image is self-contained — keys are generated inside
the container and die with it; the only capability required is network egress to the profile RPC,
the Pages relayer origin (`/api/gas`, `/api/offers`, `/api/markets`), and (optionally, for
moneyness warnings) `api.coinbase.com`:

```bash
docker build -t bivium-cli .
docker run --rm bivium-cli market list
docker run --rm -it --entrypoint bash bivium-cli    # full interactive session in the sandbox
```

Inside the container the zero-trust flow works end to end with no mounts and no host secrets:
`wallet create` → `wallet gas --to <addr> --via-api` → `mock mint` → trade.

**Reuse and key lifetime.** A borrow position is bound to the wallet that opened it — repayment
must come from the SAME key, so any flow that spans sessions (borrow today, repay later) needs the
key to outlive a single `docker run --rm`. Two patterns:

```bash
# A. persistent named container — filesystem (and keys) survive stop/start
docker run -d --name bivium-agent --entrypoint sleep bivium-cli infinity
docker exec -it bivium-agent bash          # work sessions, as many as you like
docker stop bivium-agent && docker start bivium-agent   # state preserved
docker rm -f bivium-agent                   # explicit end-of-life — keys die here

# B. ephemeral containers + named volume for keys only
docker volume create bivium-keys
docker run --rm -it -v bivium-keys:/home/bivium/keys --entrypoint bash bivium-cli
```

Use `--rm` one-shots only for flows that OPEN AND CLOSE within the session (quote, market list,
a full borrow→repay cycle, secondary trades from a freshly funded wallet). If a throwaway
container dies holding an open position, the collateral is orphaned until maturity settlement.

## Throwaway wallets and gas

Agents should not import long-lived keys. Generate a wallet and fund it from the on-chain Sepolia
gas faucet (`wallet create` / `wallet address` / `wallet balance` / `wallet gas --to <addr>`): the
faucet contract (profile `gasFaucet`) holds the corpus behind on-chain rate limits (0.01 ETH drip,
6h per-recipient cooldown, 60s global interval, rich-recipient gate, no owner/withdrawal path);
`claim(to)` is third-party callable, so the operator key that triggers it only ever pays claim gas.
Fund the faucet by plain ETH transfer to its address. Key files are written mode 0600 and loaded
via `--key-file` with a permissions check.

## Safety model (enforced in the SDK)

- **Profile pinning, fail closed** — every run is scoped to a profile file pinning
  `{chainId, core, signatureRatifier, abiProfile}`; `verifyProfile()` cross-checks the core's
  `computeId` against the SDK's local hash before any write. A wrong-lineage core refuses to run.
- **Exact integer math only** — strikes, prices, amounts are BigInt end to end; core rounding
  (floor principal, ceil collateral) is mirrored and golden-tested.
- **Simulate-first writes, exact allowances, balance-delta postconditions.**
- **Ratification prechecked** — offers are only emitted/accepted when the on-chain ratifier returns
  the `RATIFIED` magic for the commitment.
- Keys come from an env var (`--key-env NAME`, default `BIVIUM_PK`); never argv, never logged.

## Whole-lot vault app (vaultBTC / TBVBTC)

The `vault` command group drives a deployed vault-contracts-bivium `BiviumVaultApp` family
(TBVBTC lineage) on the core-v2 lineage. Profiles carry it in an optional `vaultApp` section
(`{registry, app, vaultBtc, escrow, tbvbtc, appBlock}`); vault commands fail cleanly without it,
and `verifyVaultApp()` cross-checks the section against the app's immutable bindings
(`REGISTRY / VAULT_BTC / ESCROW / TBV_BTC / BIVIUM`) before any write. The retired core-tbv
ERC-1155 canary (`profile.tbv`, `tbv *`) is gone; a profile that still carries `tbv` is rejected.

**Lifecycle.** A vault comes in as a *lot* (on testnet the mock registry's permissionless
`activate` is the faucet: `vault activate --sats N` mints N sats of soulbound vaultBTC to the
depositor and opens a `Reserved` lot). An unbound Reserved lot has three roads: **borrow** against
it (`vault borrow`: the app escrows the WHOLE group of vaults into ONE lender bid on the
vaultBTC/USDC market with the borrower as taker — face = Σsats × strike / 1e36 plus any credit the
borrower already holds there, which the app sweeps), **convert** it (`vault convert`: the door to
TBVBTC — the lot's vaultBTC locks in the escrow, never burns, and equal fungible TBVBTC is minted;
lot → `Delivered`), or **reclaim** it (`vault reclaim`: burn the vaultBTC, lot → `Consumed`, vault
out). A borrowed lot is collateral of a live core loan: repay the exact face on the core
(`bivium repay`), withdraw the collateral (`bivium reclaim`), then `vault release` clears the
binding so the group is borrowable again — or `vault reclaim` exits. Unpaid at maturity, anyone
may `vault mark-delivered` the group (defaulted, `Delivered`). While a Delivered lot is unsettled —
converted or defaulted alike — the origin may `vault unconvert` by burning equal TBVBTC and gets the
SAME vault back as a fresh Reserved lot; a registered keeper may `vault keeper settle` it by
burning its own TBVBTC (lot → `Consumed`, vault redeemed to the keeper's AVK key). TBVBTC exits to
native BTC through the redemption book (`vault redemption post|cancel|list`, keeper `vault keeper
fill`). Invariant at every block: `vaultBTC.balanceOf(escrow) == TBVBTC.totalSupply()`
(`vault invariant`).

```bash
export BIVIUM_PROFILE=profiles/sepolia-routerv3-v2.json
npm run cli -- vault activate --sats 400000                 # testnet mock vault (0.004 BTC), random id
npm run cli -- vault list                                   # my lots + resolved next action
npm run cli -- vault status --vault-id 0x…
npm run cli -- vault borrow --vault-id 0x…[,0x…] --offer bid.json --dry-run   # face/units/principal
npm run cli -- vault borrow --vault-id 0x… --offer bid.json # approve + CAP_FILL grant (once) + borrowAgainst
npm run cli -- repay --offer bid.json --assets 240 && npm run cli -- reclaim --offer bid.json
npm run cli -- vault release --vault-id 0x…                 # repaid group → unbound, borrowable again
npm run cli -- vault convert --vault-id 0x…                 # → TBVBTC (lock, not burn)
npm run cli -- vault unconvert --vault-id 0x…               # burn equal TBVBTC, same vault back
npm run cli -- vault reclaim --vault-id 0x…                 # vault out
npm run cli -- vault mark-delivered --vault-id 0x…          # permissionless default mark at maturity
npm run cli -- vault convert-delivered --sats 100000        # claim-hook fallback for delivered vaultBTC
npm run cli -- vault redemption post --amount 400000 --min-sats-start 400000 --min-sats-end 390000 \
    --btc-dest 0x0014… --deadline 1790000000
npm run cli -- vault redemption list --limit 10
npm run cli -- vault redemption cancel --id 0                # after the deadline, if unfilled
npm run cli -- vault keeper fill --id 0 --txid 0x…          # keeper: claim escrow after front-paying BTC
npm run cli -- vault keeper settle --vault-id 0x…           # keeper: burn TBVBTC, redeem the vault
npm run cli -- vault invariant
```

Vault amounts are integer **sats** (outputs also show BTC). Safety mirrors the base client:
whole-lot math is exact BigInt (`wholeLotFace`, `assertWholeLotStrike` refuses off-grid strikes
that would revert `NotWholeVaultEscrow`); every write pre-reads the lot and mirrors the app's
guards (`NotOrigin`, `StillBound`, `LoanNotRepaid`, `BadOrder`, …) with a named error before
spending gas; borrow prechecks the bid via `offerStatus`, then requires the receiver's loan-token
delta and the `Borrowed` event to equal the local quote exactly.

## DCN secondary trading (order book, sweeps, relayer)

The `book`/`trade`/`order` command groups trade EXISTING credit (DCN) against resting signed
offers — a maker's `Offer{buy:false}` ASK sells credit it holds, an `Offer{buy:true}` BID buys it.
The book is assembled from one of two sources: `--source files --dir <path>` (every `*.json`
SignedOfferFile in a directory, strictly validated against the profile) or `--source relayer`
(the profile's optional `relayerUrl`, core-v2 only). A relayer failure is loud: `{ok:false}` is
"relayer unavailable — not an empty book", exit 1 — never silently an empty book, and one
malformed row poisons the whole batch.

```bash
# resting limit orders: sign asks/bids to a directory, optionally publish to the relayer
npm run cli -- maker make-offer <market flags> --side sell --tick 3880 --max-units 60 --out orders/ask1.json
npm run cli -- maker make-offer <market flags> --side sell --tick 3896 --max-units 60 --out orders/ask2.json --publish

# depth view (reconciled against on-chain consumed; --depth N levels per side)
npm run cli -- book list <market flags> --source files --dir orders

# market orders: plan → show → execute every fill in ONE core multicall
npm run cli -- trade buy  <market flags> --spend 100 --source files --dir orders   # or --units X [--exact-spend]
npm run cli -- trade sell <market flags> --units 30 --limit-tick 3876 --source files --dir orders
# --dry-run prints the plan (per-offer fills, total cost/proceeds, worst tick) without executing

# maker order management
npm run cli -- order list --maker 0x… <market flags> --source files --dir orders
npm run cli -- order cancel --offer orders/ask2.json   # setConsumed(group, cap) + relayer DELETE
```

Sweep semantics mirror the core exactly (`_fill`/`_moveClaim`):

- **Buy (take asks)** — the taker pays `ceil(units·price/WAD)` per fill (rounding is always
  toward the resting maker); the CLI approves the exact total, prechecks the window, ratifier,
  and that each maker's `creditOf` covers its planned units (a resting ask can only TRANSFER
  existing credit — a shortfall reverts `OnlyTakerMayBorrow`), then submits all fills in one
  `multicall`. Postconditions: taker credit delta == total units, loan-token delta == −total cost.
- **Sell (take bids)** — the taker receives `floor(units·price/WAD)` per fill from the maker's
  pre-funded liquidity. Selling existing credit is a pure secondary transfer and stays legal
  at/after maturity (the matured guard only applies to new debt); the CLI instead requires the
  taker's `creditOf ≥ units` so a fill can never slip into origination, and no collateral is
  approved. Postconditions: credit delta == −units, loan delta == +total proceeds.
- **Cancel** — on-chain `setConsumed(group, cap)` is the authority (kills the signature forever);
  the relayer DELETE (EIP-191 `bivium-cancel:<commitment>` signed by the maker) only delists the
  served copy and a failure there is a warning, not an error.

Planning is pure BigInt (`src/sdk/orderbook.ts`, vectors pinned from the frontend's book tests):
spend-sized buys floor-convert budget to face and never overspend; `--exact-spend` refuses any
plan that cannot absorb the budget to the atomic unit; `--limit-tick` bounds the worst executed
tick (buy: tick ≤ limit, sell: tick ≥ limit — higher tick = higher price).

## ABI lineages

Two lineages are supported behind one adapter boundary (`src/sdk/lineage.ts`):

- `core-v1` — 6-field MarketParams / 15-field Offer (Sepolia multi-loan candidate core `0x344BA9…`,
  profile `profiles/sepolia-multiloan-v1.json`)
- `core-v2` — domain-bound 8/17-field (Sepolia Router V3 core `0x3d6083…`, profile
  `profiles/sepolia-routerv3-v2.json`); market ids and offer commitments include `{chainId, core}`,
  pinned by live-chain golden vectors in `test/lineage.test.ts`
