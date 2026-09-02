# Bivium Robinhood Chain Agent Skill Design

**Status:** Confirmed design  
**Date:** 2026-09-02  
**Scope:** Robinhood Chain distribution, agent-facing product tools, risk disclosure, and execution boundaries

## 1. Objective

Bivium will use the existing Robinhood Agent and community Skill ecosystem as its primary distribution channel. It will not build a separate, closed agent platform for the first release.

The Bivium Skill gives a user's agent access to fixed-term, dual-currency credit and option-like strategies whose orders execute through the Bivium CLOB. Its purpose is to translate user goals into inspectable market analysis and signed Bivium actions while preserving the user's control of funds.

The first release targets Robinhood Chain only:

- mainnet chain ID: `4663`;
- testnet chain ID: `46630`;
- current executable development flows remain testnet-only until a separately approved mainnet release.

## 2. Fixed trust boundary

### 2.1 Bivium Core

Bivium Core is an immutable, non-upgradeable, permissionless settlement layer with no administrator. It:

- does not maintain an asset or collateral allowlist;
- does not pause markets, set protocol-wide exposure caps, or approve strategies;
- does not judge prices, collateral quality, or risk;
- does not intervene when an asset is manipulated, frozen, abandoned, or rug-pulled;
- enforces only market identity, authorization, accounting, order execution, and repay-or-deliver settlement.

Optional gates and ratifiers constrain only the markets or offers that voluntarily use them. They are not Core administrators and cannot prevent other permissionless markets from existing.

### 2.2 Agent and Skill

The user's agent decides whether a market satisfies the user's policy. The Skill provides facts, warnings, payoff calculations, transaction construction, and safe operating procedures. It must not describe a market as approved or safe on behalf of Core.

The user owns the capital and the final risk policy. A third-party strategy proposes actions but cannot withdraw funds, change a destination address, expand its own authority, or act outside the user's granted capability.

## 3. Product model

A Bivium market combines:

```text
fixed-term credit + repay-or-deliver settlement + CLOB price discovery
```

The resulting claim has an embedded physically delivered option-like payoff. Borrowing, lending, yield, and option-like tools are therefore different presentations or combinations of the same underlying Bivium positions, not separate protocols.

The initial product catalog is:

1. **Earn on Holdings / 带薪止盈** — lend a held Stock Token, AI asset, or other token; earn a quoted return while accepting delivery or call-away at the market terms.
2. **Buy at Target / 带薪抄底** — lend the quote asset; earn a quoted return while accepting that settlement may deliver the collateral asset.
3. **Capped-Risk Short / 无清算做空** — borrow and sell the target asset using a fully bounded collateral commitment, without mid-term liquidation.
4. **Fixed-Term Borrow / 固定期限借款** — receive the loan asset today and choose before maturity whether to repay or deliver collateral.
5. **Protective Exit / 保护性退出** — combine a borrow position and retained proceeds to establish a bounded exit outcome.
6. **Relative Value / 相对价值** — express a view between two assets, such as an AI asset versus a Stock Token.
7. **Multi-leg structures** — collars, strike spreads, volatility structures, maturity ladders, and rolling strategies assembled from existing CLOB legs.

Single-leg products are the initial priority because they directly add bids, asks, and fills to existing books. Multi-leg products require a separate atomic-router design before being presented as guaranteed combinations.

## 4. Agent distribution architecture

```text
Robinhood or community agent
        -> Bivium Skill
        -> versioned Bivium API/SDK
        -> risk facts and payoff simulation
        -> user policy decision
        -> transaction preview
        -> user signature or scoped session capability
        -> Bivium CLOB and immutable Core
```

The Skill is a thin, auditable instruction and tool-routing layer. Canonical transaction semantics, schemas, market discovery, quotes, and position calculations live in the versioned API/SDK rather than being duplicated in prose.

The Skill may compose with community tools for Stock Token discovery, reference prices, wallet access, swaps, and analytics. Such sources are inputs to the agent's reasoning, not protocol truth. The Skill records their source and freshness and must remain usable when an optional provider is unavailable.

Robinhood Agentic Trading and Robinhood Chain are separate execution domains. Brokerage account data may be used as an explicitly identified reference source, but the Skill must not imply that a brokerage position and an onchain token position are interchangeable. Brokerage order placement is outside a Bivium transaction flow unless Robinhood later publishes and Bivium separately adopts an authorized onchain integration.

## 5. Skill capabilities

The public Skill exposes five capability groups:

### 5.1 Discover

- list existing Bivium markets before proposing a new market;
- identify the complete market domain, including both tokens, strike, maturity, and Core;
- read executable CLOB depth, recent fills, and position state;
- avoid fragmenting liquidity across near-duplicate markets.

### 5.2 Analyze

- calculate principal, face amount, quoted return, collateral commitment, and settlement outcomes;
- show both possible settlement assets;
- simulate collateral declines of at least 50%, 90%, and 100%;
- distinguish observed facts, third-party signals, unknown data, and the agent's conclusion;
- never present maximum quoted yield without principal-at-risk disclosure.

