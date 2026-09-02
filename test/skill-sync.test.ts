import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("the distributable skill and the repo-local skill are the same file", () => {
  const dist = readFileSync(new URL("../skills/bivium/SKILL.md", import.meta.url), "utf8");
  const local = readFileSync(new URL("../.claude/skills/bivium/SKILL.md", import.meta.url), "utf8");
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

  assert.doesNotMatch(dist, /Bivium Core (approves|allowlists|pauses)/i);
});
