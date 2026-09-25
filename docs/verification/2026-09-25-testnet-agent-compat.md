# Testnet CLI/MCP compatibility acceptance

Scope: local CLI/MCP implementation based on `640e81e`; no deployment, publication,
wallet key access, signatures, transaction submission, or funding. Local
implementation and acceptance are complete; remote publication remains separate.

## Mock reference

Implemented in `0979b4d`, with review fixes `2f62f0f` and `62d5674`.
Specification and independent quality reviews approved the final Task 1 state.
The source is selected by exact chain/Core/token addresses. Candidate maturity
and address-pair family are resolved before fetching; ambiguous families reject.
The reverse ratio uses integer division; the strategy retains canonical WAD.

Tests covered invalid payloads, unsupported domains, both orientations, stale
and future source timestamps, unavailable source without legacy fallback,
default MCP flow, prepare-time expiry, and cross-numeraire ordering. The parent
independently ran 57 focused tests before the final boundary fix; the reviewer
reran 29 strategy-flow tests after it. Implementer reported 63 targeted tests and
typecheck passing after that fix. Final all-suite acceptance remains below.

Mock expiry is exclusive. The inspected Router accepts `timestamp <= deadline`,
so the source-derived transaction deadline is capped at `expiresAt - 1`, not
`expiresAt`. Successful preparation does not extend source lifetime.

Read-only source smoke at `2026-09-25T16:24:58Z` returned `mock:true`, source
`https://bivium-robinhood.pages.dev/api/mock-refill-spot`, `observedAt=1790353212`
and `expiresAt=1790355012`. The configured canonical WAD was
`225000000000000000000`; inverse display WAD was `4444444444444444`.
Both orientations retained the same canonical source value and timestamps.

## Market discovery smoke

At `2026-09-25T16:12:48Z`, local MCP source at `286fdee` read the public testnet
index (no writes). Default `market_list` returned 2 new-business markets;
`includeHistory:true` returned 42 records, including 21 `delisted` records.
Both queries identified the same active pair orientations, mNVDA/bUSD and
bUSD/mNVDA, with maturity `1792180800`:

- `0x0dbceea8b46139c606e9614a9200042a2dea317d11acf03db27bd118afeff5fb`
- `0xe9b2fba7a20b3638219bcc6f9387e7cce778c0825a7cb0e255510848eec54107`

This is a local-source smoke against public services, not verification of a newly
deployed remote MCP version. Parent policy/boundary/CLI test run: 25/25 passed;
independent Task 2 specification review: 57/57 passed and accepted `286fdee`.

## Fee semantics evidence

Public, read-only Robinhood testnet RPC at block `124180013`, timestamp
`1790351341`, for Router `0xA7DF5C53F9D809DA34eE29E71531F936b3465B9f`:

- `quoteFee(1000,100)` returned `(20,80)`.
- `quoteLenderFee(1000,100)` returned `(20,120)`.
- `MAX_FEE_OF_PRINCIPAL_BPS()` returned `2000`.

This demonstrates a principal cap on this deployment. Uncapped premium-rate
arithmetic is not an exact live fee quote. It does not establish that another
router has the same cap; live preparation must bind to its selected router.

Shared-helper read-only smoke at `2026-09-25T16:26:05Z`, block `124192563`
(`0x95363302da5e6d2545969e8e2ee09cdff7239208d60f5bda4eb1836148dbde2a`),
resolved the admitted `0xA7DF5C53F9D809DA34eE29E71531F936b3465B9f` Router
for both sides despite the stale profile default. The borrower rate was 1000 BPS
and quote `(fee=20, net=80)`; lender rate was 1000 BPS and quote
`(fee=20, total=120)`, each for face 1000 and cost 100. Unread opposite-side
rates were `null`, not fabricated zero. Pinned Router/StateView manager linkage
and code checks passed. This profile has no configured Quoter; none was claimed
verified. These interface/linkage checks are not an implementation audit or proof
of executable swap depth.

## Agent-reference baseline

A read-only retrieval exercise against the pre-update README and MCP reference
could not identify `includeHistory`, default CASHCAT filtering, the precise Mock
source/provenance/expiry rules, or inverse-price handling. It correctly refused
to infer pre-maturity no-new-debt selling from frontend enablement. It found the
premium fee basis but not the deployed cap or exact rounding. The reference
update must close these demonstrated gaps, not imply new execution authority.

