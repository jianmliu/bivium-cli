# DCN secondary route boundary — 2026-09-25

The Robinhood testnet frontend already exposes Pro DCN trading. This review concerns safe compatibility for agent-generated wallet transactions, not a decision to disable the frontend or protocol.

## Source-bound conclusion

Reviewed Core worktree: `/Users/jianmingliu/.config/superpowers/worktrees/bivium-core/mnvda-refill-evm-20260924`, commit `c896612`.

`StrategyRouter` does not guarantee no new debt merely because a `FILL_BID` has `maxTopUp=0` and no inner program:

- `src/Bivium.sol:307–332`: remaining live credit is moved; any uncovered units become new debt before maturity.
- `src/periphery/StrategyRouter.sol:284–299`: the fill returns collateralPosted but does not reject a positive value.
- `src/periphery/StrategyRouter.sol:315–324`: collateral already held by the Router is used before wallet funding. maxTopUp bounds only the wallet shortfall.
- `test/periphery/StrategyRouter.t.sol:333–350`: the straddle test deliberately originates the second debt leg with zero top-up and empty inner legs using scratch from the first leg.

Consequently, credit may change after preview and an existing or donated Router balance may fund new debt. A snapshot credit check, simulation, or after-the-fact account check is not an execution-time no-debt guarantee. Agent `sell_dcn` must retain its pre-maturity rejection for this route.

Fresh local verification: `forge test --match-contract StrategyRouterTest --match-test test_straddle_theCashPrincipalOfLegOneIsLegTwosCollateral -vv` passed (1 test, zero failures/skips). Compilation emitted an existing ShortRouter variable-shadowing warning. This verifies the scratch-funded zero-top-up behavior; it is not a newly implemented full donation/credit-race exploit test.

## Alternatives are not silent fallbacks

A direct Core fill on the inspected immutable OriginationGate with a non-router caller can reject attempted origination through the hook while allowing a pure secondary transfer. However, it bypasses the Router service fee and is not equivalent to the agreed fee-bearing Pro route. It is not automatically substituted.

`RfqIntentSettlementRouterV3` has a genuine maxDebtIncrease guard, but it belongs to a distinct maker-submitted RFQ/Permit2 flow. This review has not established a verified supported Robinhood deployment. Neither switching protocols nor deploying a new guard is authorized by this local compatibility update.

## Required capability boundary

- Fee-bearing DCN buys: admit only a compatible verified market Router, with fees included in maximum payment.
- Pre-maturity pure-secondary sells: explicitly unavailable until an execution-time no-new-debt route is verified.
- Origination: explicit separate borrow intent, bounded collateral and net proceeds; never convert a sell intent automatically.
- Repay, claim, withdraw, cancellation and historical access: remain separate recovery paths.

This is a source audit of a pinned implementation, not a new live runtime equivalence proof. No wallet keys, signatures, broadcasts or deployment changes were used.
