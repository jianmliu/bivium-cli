import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

test("all distributed operator and conversation references ship with matching repo-local copies", () => {
  const root = new URL("../skills/bivium/references/", import.meta.url);
  const localRoot = new URL("../.claude/skills/bivium/references/", import.meta.url);
  const files = readdirSync(root).sort();
  assert.ok(files.includes("operators.md"), "the operator workflow must be packaged with the Skill");
  assert.deepEqual(readdirSync(localRoot).sort(), files);
  for (const file of files) {
    assert.equal(readFileSync(new URL(file, localRoot), "utf8"), readFileSync(new URL(file, root), "utf8"));
  }
});

test("the distributable skill and the repo-local skill are the same file", () => {
  const dist = readFileSync(new URL("../skills/bivium/SKILL.md", import.meta.url), "utf8");
  const local = readFileSync(new URL("../.claude/skills/bivium/SKILL.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(local, dist, "skills/bivium/SKILL.md and .claude/skills/bivium/SKILL.md have drifted — edit one and copy to the other");

  for (const required of [
    "Robinhood Chain",
    "immutable",
    "non-upgradeable",
    "permissionless",
    "MEME_DELIVERY_RISK",
    "strategy assess",
    "require_user_confirmation",
  ]) {
    assert.match(dist, new RegExp(required, "i"), `the public Skill must document ${required}`);
  }

  for (const required of [
    /external[^.]*untrusted data/i,
    /never instructions/i,
    /ignore[^.]*embedded instructions[^.]*tool requests/i,
    /validate[^.]*schema[^.]*source[^.]*freshness/i,
    /cannot[^.]*alter[^.]*receiver[^.]*destination/i,
    /cannot[^.]*expand[^.]*transfer[^.]*authority/i,
    /cannot[^.]*request[^.]*custody[^.]*private keys/i,
    /cannot[^.]*exceed[^.]*user[^.]*capability/i,
    /re-preview[^.]*composition/i,
    /DEFAULT_AGENT_POLICY/i,
    /assessRisk[^.]*source[^.]*user-policy[^.]*rules/i,
    /same market and evidence/i,
    /no CLI[^.]*bypass[^.]*accept flag/i,
    /testnet[^.]*46630[^.]*only executable/i,
    /mainnet[^.]*4663[^.]*do not[^.]*write/i,
    /market list --json/i,
    /book list/i,
    /borrow quote/i,
    /--dry-run/i,
    /borrow execute/i,
    /repay --offer/i,
    /claim/i,
  ]) {
    assert.match(dist, required, `the public Skill must satisfy ${required}`);
  }

  for (const document of [dist, readme]) {
    assert.doesNotMatch(document, /0x<[^>]+>/i, "examples must use valid hex rather than shell metacharacter placeholders");
    assert.doesNotMatch(document, /(?:Bivium\s+)?Core\s+(?:approves|allowlists|pauses)\b/i);
    assert.match(document, /wallet create --out agent\.key/i);
    assert.match(document, /wallet address --key-file agent\.key/i);
    assert.match(document, /KEY_FILE='agent\.key'/);
    assert.match(document, /borrow execute[^\n]*--key-file "\$KEY_FILE"/i);
    assert.match(document, /repay --offer[^\n]*--key-file "\$KEY_FILE"/i);
    assert.match(document, /reclaim --offer[^\n]*--key-file "\$KEY_FILE"/i);
    assert.match(document, /borrower signer[^.]*borrow execute[^.]*repay[^.]*reclaim/i);
    assert.match(document, /current DCN\s+credit\s+holder[^.]*lender[^.]*secondary buyer/i);
    assert.match(document, /HOLDER_KEY_FILE='holder\.key'/);
    assert.match(document, /\bclaim\b[^\n]*--key-file "\$HOLDER_KEY_FILE"/i);
    assert.doesNotMatch(document, /\bclaim\b[^\n]*--key-file "\$KEY_FILE"/i);
    assert.doesNotMatch(document, /--private-key\b/i, "public instructions must never put a private key in CLI arguments");
  }

  for (const retainedReference of [
    /## Choosing a runtime/i,
    /## Sandboxed agents \(Docker\)/i,
    /## Safety model/i,
    /maker make-offer/i,
    /borrow quote/i,
    /repay[^\n]*reclaim/i,
    /## Whole-lot vault app/i,
    /## DCN secondary trading/i,
    /trade buy/i,
    /strategy catalog --json/i,
    /strategy assess/i,
    /strategy trace/i,
    /strategy list --json/i,
    /strategy quote --strategy/i,
    /strategy plan --strategy/i,
    /bivium-mcp/i,
    /strategy_list[^]*market_list[^]*strategy_quote[^]*strategy_plan/i,
    /MCP server has no transaction execution or signing tool/i,
  ]) {
    assert.match(readme, retainedReference, `README must retain ${retainedReference}`);
  }
});

test('MCP workflow reference ships and stays synchronized', () => {
  const dist = readFileSync(new URL('../skills/bivium/references/mcp.md', import.meta.url), 'utf8');
  const local = readFileSync(new URL('../.claude/skills/bivium/references/mcp.md', import.meta.url), 'utf8');
  assert.equal(dist, local);
  for (const text of ['action_preview', 'action_prepare', 'mm_preview', 'order_prepare', 'submission_unknown', 'order_cancel_prepare', 'order_delist', 'netProfitLowerBound=null', 'maxTopUp', 'raw integer strings']) assert.ok(dist.includes(text), text);
  assert.ok(readFileSync(new URL('../skills/bivium/SKILL.md', import.meta.url), 'utf8').includes('(references/mcp.md)'));
});

test('operator reference exposes the exact policy-to-bounded-calldata mapping', () => {
  const guide = readFileSync(new URL('../skills/bivium/references/operators.md', import.meta.url), 'utf8');
  const mappings = new Map([...guide.matchAll(/^(deadline|maxDebt|maxLoanBalance|maxCollateralBalance) = (.+)$/gm)]
    .map(([, field, value]) => [field, value]));
  assert.deepEqual(Object.fromEntries(mappings), {
    deadline: 'min(policy.endsAt, market.maturity)',
    maxDebt: 'market.keeper.maxDebtRaw',
    maxLoanBalance: 'loanToken.maxWalletBalanceRaw',
    maxCollateralBalance: 'collateralToken.maxWalletBalanceRaw',
  });
  for (const identifier of ['settleWithFlashBounded', 'BoundedFlashSettled', 'minNetProfitRaw', 'otherCostsRaw']) {
    assert.ok(guide.includes(identifier), `operator schema/receipt reference must include ${identifier}`);
  }
});

test('operator recovery documents the keyless command independently of execution', () => {
  const guide = readFileSync(new URL('../skills/bivium/references/operators.md', import.meta.url), 'utf8');
  const reconcileCommands = guide.split('\n').filter(line => line.startsWith('npm run session -- reconcile'));
  assert.deepEqual(reconcileCommands, ['npm run session -- reconcile --state-dir "$STATE_DIR"']);
  const blocks = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map(([, commands]) => commands);
  const recovery = blocks.find(commands => commands.includes('npm run session -- reconcile'));
  assert.ok(recovery, 'keyless recovery must be a discoverable command example');
  assert.doesNotMatch(recovery, /--key-file|--policy|--confirm|session -- (?:approve|run)\b/,
    'recovery must not require execution credentials or renewed approval');
});

test('manual bounded keeper routing is explicitly separate from operator automation', () => {
  const skill = readFileSync(new URL('../skills/bivium/SKILL.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../skills/bivium/references/operators.md', import.meta.url), 'utf8');
  for (const document of [skill, guide]) {
    assert.ok(document.includes('--via-jit-bounded'), 'manual bounded mode must be discoverable');
    assert.match(document, /separately authorized single transaction/i);
    assert.match(document, /not[^\n]*automation[^\n]*budget approval/i);
  }
});
test('first-release strategy workflow states sizing and exact preview continuation',()=>{
 const reference=readFileSync(new URL('../skills/bivium/references/mcp.md',import.meta.url),'utf8');
 for(const text of ['strategy_preview','maxInput','maxPriceImpactBps','lendAsset','lendQuote','leveredLong','short','sizing basis','full-size','original high-level request'])assert.ok(reference.includes(text),text);
});
