/**
 * Poke integration for AgentSwarm
 *
 * All Poke-related files live in this directory:
 *
 *   poke/
 *     server.ts        — MCP server exposing swarm tools to Poke
 *     notifier.ts      — Push alerts to your phone via Poke SDK
 *     state-writer.ts  — Writes metrics/tasks JSON for the MCP server
 *     Dockerfile        — Railway deployment container
 *     index.ts          — This barrel file
 *
 * Quick start:
 *   1. npx poke login
 *   2. pnpm poke:dev          (start MCP server)
 *   3. pnpm poke:tunnel       (tunnel to Poke cloud)
 *   4. Connect at poke.com/integrations/new
 *
 * For Railway deployment:
 *   - Use poke/Dockerfile
 *   - Railway provides PORT automatically
 *   - Then: npx poke mcp add https://<your-railway-domain>/mcp --name "AgentSwarm"
 *   - No API key needed between Railway and Poke — Poke auth is via `npx poke login`
 */

export { PokeNotifier, createPokeNotifier } from "./notifier.js";
export type { PokeNotifierConfig } from "./notifier.js";
export { PokeStateWriter } from "./state-writer.js";
