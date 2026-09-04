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

Any other SKILL.md-compatible agent: keep the whole `skills/bivium/` directory, including
`references/`, and point it at `skills/bivium/SKILL.md`.

The skill drives the CLI in this repo (`git clone` + `npm install`, Node >= 20) against Bivium
Robinhood Chain testnet (46630). Sepolia and local anvil deployments are historical development
references, not executable public Skill targets. Follow the Skill's signer-storage rules and
per-transaction approval requirements; mainnet is identity/reference-only, not executable.
