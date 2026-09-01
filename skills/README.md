# Bivium agent skills

Distributable [Agent Skills](https://code.claude.com/docs/en/skills) for operating the Bivium
protocol. Each skill is a directory holding a `SKILL.md`; the copy under `.claude/skills/` (which
Claude Code auto-loads inside this repo) is kept byte-identical by a test, so this directory is
the same skill packaged for use anywhere else.

## Install

Claude Code, per-project:

```bash
cp -r skills/bivium /path/to/your/project/.claude/skills/
```

Claude Code, all projects on a machine:

```bash
cp -r skills/bivium ~/.claude/skills/
```

Any other SKILL.md-compatible agent: point it at `skills/bivium/SKILL.md`.

The skill drives the CLI in this repo (`git clone` + `npm install`, Node >= 20) against Bivium
testnet deployments — Robinhood Chain testnet (46630), Sepolia, or a local anvil chain. Everything
is testnet-only with valueless mock assets; the skill's own rules require keys via env vars only
and refuse mainnet work.
