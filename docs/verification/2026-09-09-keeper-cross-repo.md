# Bounded keeper integration evidence

Status: approved software-only integration complete, independently reviewed and locally committed. No deployment, public transaction, keeper startup, source import, push or merge authorized by this work.

## Baselines

- Core authority: merged `c8966120b1b4e8507721fa483e549a12e54cfb26` (PR #205).
- MM authority: merged `8ad7069541107012b5413bcecb001a9b36b9a6d0` (PR #49). Direct bounded session files matched the pre-merge checkout, but recursive closure inspection found an upstream `src/quote.ts` addition. The existing isolated MM worktree was therefore switched to `verify/keeper-v2-integration-20260909` at the actual merge; all 17 local dependency-closure files now match it. No source patch was invented. Its upstream tracked host-specific `node_modules` symlink was moved outside the worktree, preserving the existing real dependency directory; the resulting local `D node_modules` is an intentional dependency-only working-tree exclusion, not a source commit or upstream fix. The saved link is `../cai-keeper-upstream-node-modules-link`. Dependency directories/links are excluded from source provenance and packaging.
- CLI: `14989448611b01cad5a71f6448b395c6d1c63599`; after reinstalling the existing lockfile dependencies offline, `npm test`: 333 passed, no failures/skips; `npm run typecheck`: exit 0. Initial missing `ajv` was an outdated local dependency directory, not a source regression.
- Frontend: frozen `54f8be74d279640cf481f65c8486a3519189fd33` plus preexisting migration deltas; fresh `npm test`: 1,594 passed, no failures/skips. No unrelated upstream changes were absorbed.
- MM actual merged-source baseline after dependency-preserving checkout: `npm test`: 281 passed, no failures/skips; `npm run typecheck`: exit 0. Earlier 275-pass evidence belongs to the reviewed pre-merge head, not the complete merged source.

### Accepted preexisting ARM delta fingerprints

These hashes describe the working files before this integration, not files newly authored by it. Gate, Pages, HTTP scope and other migration deltas remain outside this task's commits.

The accepted ARM baseline and its original repair plan were separately checkpointed under this integration's local-commit scope as frontend `27456eb28fc1ffff2b5985172fdecdf01350f2aa`. Its original no-commit repair record remains historical. The fresh frontend baseline typecheck (`tsc --noEmit --incremental false`) also exited 0 before any package/UI integration change.

| Frontend file | SHA-256 before integration |
|---|---|
| `components/AutoSettleControl.tsx` | `4fe22156055d4d15f195b1cd2270e0df2f86440b0931c7f49f4a9ba84017c829` |
| `lib/maturitySettler.ts` | `f4df8cc5653367f6339c3244bc729c3388a4ec850fef7eb1b7352afe706a1400` |
| `lib/maturitySettler.test.ts` | `12af1085f19560b3581d11a4f1109b21555d8eb373079acd4e4a393e9d892f52` |
| `lib/autoSettleArmRender.runner.mjs` | `de142aadb98af8df7bc6692cc5ee91634acb8610536e7f843b8314c0274c3def` |
| `lib/autoSettleArmRender.test.ts` | `b360467657bd9f9f62330e666bc0cadca847da463c3d0476747cfb36286dc897` |
| `lib/autoSettleArmRenderLoader.mjs` | `bcb22645ba8f8c81d8890314f94eeea40b2454f2fc1a9cd90d00d5ea67f363b8` |

## Operator guide behavioral baseline (before edits)

An independent agent received only the old operator guide and three scenarios. No commands were executed.

1. Stopped legacy v1 keeper with a pending transaction, asked for keyless recovery: found `status`, correctly refused restart/key access/history deletion, but could not find a concrete reconcile command or v1 migration instructions.
2. New v2 keeper, zero retained meme, debt ceiling 100 and 20 minutes remaining: chose capabilities inspection and refused to promise hard bounds; the guide lacked the v2 fields, final-wallet postcondition and bounded-wrapper prerequisite.
3. Only legacy `settleWithFlash` available, pressure to use a prompt cap or shared Worker: correctly rejected fallback, but could not explain old/new wrapper semantics from the guide.

RED means retrieval/coverage gaps, not an observed unsafe action. The revised guide must close those gaps while retaining the successful refusal boundaries.

## Task 1 — SDK and CLI

Reviewed local commit: `0323d698020fae43f454b716c540f1a09cde08fc`. New explicit bounded method/ABI/event and command coexist with unchanged legacy selectors. Tests use actual CLI dispatch and SDK transport against synthetic loopback RPC; no keys or public-chain writes.

Independent specification review approved the implementation. Subsequent quality review found two minor issues: importing under stdin attempted to resolve `-`, and default-ask chain reads were not tested. Both were fixed, with stdin regression observed RED→GREEN and actual pinned-block `floorOf`/`maxAsk` dispatch coverage. Quality re-review found no open findings. Root final `npm test`: 345 passed, no failures/skips; `npm run typecheck` and `git diff --check`: exit 0. Focused bounded tests: 12 passed.

## Task 2 — Operator guide behavioral GREEN

A fresh independent agent read only the revised operator guide, without implementation/tests/evidence context. It proposed `status` then keyless `reconcile` for stopped legacy v1 and refused account/history reuse; mapped debt and both wallet caps into raw amounts, rejected a zero-MEME-cap account already holding 0.1 MEME and used the earlier of session end/maturity; refused old-wrapper/prompt-budget/wallet/Morpho/Worker fallbacks under deadline pressure; distinguished ARM permission and a manual bounded CLI result from autonomous service approval or realized net profit. It retained unknown deployment/token-decimal/evidence/receipt data rather than inventing them. It also distinguished a per-transaction debt ceiling from a cumulative session debt budget.

The guide intentionally does not supply live deployment data, a fully populated executable policy or a standalone CLI receipt-query command. Those omissions did not prevent the required operator recovery/authority decisions. The primary and secondary Skill copies passed the skill validator; six focused tests verify synchronized references and exact command/field documentation, not agent behavior on their own.

Independent specification and subsequent quality reviews found no open findings. Root full regression: 348 passed, no failures/skips, typecheck/diff check exit 0. Reviewed local commit: `91a8bb1eb40040732992b8cb27a38eb63577f8b6`.

## Task 3 — Pinned cross-repository verifier

Reviewed code commit: `a964a11903a6fd16b12fbcca3cd44cd336707c81`. The integration manifest pins six Core project inputs plus nineteen compiled-source metadata hashes; the actual SDK import closure (twelve files plus two CLI entrypoint provenance anchors); and all seventeen MM production import-closure files. This verifier runs actual SDK/MM code, not CLI dispatch/profile loading; Task 1's actual command tests are separate evidence.

Independent spec review required two additional terminal cases (actual reverted receipt and RPC failure), both added with RED→GREEN evidence. Quality review then identified a destination-capture blind spot; the verifier now checks actual SDK target and zero/absent native value as well as calldata. Wrong-target/value tests observed RED→GREEN. Both review stages subsequently passed with no open findings.

Root fresh results: `npm test` 353 passed, no failures/skips; typecheck/diff check exit 0. The explicit command below passed four orientation/deadline vectors, twenty MM shape checks and twenty stopped/expired receipt cases. RPC captures contain only `eth_chainId`, `eth_getBlockByNumber`, and `eth_getTransactionReceipt` on synthetic loopback transports; no signing/sending. Ordinary CI's five focused verifier tests separately check portable fixtures, ABI/target/value drift, source/commit drift and missing-input refusal.

```sh
npm run verify:keeper-integration -- \
  --core-root /Volumes/T7-Data/bendle/bivium-core/.worktrees/cai-testnet-preflight-20260908 \
  --mm-root /Users/jianmingliu/.config/superpowers/worktrees/bivium-mm/cai-testnet-preflight-20260908
```

Source/ABI drift fails closed; the command never substitutes portable-only evidence for missing cross-repository inputs. Installed JavaScript dependencies remain an explicit environmental prerequisite, not part of the project-source pin. Frontend's own exact artifact and lockfile validation is a separate integration boundary below.

## Task 4 — Installed frontend package and ARM

Reviewed frontend integration commit: `386e3ef802fccf5fcce948b73c1a2c838690f1c9`, on top of the separately checkpointed ARM baseline `27456eb28fc1ffff2b5985172fdecdf01350f2aa`. Only its eleven scoped files were staged.

The frontend now consumes the checked-in `vendor/bivium-cli-a964a11903a6.tgz`, produced from exact CLI commit `a964a11903a6fd16b12fbcca3cd44cd336707c81`. Its 76 regular files (207,963 compressed bytes) were independently compared byte-for-byte against that Git commit; SHA-256 is `817b572f47a469d906ac2d967164cc828312658b094d3a2bbdb344f3cb4672a8`. Provenance, lock integrity, portable archive checks and all installed file bytes agree. No keys, signed-order data, environment files or dependencies were packaged. Heuristic credential scans found no matching files; this is not an absolute secret-absence proof. Offline installation disabled lifecycle scripts. Upstream attribution and metadata remain unchanged; later CAI extraction still requires third-party notice review.

ARM now explains in collapsed and expanded states that permission does not start a keeper, availability is not verified, and settlement is not guaranteed. Existing six-hour window, user floor, capability 8 / expiry 0, grant/revoke arguments and unconditional hook behavior are preserved. Three newly failing availability cases passed after the copy change; the internal mounted runner now has 26 passing cases. Actual installed root SDK and strategies consumers are exercised without networking or signing.

Repinning exposed a selector-blind preexisting consumer-test fixture: new SDK liquidity reads received slot0 bytes. The fixture now ABI-encodes each requested selector and explicitly tests zero-liquidity marginal fallback. Production swap math was not changed; the browser's existing explicit marginal minOut path does not inherit SDK depth/impact protection merely through this repin. That path remains excluded from CAI admission.

Root independently reran the full frontend suite: 1,597 passed with zero failures/skips/cancellations; `tsc --noEmit --incremental false` and `git diff --check` exited 0. Focused installed-package/ARM/consumer tests passed 36/36. The specification reviewer independently verified all 76 archive files and approved code/package behavior; three factual amendment corrections (inventory versus admission, unit versus fork counts, native Gas versus ERC20 principal) were fixed and reapproved. Independent quality review also passed with no open findings, separately rerunning 36 focused tests and typecheck and verifying all 76 source files.

Nine unrelated tracked migration diffs retain their pre-integration combined SHA-256 `cea7887c5c29ea5434d2d717478174d83c16c5dfd332c1cd3ffd9802ad1108b1`. Gate/HTTP/Pages work and other untracked migration files are excluded from this task's staged changes. Full-suite results describe the preserved migration workspace, not a claim that the isolated integration commits also contain those unrelated migration files.

## Evidence boundaries

Fresh Core verification during integration: `V4_KEEPER_FORK=true V4_KEEPER_RPC_URL=https://rpc.testnet.chain.robinhood.com V4_KEEPER_BLOCK=116426937 V4_KEEPER_BLOCK_HASH=0x5e11fd6afab57a3574678087f62c00725cc55c349c8622d48f3b119ebabefdc6 forge test --offline --match-contract '^(V4JitKeeperTest|MaturitySettlerTest|V4JitKeeperForkTest)$'` exited 0: 34 passed, no failures/skips, including 15 real-manager fork tests. This reused the pinned local RPC cache; it did not deploy to or transact on the public chain.

Synthetic cross-repository tests, compiled ABI matching, existing real deployed-v4 fork tests, and a running public autonomous keeper are distinct evidence classes. None implies the next. No new bounded deployment address, CAI capability admission or mainnet readiness is established here.

## Handoff and remaining operational gates

All four implementation tasks passed separate specification and subsequent quality reviews. A fresh final whole-work reviewer inspected CLI dispatch/SDK, Core bounds/events, MM policy/shape/reconciliation, operator guidance, frontend ARM and package provenance, and reported no actionable findings. That reviewer independently reran the explicit cross-repository verifier (4 vectors / 20 shapes / 20 terminal cases), 36 focused frontend tests, and all 76 file-to-commit checks.

Final root reruns after the frontend integration checkpoint: CLI 353/353, MM 281/281 and frontend 1,597/1,597 tests; all three TypeScript checks exited 0. Core 34/34 comprised 19 unit and 15 real-manager cached-fork cases. Cross-repository synthetic verification passed; all counts had zero failures/skips. Diff checks passed. The unrelated frontend migration-diff fingerprint remained unchanged after the scoped commit. These complete the approved software scope, not the operational gates below.

Both CLI and frontend changes are retained locally on `feat/keeper-v2-integration-20260909`; their existing isolated worktrees are preserved. Commit identity is `CAI Finance <caidotfinance@gmail.com>`. Packaging remains tied to CLI `a964a11` even if a later documentation-only completion commit advances CLI HEAD. Core/MM production source was not patched by this integration. Core's preexisting untracked `test/BiviumNativeCallbacks.t.sol` is untouched.

The approved software scope does not include pushing branches, creating or merging PRs, importing into CAI private repositories, deploying, changing addresses/admission, provisioning native Gas, accessing real signing keys, or starting an automatic session. A later operational step must separately approve the exact bounded deployment/runtime, policy and host, borrower grant/ARM and native Gas provision. JIT needs no operator ERC20 principal or allowance. Retain the maximum 24-hour session, explicit per-transaction bounds and cumulative session budgets, no automatic replenishment or renewal, no legacy-wrapper fallback, and keyless reconciliation after stop/expiry.

For any later operation, missing/mismatched source or runtime identity, missing approvals, invalid/expired policy, or unresolved receipt/finality evidence is a stop condition, not permission to downgrade to portable-only evidence, infer zero risk, erase reservations/history or restart signing. This report does not claim autonomous keeper availability or public-chain E2E completion.
