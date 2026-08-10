---
name: bivium
description: >
  Operate the Bivium fixed-rate credit protocol from the command line: lend (deposit liquidity and
  quote as a maker), borrow against collateral, trade DCN credit (order book, limit and market
  orders), repay/reclaim/claim, and mint mock testnet assets. Use this skill whenever the user
  mentions Bivium, DCN, bivium-cli, resting offers/挂单, borrowing against WETH/WBTC/vaultBTC
  collateral, lending USDC/GHO into a fixed-rate market, sweeping an order book, or asks to test or
  operate any Bivium market on Sepolia or a local anvil chain — even if they don't name the CLI.
---

# Bivium CLI operations

The `bivium` CLI drives the Bivium protocol — fixed-rate, fixed-term, oracle-free, no-liquidation
lending — from a terminal. This skill covers the three core jobs: **lending** (deposit + quote),
**borrowing** (collateral in, loan token out), and **trading DCN** (the fungible credit token),
plus the safety rules an agent must follow. Everything is testnet-only with valueless mock assets.

## Setup (once per session)

Use `./bivium-run` as the entry point — it picks the runtime for you (`--runtime local|docker`,
default auto: docker when a daemon is reachable). Docker mode auto-provisions and reuses a
persistent sandbox container, so keys and open positions survive across invocations; in that mode
`--key-file` paths are container paths — generate keys inside, never copy host keys in.

Prefer the sandbox when one is available — the CLI needs no host access at all for the fresh-wallet
flow: `docker build -t bivium-cli . && docker run --rm -it --entrypoint bash bivium-cli` gives a
disposable environment where keys are generated inside and die with the container (network egress
to the RPC + relayer origin is the only requirement). BUT: a borrow position is bound to its
wallet — repay needs the SAME key. Use a `--rm` one-shot only when the flow opens AND closes in
the session; for anything spanning sessions use a persistent named container
(`docker run -d --name bivium-agent --entrypoint sleep bivium-cli infinity` + `docker exec`) or a
named volume for the key files. Otherwise run directly:

```bash
cd bivium-cli                            # repo: https://github.com/jianmliu/bivium-cli
npm install                              # first time only
export BIVIUM_PROFILE=profiles/<profile>.json
export BIVIUM_PK=0x...                   # signing key — env var ONLY, never a CLI argument
```

Pick the profile by target:

| Profile | Target | Notes |
|---|---|---|
| `profiles/anvil-tbv-local.json` | local anvil (chain 31337) | safe playground; needs anvil running with the local deployment |
| `profiles/sepolia-multiloan-v1.json` | Sepolia multi-loan candidate core | 6-field "core-v1" lineage |
| `profiles/sepolia-routerv3-v2.json` | Sepolia Router V3 core | domain-bound "core-v2" lineage |

Derive your own address from the signing key before minting or reading balances — never infer it
from an account index or the prompt (`cast wallet address --private-key "$BIVIUM_PK"` is acceptable
for well-known local dev keys; both baseline agents in testing guessed the index, minted to the
wrong address, and burned a reverted transaction discovering it).

**Prefer a throwaway wallet over importing a key.** When no key is provided (or you'd rather not
handle one), generate a fresh wallet and fund its gas from the on-chain faucet — an operator key
only pays the tiny claim gas; the drip comes from the faucet contract:

```bash
npm run cli --silent -- wallet create --out agent.key        # new key, file mode 0600
ADDR=$(npm run cli --silent -- wallet address --key-file agent.key)
npm run cli --silent -- wallet gas --to $ADDR --via-api      # keyless: the relayer claims for you
# (or without --via-api if an operator key is available in BIVIUM_PK)
# then run any command as the fresh wallet with --key-file agent.key
```

The Sepolia profiles carry the faucet address (`gasFaucet`); drips are 0.01 ETH with a 6h
per-recipient cooldown, and recipients already holding ≥0.05 ETH are refused. Never commit or
share a key file.

Sanity-check connectivity and the profile before doing anything else:

```bash
npm run cli --silent -- market state --loan USDC --collateral <SYM> --maturity <unix> --floor <usd>
```

