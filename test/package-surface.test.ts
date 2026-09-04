import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `@bivium/cli/strategies` is consumed as SOURCE by the frontend's Cloudflare Pages Functions (its CI installs
// with --ignore-scripts, so nothing is built on install). That only works while the entry's runtime import
// closure stays free of Node-only modules and of anything that reaches for a chain, a file, or the network.
// This test walks the closure and pins it to the pure allowlist, so a convenience re-export of, say, the
// discovery module cannot quietly turn the package subpath into something a Worker refuses to bundle.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/sdk/strategies/pure.ts";
const ALLOWED = new Set([
  ENTRY,
  "src/sdk/strategies/types.ts",
  "src/sdk/strategies/lines.ts",
  "src/sdk/strategies/probability.ts",
  "src/sdk/strategies/payoff.ts",
  "src/sdk/strategies/catalog.ts",
  "src/sdk/strategies/resolve.ts",
  "src/sdk/strategies/quote.ts",
  "src/sdk/strategies/straddle.ts",
  // The leg program and its pool reads: encoding and arithmetic only, with every chain call handed in.
  "src/sdk/strategies/program.ts",
  "src/sdk/strategies/pools.ts",
  // `tick.ts` comes with them: a fill's cost is its price on the grid, which is the one number a program does not
  // get to choose.
  "src/sdk/tick.ts",
  "src/sdk/types.ts",
  "src/sdk/math.ts",
  "src/sdk/market.ts",
]);
const ALLOWED_PACKAGES = new Set(["viem"]);

/** Runtime imports only: `import type` / `export type` are erased and pull nothing into a bundle. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(import|export)\s+type\b/.test(line)) continue;
    const m = line.match(/^\s*(?:import|export)\b[^"']*\bfrom\s+["']([^"']+)["']/) ?? line.match(/^\s*import\s+["']([^"']+)["']/);
    if (m) out.push(m[1]);
  }
  return out;
}

test("the /strategies entry's runtime closure is pure: viem only, no node: modules, no chain/file/network code", () => {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [ENTRY];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      if (spec.startsWith(".")) {
        queue.push(relative(ROOT, resolve(ROOT, dirname(file), spec)));
      } else {
        packages.add(spec);
      }
    }
  }
  const outside = [...seen].filter((f) => !ALLOWED.has(f)).sort();
  assert.deepEqual(outside, [], `files reachable at runtime from ${ENTRY} that are outside the pure allowlist: ${outside.join(", ")}`);
  const foreign = [...packages].filter((p) => !ALLOWED_PACKAGES.has(p)).sort();
  assert.deepEqual(foreign, [], `non-viem or node: imports reachable from ${ENTRY}: ${foreign.join(", ")}`);
  for (const file of seen) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    assert.doesNotMatch(text, /\bfetch\(|\bprocess\.env\b|from "node:/, `${file} must not reach for the network, the environment, or node: modules`);
  }
});

test("package.json publishes the entry under ./strategies and ships the sources it needs", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { exports: Record<string, string>; files: string[] };
  assert.equal(pkg.exports["./strategies"], `./${ENTRY}`);
  assert.ok(existsSync(resolve(ROOT, pkg.exports["./strategies"])));
  assert.ok(pkg.files.includes("src"), "`files` must include src: consumers import the TypeScript sources directly");
  // `npm pack --dry-run` is offline and answers the only question that matters: does the tarball a git install
  // produces actually contain the entry and its closure?
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { files: { path: string }[] }[];
  const paths = new Set(packed[0].files.map((f) => f.path));
  for (const file of ALLOWED) assert.ok(paths.has(file), `${file} missing from the packed tarball`);
});
