# Testnet CLI/MCP compatibility acceptance

Scope: local CLI/MCP implementation based on `640e81e`; no deployment, publication,
wallet key access, signatures, transaction submission, or funding. This record is
in progress until the final acceptance section is completed.

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

## Deferred integration acceptance

Task 1 full suite reported 426/428: the two failures were keeper integration
runtime source-pin drift after editing `src/cli/main.ts`. Refresh the CLI commit
and affected hashes only after final source commits, then rerun portable and
cross-repository checks. No fixture/Core/MM pin replacement or skipped tests is
authorized by this deferral.

DCN contract boundary evidence is recorded separately in
[`2026-09-25-dcn-secondary-route-boundary.md`](2026-09-25-dcn-secondary-route-boundary.md).

## Final acceptance

Pending remaining tasks, final tests, build, read-only smoke and independent review.
