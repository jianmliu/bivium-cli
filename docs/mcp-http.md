# Remote MCP

The CLI supports stdio and authenticated Streamable HTTP (MCP 2025-06-18, JSON response mode). The Cloudflare deployment exposes `/mcp`; `/health` is a public liveness check. GET `/mcp` returns 405 because this server has no standalone SSE stream. Use a client with configurable Authorization headers; automatic OAuth login is not implemented.

## Deployed endpoint

- Streamable HTTP: `https://bivium-mcp.liujm06.workers.dev/mcp`
- Public health check: `https://bivium-mcp.liujm06.workers.dev/health`
- Cloudflare Worker: `bivium-mcp`, Robinhood testnet (chain 46630).
- Verified 2026-09-10 using the official MCP SDK: all 10 acceptance checks passed, with 21 tools and 40 live markets. See [deployment evidence](validation/2026-09-10-mcp-http-deployment.json).
- Requires a private Bearer token. A client that cannot supply Authorization headers needs an authentication adapter; OAuth discovery/login is not provided.

## Local Node server

Set `BIVIUM_MCP_TOKEN` from a private local file/environment (at least 32 characters), then run:

```sh
node bin/bivium-mcp.mjs --transport http --profile profiles/robinhood-testnet.json --policy-file /absolute/path/policies.json --port 8787
```

The listener defaults to 127.0.0.1. `--auth-token-env NAME` selects a different environment variable. `--allowed-origin https://your-agent.example` permits one browser origin in addition to the endpoint's own origin. Native MCP clients normally send no Origin. The token is never a URL query parameter. Keep any reverse proxy on HTTPS and preserve Authorization, Mcp-Session-Id and MCP-Protocol-Version headers. Remote relayer publication is disabled; `--allow-relayer-writes` is rejected with HTTP transport.

## Cloudflare deployment from the source repository

```sh
npm ci
npm run typecheck
npm test
npx wrangler deploy --config wrangler.mcp.toml --dry-run
npx wrangler deploy --config wrangler.mcp.toml
npx wrangler secret put BIVIUM_MCP_TOKEN --config wrangler.mcp.toml < /absolute/private/token-file
```

Before the secret is configured, `/mcp` returns 503. The named Worker is separate from the Pages frontend, relayer and keepers. `wrangler.mcp.toml` binds a SQLite-capable Durable Object; only ephemeral session memory is used. Schema validators and a normalized testnet profile are generated at build time; no dynamic schema compilation occurs inside Workers. The generated files are excluded from git.

The bundled deployment uses Robinhood testnet core-v2 and policy ID `conservative`. Its risk settings are DEFAULT_AGENT_POLICY: missing evidence requires confirmation, arbitrary mint and unsellable collateral are rejected. The permissive mock-token policy used in prior local acceptance is not deployed. No wallet private keys, signing or broadcasting are included. `order_publish` and `order_delist` remain discoverable for compatibility but refuse remote writes; `server_info` reports relayerWrites=false.

## Client configuration and sessions

Configure the actual deployment URL as the client's Streamable HTTP endpoint and supply:

```text
Authorization: Bearer <your locally stored access token>
```

The token grants access to this private service; it is not a wallet key. Do not commit it or put it in the URL. The official MCP SDK handles initialize, initialized notification, protocol headers and session IDs. An initial request must accept both `application/json` and `text/event-stream`; responses use JSON. Sessions expire after 15 minutes idle and may end earlier if Cloudflare evicts/restarts the Durable Object. HTTP 404 means initialize again and obtain fresh previews; do not reuse old preview IDs. State is isolated per session, so a preview made by one client cannot be prepared by another.

There are at most 32 sessions, 8 concurrent requests, 120 messages/minute/session, 60 initialize attempts/minute/coordinator, 1 MiB request bodies, and a 10-second body-read deadline. Existing per-tool/RPC deadlines still apply. DELETE ends a session and cancels its active work; `notifications/cancelled` cancels a matching request in that session. An HTTP disconnect alone does not imply cancellation. Session eviction/preview expiry are safe failures, not a persistent execution queue. HTTP order preparations are also ephemeral and cannot be published by this deployment.

Verify an endpoint without trades:

```sh
node scripts/smoke-mcp-http.mjs --url https://your-worker.workers.dev/mcp --token-file /absolute/private/token-file --live
```

This uses the official MCP client to check auth, origin, tools, schema validation, live market discovery, conservative policy and session deletion. It never signs or submits a transaction.