### 5.3 Construct

- resolve a user goal to one or more existing Bivium legs;
- produce a deterministic preview before requesting a signature;
- bind every action to chain, Core, market, strategy, account, amount, expiry, and destination;
- refuse to represent non-atomic multi-leg execution as an atomic strategy.

### 5.4 Execute

- default to a user signature for each transaction;
- optionally use a short-lived, revocable session capability limited by chain, Core, markets, functions, amounts, expiry, and destination;
- never request or expose a raw private key;
- fail closed on domain, ABI lineage, quote, state, authorization, or simulation mismatch;
- never retry a failed financial transaction blindly.

### 5.5 Manage

- inspect orders, fills, positions, repayment deadlines, and claimable settlement;
- cancel resting orders within the user's authority;
- prepare repay, reclaim, claim, and explicitly authorized rollover actions;
- treat every rollover as a new risk decision rather than silent continuation.

## 6. Permissionless risk rules

Risk rules are advisory defaults applied by the Skill or the user's agent. They are not Core restrictions and may be replaced by a user-defined policy.

Before a lending or borrowing action, the Skill should attempt to collect:

- mint, freeze, blacklist, pause, ownership, and upgrade capabilities;
- proxy implementation and recent administrative changes;
- transfer restrictions, fees, and simulated sellability;
- holder concentration and related-address signals;
- executable depth, spread, volume, and exit slippage;
- reference-source identity, agreement, and freshness;
- complete payoff and worst-case delivery.

Every field has one of four states: `observed`, `warning`, `unknown`, or `not_applicable`. Missing data is `unknown`, never a successful check.

For Meme collateral in particular, the Skill must prominently state that a borrower may rationally decline repayment after a collapse and the lender may receive a severely impaired or worthless token. It must also disclose that no-liquidation settlement can be functioning exactly as designed while the lender loses all economically recoverable principal.

A standard machine-readable result is:

```json
{
  "market": "full-domain-identifier",
  "facts": [],
  "warnings": [],
  "unknowns": [],
  "worstCase": {
    "deliveredAsset": "token-address",
    "estimatedPrincipalLossPct": 100
  },
  "decision": "accept | reject | require_user_confirmation",
  "decisionSource": "user-policy | agent-policy"
}
```

`decision` is the decision of the identified policy, never a Bivium Core verdict.

## 7. Third-party strategies

Third-party strategies are permissionless sources of trade proposals. Each proposal carries a `strategyId` for attribution, but registration or verification does not grant custody or certify safety.

The identity chain is:

```text
strategyId -> intentId -> orderId -> fillId -> position and realized outcome
```

Each user has an independent position, cash-flow history, risk limit, and performance record. Aggregate strategy performance cannot be used to charge or represent an individual user's result.

Strategy fees may later be charged from verified realized net profit above a per-user high-water mark. The initial Skill and API must preserve the attribution data needed for this model, but automated performance-fee collection is not required for the initial CLOB distribution release.

## 8. Failure handling

The Skill must stop transaction construction or execution when:

- the chain or Core does not match the selected profile;
- the complete market identity cannot be verified;
- reference data required by the user's policy is missing or stale;
- the preview and executable transaction disagree;
- authorization exceeds the user's declared scope;
- expected order capacity or balances changed before execution;
- a multi-leg plan cannot satisfy its declared atomicity or slippage constraint.

A stopped Skill action does not pause the market. The response must identify whether the failure came from Core state, Bivium infrastructure, a third-party data source, or the user's policy.

## 9. Testing and acceptance

The implementation is acceptable when automated tests demonstrate:

- market discovery returns complete, chain-bound domains;
- deterministic product inputs generate deterministic plans;
- payoff tests cover repayment, delivery, mixed pooled settlement, and total collateral-value loss;
- Meme warnings appear whenever Meme-like collateral is selected or relevant risk facts are unknown;
- risk-provider failure produces `unknown`, not a passing result;
- every write has a preview and domain verification;
- per-transaction signing is the default;
- scoped capabilities cannot exceed their market, function, amount, expiry, or destination bounds;
- third-party strategy attribution survives from intent through fill and position reporting;
- brokerage-reference integration cannot place brokerage orders from a Bivium flow;
- Skill examples and API schemas remain synchronized in CI.

## 10. Initial delivery order

1. Update the existing Bivium Skill to the Robinhood Chain-only product and trust model.
2. Add structured risk facts, warnings, unknowns, and worst-case payoff output.
3. Expose the three initial goal-based flows: Earn on Holdings, Buy at Target, and Capped-Risk Short.
4. Preserve strategy attribution through quote, plan, order, fill, and position reads.
5. Package the Skill for community installation and document composition with external Robinhood Chain Skills.
6. Add scoped session capabilities only after the per-transaction flow and its security tests are complete.

This design does not modify Bivium Core, introduce protocol administration, create asset allowlists, or promise that risk analysis can prevent loss or rug pulls.