If any command fails with "wrong ABI lineage", "computeId disagrees", or a chain mismatch — **stop
and report**. The CLI verifies the deployment on-chain before every write; these errors mean the
profile points at the wrong core or the wrong encoding, and working around them would sign
transactions against a deployment the client doesn't understand. That failure mode is real (two
core lineages coexist on Sepolia), which is exactly why the check exists.

## Discovery first — join markets, don't fragment them

Before lending, borrowing, or quoting, list the markets that already exist and prefer joining one:

```bash
npm run cli --silent -- market list          # MarketTouched scan from the chain, lineage-verified
```

Every distinct parameter set (even a floor 100 apart) is a SEPARATE market with its own book and
its own settlement pool — creating a new one splits liquidity and leaves both sides thinner.

Read the `floor/spot` column before quoting. A floor at/above spot (`[ITM ⚠]`) means the
borrower's rational strategy is to keep the principal and deliver the collateral — lending near
par there is a guaranteed loss, and `make-offer --side buy` will refuse unless you pass
`--acknowledge-itm` (only do that when the user explicitly wants an in-the-money quote and
understands they are buying collateral above market). Prefer OTM markets (floor below spot);
spot is a display-only reference and never enters the offer itself.
Create a new market identity only when the user explicitly wants terms nothing existing offers,
and say so when you do. `[gated]` rows have an access-controlled gate; prefer ungated ones unless
you know you pass the gate. `--source relayer` uses the hosted index instead of scanning; if it
reports full coverage with zero markets, that is a lineage mismatch, not an empty chain — fall
back to `--source chain`.

## Mental model (30 seconds)

- A **market** is identified by its parameters (loan token, collateral token, maturity, strike,
  partial-repay flag, gate). Markets are created lazily — the first `fund`/`fill` creates them.
- **Lenders** escrow loan tokens (`maker fund`) and sign resting **buy offers** (bids). A borrower
  filling a bid mints **DCN** credit to the lender and takes the principal.
- **Borrowers** never post offers to borrow — they take a maker's bid, locking collateral at the
  strike ratio. Repay is only possible strictly **before maturity**; from maturity on, unpaid
  collateral goes to the settlement basket and credit holders `claim` a pro-rata mix.
- **DCN trading** is secondary transfer of that credit: asks sell held credit, bids buy it. All
  prices live on a tick grid; APR is derived display, not a protocol term.

Amounts are exact decimal strings in human units ("600", "0.01") — the CLI converts using the
token's exact decimals and rejects over-precision rather than rounding. Add `--json` whenever you
need to parse output. In zsh, expand flag-bundles with `${=VAR}` (unquoted vars do not word-split).

When a HUMAN is driving interactively, offer `bivium wizard` instead of raw flags — one entry
point covering all three intents (出借挂单 with funding assistance: auto-detects short escrow and
offers mint/fund/set-ratifier; 抵押借款: pick a live bid, quote shown before execution, collateral
minted with consent, repay deadline and command printed after; 交易 DCN: book display, plan shown
before the sweep). For a quick position/order overview use `bivium portfolio [--account]` — it
aggregates borrow positions, DCN holdings, escrow, and resting orders across all discovered
markets. `maker wizard` remains as the lend-path alias — it lists the
discovered markets (with moneyness/gated flags), prompts for amount and price, requires an
explicit `yes-itm` on in-the-money markets, and confirms before signing. Agents keep using flags.

## Workflow: lend (存款借出)

```bash
# pick B from `market list` output — join an existing market unless told otherwise
B="--loan USDC --collateral WETH --maturity 1788828951 --floor 3000"   # market flags, reused below
npm run cli --silent -- mock mint --token USDC --to <maker-addr> --amount 1000   # testnet only
npm run cli --silent -- maker set-ratifier          # once per account per deployment
npm run cli --silent -- maker fund ${=B} --assets 600
npm run cli --silent -- maker make-offer ${=B} --side buy --apr-bps 1000 --max-units 600 \
    --ttl 86400 --out bid.json                       # signs EIP-712; refuses to write unless the
                                                     # on-chain ratifier confirms RATIFIED
```

- `--apr-bps` derives the tick from remaining term; use `--tick` for direct grid placement.
- `--publish` also POSTs the offer to the profile's relayer (needs `relayerUrl`; core-v2 only) so
  web-app users can see and fill it. Without it, hand the `bid.json` file to the counterparty.
