# Bounded keeper cross-repository integration

User confirmed the software integration and validation scope on 2026-09-09. This records that approved design, not a request to authorize deployment or automated trading.

## Scope and architecture

Core's merged bounded wrapper is the ABI authority; MM's merged v2 session is the automated executor. CLI/SDK gain an explicit bounded single-transaction route, without changing legacy manual routes. The operator Skill guides users toward MM v2 for automation and keyless reconciliation for stopped sessions. Frontend consumes the verified CLI package and describes ARM as borrower permission, not keeper availability or a settlement guarantee.

Pin Core `c8966120b1b4e8507721fa483e549a12e54cfb26` and MM `8ad7069541107012b5413bcecb001a9b36b9a6d0`. CLI work starts from `14989448611b01cad5a71f6448b395c6d1c63599` in its existing CAI worktree. Frontend remains its existing frozen migration worktree plus separately recorded accepted local deltas; do not silently absorb unrelated upstream changes or overwrite its dirty gate/Pages work.

## Interfaces and safety

`settleWithFlashBounded(params, borrower, ask, key, minProfit, bounds)` uses four uint256 bounds in order: deadline, maxDebt, maxLoanBalance, maxCollateralBalance. Preserve the legacy selector. The explicit bounded CLI route requires the full bounds, a positive minimum surplus and an explicit new wrapper identity; never use the legacy deployment address by default. Restrict this CAI route to chain 46630, hookless correctly sorted loan/collateral pairs, strict unexpired deadline no later than maturity, and exact integer units. Reject incomplete or conflicting flags before signing.

Zero collateral cap is valid and rejects all retained collateral. Existing wallet balances count. Debt is execution-time debt, bounded atomically. Swap fee/impact are already in output; external Gas and reverted transaction costs are not refunded. Manual bounded execution is one user-authorized transaction, not a 24-hour MM policy, account reservation, or authorization to start a service.

Skill must distinguish MM v1, legacy keeper v1 read/reconcile-only, and executable keeper v2. Show keyless reconcile after stop/expiry; preserve account binding, pending reservations, risk acceptance, no renewals/top-ups and no wallet/Morpho/Worker fallback. Canonical Skill source stays `skills/bivium`; synchronize the existing secondary copy mechanically, not as a second authority.

## Validation and provenance

Check compiled Core ABI against actual CLI and MM encoders and event decoders, including nested tuple order and indexed fields. Pin the bounded MM module closure, not a floating checkout. Add a local integrated lifecycle fixture using real encoder/receipt/policy boundaries with synthetic transports, plus reuse the existing real deployed v4 fork proof. Label these as separate evidence: synthetic cross-layer lifecycle is not a public autonomous-service E2E.

Frontend package verification must consume an exact packed CLI artifact/commit, never an unpushed Git URL presented as reproducible. Existing ARM tuple/hook repairs remain separate accepted deltas. No blanket legacy ABI regeneration, excluded pool ABI promotion, HTTP policy activation or deploymentReady=true.

An integration lock/report records source commits, selected file hashes, package artifact digest, test commands and unresolved runtime requirements. CAI scope records may describe bounded v4 as a candidate with software evidence, but no address or capability is admitted merely because these tests pass.

## Stop conditions

No real keys, public transactions, deployment, account creation/funding, CAI source import, pushing or merging without follow-on authorization. Fail closed on source/ABI/package digest mismatch. Preserve existing dirty work. A blocked package fetch or incompatible upstream change is investigated locally; no floating version fallback. Mainnet asset readiness and automatic keeper availability remain unproven.

Self-review: each approved repository-facing change is covered; legacy compatibility is explicit; software completion is separate from deployment and source import; runtime identities and budget approval are not invented.
