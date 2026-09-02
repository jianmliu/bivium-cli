#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/mcp/server.ts");
await main();