- Track fills with `order list --maker <addr> ${=B}`; withdraw unused escrow with
  `maker withdraw-liquidity`. After maturity, redeem with `claim ${=B} --units <face>` — the payout
  can be loan tokens, collateral, or a mix; that is the product, not an error.

## Workflow: borrow (抵押借入)

```bash
npm run cli --silent -- book list ${=B} --source relayer        # or --source files --dir <dir>
npm run cli --silent -- borrow quote --offer bid.json --units 100
npm run cli --silent -- borrow execute --offer bid.json --units 100
# ... before maturity:
npm run cli --silent -- repay --offer bid.json --assets 100
npm run cli --silent -- reclaim --offer bid.json
```

Always `quote` before `execute` and surface the numbers (principal received, collateral locked,
implied APR) to the user before spending. `execute` runs the full preflight (offer window,
remaining capacity, maker liquidity, RATIFIED signature) and verifies the received principal
matches the quote to the atom — if it aborts, read the reason; do not retry blindly. Repayment
needs the **exact face** in the loan token (principal received is less than face — the difference
is the interest), and reclaiming collateral is a separate transaction after repay.

## Workflow: trade DCN (交易挂单)

```bash
npm run cli --silent -- book list ${=B} --depth 10 --source relayer
# limit order (ask selling held credit):
npm run cli --silent -- maker make-offer ${=B} --side sell --apr-bps 900 --max-units 50 --out ask.json --publish
# market orders — ALWAYS dry-run first, then execute the shown plan:
npm run cli --silent -- trade buy  ${=B} --spend 100 --limit-tick 3900 --source relayer --dry-run
npm run cli --silent -- trade buy  ${=B} --spend 100 --limit-tick 3900 --source relayer
npm run cli --silent -- trade sell ${=B} --units 30 --source relayer
# cancel: on-chain consumption pin is the authority; relayer delisting is best-effort on top
npm run cli --silent -- order cancel --offer ask.json
```

- Sweeps execute as one atomic multicall; postconditions require the credit/cash deltas to equal
  the plan exactly. `--limit-tick` bounds the worst acceptable price; `--exact-spend` refuses
  partial absorption.
- Buying DCN can only transfer credit the ask's maker holds — it never creates debt. Selling held
  credit remains legal at/after maturity, but nothing guarantees bids exist then.
- **"relayer unavailable — not an empty book" is an error, not an empty market.** Never report a
  failed book fetch as "no liquidity".

## Rules for agents

1. Testnet only. If anything suggests real funds or mainnet, stop and ask.
2. Keys via `BIVIUM_PK`-style env vars only; never echo them, never pass as arguments.
3. Preview before spending: `--dry-run` / `quote` first, show the plan, then execute.
4. Trust the fail-closed errors. The CLI's preflights encode protocol invariants; a blocked command
   means the state disagrees with your assumption — re-read state (`market state`, `read position`,
   `offer status`) instead of forcing.
5. `mock mint` only works for tokens the profile marks `mintable` — that gate is the definition of
   "this is a valueless test asset", don't try to route around it.

## Troubleshooting

| Symptom | Meaning | Action |
|---|---|---|
| `wrong ABI lineage` / `computeId disagrees` | profile ↔ core encoding mismatch | stop; verify profile |
| `MaturityPassed` | repay/new-debt attempted at/after maturity | repay window is closed; lenders `claim` instead |
| `OnlyTakerMayBorrow` | an ask tried to originate debt (maker credit short) | check `offer status` / maker `read credit` |
| `SelfDeal` | taker == maker | use a different account |
| `units exceed remaining capacity` | offer partly consumed | re-read `offer status`, lower units |
| `offer commitment mismatch` | offer file tampered or wrong profile domain | reject the file |
| relayer `ok:false` | discovery layer down, book state unknown | report as outage; optionally `--source files` |

Deep reference: `README.md` and `docs/spec/2026-08-09-bivium-cli-spec.md` in the bivium-cli repo;
protocol docs in `/Volumes/T7-Data/bendle/bivium-docs/` (`cli.md`, `protocol-overview.md`,
`using-the-app.md`). An experimental `tbv` command group (whole-vault ERC-1155 collateral) exists
for local anvil work — read the spec's TBV section before using it.
