# Strategy agent flow implementation plan

> Use subagent-driven-development for the independent SDK resolver implementation and focused review; parent owns MCP integration and immutable source binding.

**Goal:** Four initial strategies resolve high-level user intent into the same pinned, risk-bound unsigned preparation path.
**Architecture:** StrategyFlowService selects a canonical market and one full-size signed fill, computes fees and bounded swap output, then calls ActionService.preview with its pinned context and source metadata. MCP only validates and dispatches. Existing action_prepare handles revalidation.
**Tech stack:** TypeScript, viem, Ajv, node:test.

- [x] Add failing source-binding tests to test/mcp-preview.test.ts; extend ActionService.preview third host-only argument `{ctx,source}` and include sourceHash in PreviewBinding; clone and verify source on prepare. Add optional block-pinned eth_call to ActionRpc for existing swapFloor.
- [x] Create src/sdk/actions/strategyFlow.ts and test/strategy-flow.test.ts. Interface StrategyFlowService(actions, options?).preview(input,signal?). Input fields specified in design; options spot/pools are host-only. Cover four IDs, deterministic market/fill selection, actual fees, decimal units, gate route, depth-aware floor, user maxInput/impact bounds, stale source/empty book/no full fill failure.
- [x] Create src/mcp/tools/strategies.ts with STRATEGY_TOOL_SPECS and createStrategyTools(actions). Add strategy_preview registration and SDK exports. Add strategyCapabilities(id) metadata to strategy_list/server_info without changing pure catalog closure. Exact schema rejects caller order/router/pool construction. Tests use actual createStrategyMcp.handle and ActionService, not a replacement evaluator.
- [x] Extend real subprocess fixture and tests to invoke strategy_preview→action_prepare. Add approval→receipt/fresh preview coverage and revalidation refusal for consumed/backing changes. Run targeted tests and typecheck.
- [x] Update README and both skill/reference copies with high-level input example, exact units, first-release capability and prerequisite handling. Record test evidence. Run npm test, npm run typecheck, npm pack --dry-run --json --ignore-scripts and independent reviews. Commit focused implementation and docs; do not deploy or trade.

Run each new behavior test red before implementing and green after. Preserve all preexisting tests. Code review must inspect user-bound amount/decimals/fee/swap limits, market identity, and server-held preview source semantics.

## Verification result

- `npm run typecheck`: passed.
- `npm test`: 389 passed, 0 failed (baseline 353).
- `npm pack --dry-run --json --ignore-scripts` and `git diff --check`: passed.
- Installed a packed tarball with production dependencies only; the real `bivium-mcp` binary completed initialize, tools/list (21 tools), and server_info with all four high-level strategies, signing/broadcasting disabled.
- SDK, MCP dispatcher and real stdio fixture coverage includes decimal conversion, fees, swap depth/impact bounds, approval prerequisites, consumed orders, revoked best-price order fallback, input mutation, and stale preview recovery.
- Independent specification/document retrieval and code-quality reviews completed; findings fixed and regression-tested.

Validation is offline/fixture-based except the npm dependency install. No live orders, signatures, or broadcasts were submitted. First release remains testnet core-v2, one market and one full-size fill; depth-aware swap routing depends on a supported initialized pool. Existing order tools provide a separate resting-order flow.