Independent forward testing of the updated references correctly selected the
history flag, Mock provenance/expiry, per-fill fee quote and fail-closed routing,
and refused a premature no-new-debt sale despite a request to skip errors. It
identified older README wording that overclaimed direct sweeps and maker ASK
semantics, plus an unclear counter-token interface. Those passages were revised;
the reviewer confirmed all three findings resolved. This verifies reference
behavior only, not deployed software. Skill-copy synchronization: 7/7 tests passed.

## Source-pin integration acceptance

Task 1 full suite reported 426/428: the two failures were keeper integration
runtime source-pin drift after editing `src/cli/main.ts`. Refresh the CLI commit
and affected hashes only after final source commits, then rerun portable and
cross-repository checks. No fixture/Core/MM pin replacement or skipped tests is
authorized by this deferral. After final source commit
`ad1f0cf925262133ffdded6603ed70e05763aee7`, the CLI commit pin and only the changed
`src/cli/main.ts` hash were refreshed. Its SHA-256 is
`9affad65ba47f85a183615a33b9bcec5a43b179a41dbade4e82f39922c60f508`.
All other CLI hashes, Core/MM commits, build metadata and fixture pins remain
unchanged. Both portable tests now pass.

The pinned cross-repository check passed with 4 ABI vectors and 20 lifecycle
shape checks using these existing local sources:

- Core: `/Volumes/T7-Data/bendle/bivium-core/.worktrees/cai-testnet-preflight-20260908`
- MM: `/Users/jianmingliu/.config/superpowers/worktrees/bivium-mm/cai-testnet-preflight-20260908`

Evidence is `CROSS_REPO_SYNTHETIC` / `SYNTHETIC_LOOPBACK_KEYLESS`, with
`signingOrSending=false` and `liveKeeperE2E=false`. It is software integration
evidence, not an onchain keeper run, session admission, or finality proof.

DCN contract boundary evidence is recorded separately in
[`2026-09-25-dcn-secondary-route-boundary.md`](2026-09-25-dcn-secondary-route-boundary.md).

## Final acceptance

Source implementation: `52e28d9` and `ad1f0cf`. Final Task 3 specification review
accepted `ad1f0cf`, independently running 98 focused tests plus typecheck and diff
checks. Earlier independent quality inspection found no material issues in
Tasks 1/2 (99 focused tests) or the Task 3 SDK execution portion. Final CLI and
whole-change quality review accepted `ad1f0cf` plus the manifest/reference changes,
independently running 35 focused tests with no failures or skips, checking the
reference copies, diff and exact CLI source hash. No material findings remain.

Parent verification after pin refresh:

- `npm test`: 483/483 passed, 0 failed, 0 skipped.
- `npm run typecheck`: passed.
- `npm run mcp:worker:build`: passed, 21 MCP schemas compiled.
- `git diff --check`: passed.
- Pinned cross-repository keeper integration: passed as qualified above.
- `wrangler deploy --dry-run --config wrangler.mcp.toml`: passed and explicitly
  exited without deployment; bundle 3276.98 KiB, gzip 401.77 KiB.

Final read-only MCP/SDK smoke began at `2026-09-25T16:33:10Z`. Default discovery
returned the two active mNVDA orientations, history returned 42 records including
21 delisted records, and both queries ended without a cursor. Both market details
reported complete coverage with no warnings, the admitted A7DF5C Router and
borrower/lender rates of 1000 BPS. Forward details were pinned at block
`124195065` (`0x3fe21a6b942f8561cff5ad6582d44d81aabd53a7ce22de28c69786b6a515bf9b`);
reverse details at `124195080`
(`0xdd1acee3a73b181a1c65d12b06c421384e5f3257c2838eb82a824a685d19167d`).
The authoritative fee source is exposed as `per_fill_router_quote`, not inferred
from the BPS getter. The Mock source returned canonical WAD `225000000000000000000`
and inverse WAD `4444444444444444`, observed at `1790353814` and expiring
exclusively at `1790355614`.

Limits: pre-maturity pure-secondary taker selling remains blocked through the
inspected Router because no execution-time no-new-debt guard was established.
Buy support is conditional on exact-fill quotes, policy and simulation; ordinary
CLOB admission does not establish swap depth. Legacy direct gated CLI opening
paths stop before signing and direct users to admitted preparation; matured
sell recovery and configured unwind remain separate. Remote MCP/CLI releases
have not been updated; no wallet, real trade, funding, deployment or broadcast
was performed by this implementation task.
