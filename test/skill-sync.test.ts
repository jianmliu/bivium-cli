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
