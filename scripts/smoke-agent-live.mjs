#!/usr/bin/env node
// smoke:agent-live — HOST smoke (needs real secrets; NOT a CI gate).
// Proves a REAL Claude Agent SDK turn attaches to the running vault MCP over HTTP
// and runs to completion. Read-only by default (asks the agent to call getContext),
// so it does NOT require the daemon/Telegram — it isolates the SDK↔vault leg.
//
// Prereqs on the operator's machine:
//   1. npm i @anthropic-ai/claude-agent-sdk
//   2. vault running on :4711 booted with MYCELIUM_MCP_BEARER set
//   3. run:
//      ANTHROPIC_API_KEY=… MYCELIUM_MCP_URL=http://127.0.0.1:4711/mcp \
//      MYCELIUM_MCP_BEARER=… node scripts/smoke-agent-live.mjs
//
// To smoke the FULL two-way loop (reply→Telegram) instead, run the daemon
// (npm run channel:telegram) with the vault booted with AGENT_URL=<daemon> and
// send it a real Telegram message — that exercises the reply tool for real.
import { createClaudeSdkRuntime, createReplyTracker } from '../packages/channel-daemon/agent/backends/claude-sdk.js';

const key = process.env.ANTHROPIC_API_KEY;
const mcpUrl = process.env.MYCELIUM_MCP_URL || 'http://127.0.0.1:4711/mcp';
const mcpBearer = process.env.MYCELIUM_MCP_BEARER;

if (!key) { console.error('NO-GO: set ANTHROPIC_API_KEY.'); process.exit(1); }
if (!mcpBearer) { console.error('NO-GO: set MYCELIUM_MCP_BEARER (must match the vault).'); process.exit(1); }

const runtime = createClaudeSdkRuntime({
  anthropicApiKey: key,
  mcpMode: 'http',
  mcpUrl,
  mcpBearer,
  model: process.env.CHANNEL_AGENT_MODEL || 'claude-sonnet-4-6',
  // read-only smoke: only allow getContext so we never send/write
  allowedTools: ['mcp__mycelium__getContext'],
  maxTurns: 4,
});

console.log(`[smoke] running a real SDK turn against ${mcpUrl} …`);
try {
  const r = await runtime.runTurn({
    turnCtx: { source: 'telegram', channelKind: 'telegram', channelId: 'smoke' },
    userMessage: 'Call the getContext tool, then reply in one sentence summarizing what you can see. Do not call any other tool.',
  });
  // reply tool isn't allowed here, so usedReplyTool=false is expected; the point
  // is the turn ran without auth/connection error.
  console.log(`[smoke] turn completed. result=${JSON.stringify(r)}`);
  console.log('VERDICT: GO — SDK attached to the vault MCP and ran a real turn.');
} catch (e) {
  console.error(`[smoke] FAILED: ${e.message}`);
  console.error('Common causes: SDK not installed (npm i @anthropic-ai/claude-agent-sdk), wrong/absent MYCELIUM_MCP_BEARER, or the vault not running on the MCP URL.');
  process.exit(1);
}
void createReplyTracker; // referenced for symmetry; full-loop smoke uses it via runTurn
