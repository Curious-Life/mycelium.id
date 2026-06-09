// src/portal-chat.js — the in-app chat backend (web + Tauri).
//
// Mounts at /api/v1/portal: the floating ChatFloat UI talks to these three
// endpoints. Unlike an external MCP client (which IS the agent), here the SERVER
// runs a bounded, user-driven tool-use loop (src/agent/harness.js) over the SAME
// 52-tool handler map — but only the tools in the user's GRANTED domains
// (src/agent/tool-domains.js, the "AI Access" policy). One turn → think · call
// vault tools · answer → idle. Not the autonomous loop D5 defers.
//
// SECURITY: auth fail-closed (loopback/authorized only — it decrypts vault
// plaintext); never echo provider/handler error detail to the client (§1); the
// harness audits every model egress (hash+len only, §8); the reply renders in
// the user's own browser (not a channel egress, §11). Chat turns persist through
// the same captureMessage funnel as every other message (encrypted at rest).

import express from 'express';
import { createAgentHarness, describeProvider } from './agent/harness.js';
import { toolsForDomains, normalizePolicy, defaultPolicy, DOMAINS } from './agent/tool-domains.js';
import { resolveInferenceConfig } from './inference/resolve.js';
import { createEgressAuditSink } from './inference/egress.js';
import { captureMessage } from './ingest/capture.js';

const POLICY_KEY = 'AI_ACCESS_POLICY';
const CHAT_SOURCE = 'portal-chat';

// Short, static orientation for the chat agent — the dynamic state comes from the
// getContext preamble appended below (so this stays cache-stable + injection-free).
const CHAT_SYSTEM = [
  'You are the user\'s private Mycelium assistant — speaking with the owner of this',
  'cognitive vault, on their own machine. Be direct, warm and concise.',
  'You have tools to search and act on the vault; prefer recalling from this memory',
  '(search, list, getContext) before answering from general knowledge, and capture',
  'what the user shares when it is worth remembering. The briefing below is your',
  'current working context — treat it as already-known, do not repeat it verbatim.',
].join(' ');

export function portalChatRouter({ db, userId, tools, handlers, enqueueEnrichment, authenticatePortalRequest, fetch }) {
  if (!db) throw new Error('portalChatRouter: db required');
  if (!handlers || typeof handlers !== 'object') throw new Error('portalChatRouter: handlers required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalChatRouter: authenticatePortalRequest required');

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  const harness = createAgentHarness({ onEgress: createEgressAuditSink(db, userId), fetch, logger: (m) => console.error(`[chat] ${m}`) });

  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  async function readPolicy() {
    try { const raw = await db.secrets.get(userId, POLICY_KEY); return normalizePolicy(raw ? JSON.parse(raw) : null); }
    catch { return defaultPolicy(); }
  }

  // ── GET /agents — single synthetic agent so the UI's picker + per-agent
  //    history filter work. V1 is single-user/single-agent.
  router.get('/agents', (req, res) => {
    if (!auth(req, res)) return;
    res.json({ agents: [{ id: 'personal-agent', name: 'Mycelium', color: 'amethyst', role: 'Your vault', status: 'online' }] });
  });

  // ── GET /ai-access — the AI Access policy (for the settings panel). Returns the
  //    catalog of grantable domains alongside the current grant.
  router.get('/ai-access', async (req, res) => {
    if (!auth(req, res)) return;
    const policy = await readPolicy();
    res.json({ policy, domains: DOMAINS.map((d) => ({ key: d.key, label: d.label, description: d.description })) });
  });

  // ── PUT /ai-access — update the policy.
  router.put('/ai-access', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const policy = normalizePolicy(req.body || {});
      await db.secrets.set(userId, { key: POLICY_KEY, value: JSON.stringify(policy), scope: 'personal', description: 'AI access policy (chat agent)' });
      res.json({ ok: true, policy });
    } catch (e) { res.status(500).json({ error: 'Could not save access policy' }); }
  });

  // ── GET /chat/history — recent chat turns mapped to the UI ChatMessage shape.
  //    Omits metadata/entities/embedding (§1/§7) — only id/role/content/timestamp.
  router.get('/chat/history', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const rows = (await db.messages.selectRecent(userId, { limit: 200 })) || [];
      const msgs = rows
        .filter((r) => r.source === CHAT_SOURCE)
        .slice(0, limit)
        .map((r) => ({ id: r.id, role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content || '', timestamp: Date.parse(r.created_at) || Date.now(), source: CHAT_SOURCE }))
        .reverse();   // chronological for display
      res.json({ messages: msgs });
    } catch { res.json({ messages: [] }); }
  });

  // ── POST /chat/stream — the SSE turn.
  router.post('/chat/stream', async (req, res) => {
    if (!auth(req, res)) return;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) { res.status(400).json({ error: 'message required' }); return; }

    const policy = await readPolicy();
    const { tools: grantedTools, unmapped } = toolsForDomains(tools || [], policy.domains);
    if (unmapped.length) console.error(`[chat] ${unmapped.length} registry tools are not domain-mapped (never exposed): ${unmapped.join(', ')}`);

    // SSE setup.
    res.set('Content-Type', 'text/event-stream; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Connection', 'keep-alive');
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } };
    const keepalive = setInterval(() => send({ type: 'keepalive' }), 15000);

    // Reliability model: NO hard overall cap (a productive long turn must not be
    // cut off). Two distinct watchdogs instead of one blunt 90s timer:
    //   • TTFB_MS  — time-to-first-token: how long we wait for the model to START
    //     responding (any token — thinking OR content). A cold local model load +
    //     reasoning warrants more slack than mid-stream, but far less than 90s.
    //   • IDLE_MS  — inter-token: once it's streaming, the gap we tolerate between
    //     tokens before declaring a stall.
    // The moment the FIRST token arrives we (a) flip to the looser IDLE budget and
    // (b) emit `responding` so the UI switches "connecting…" → live immediately.
    // An empty/stalled attempt retries with EXPONENTIAL BACKOFF.
    const TTFB_MS = Number(process.env.MYCELIUM_CHAT_TTFB_MS) || 45000;
    const IDLE_MS = Number(process.env.MYCELIUM_CHAT_IDLE_MS) || 60000;
    const MAX_RETRIES = 2;
    const BACKOFF_BASE_MS = 1000;                     // 1s, 2s, … between retries
    let assistantText = '';
    let lastActivity = Date.now();
    let streaming = false;                            // flipped on the first token
    let clientGone = false;
    let ctrl = new AbortController();                 // re-created per attempt
    req.on('close', () => { clientGone = true; ctrl.abort(); });
    const captureText = (ev) => {
      if (ev.type === 'text_delta' || ev.type === 'tool_start' || ev.type === 'tool_complete' || ev.type === 'thinking_delta') {
        lastActivity = Date.now();
        if (!streaming && (ev.type === 'text_delta' || ev.type === 'thinking_delta')) {
          streaming = true;
          send({ type: 'responding' });               // "the model started responding"
        }
      }
      if (ev.type === 'text_delta' && ev.content) assistantText += ev.content;
      send(ev);
    };
    const watchTick = Math.max(500, Math.min(4000, Math.floor(TTFB_MS / 4)));
    const watchdog = setInterval(() => {
      const limit = streaming ? IDLE_MS : TTFB_MS;    // first-token wait vs inter-token gap
      if (Date.now() - lastActivity > limit) ctrl.abort();
    }, watchTick);

    try {
      send({ type: 'stream_start', streamIndex: 0 });

      const provider = await resolveInferenceConfig(db, userId);
      // NO silent fallback (operator directive): if no model is connected, refuse
      // with an actionable state instead of quietly attempting local Ollama and
      // hanging for 90s. describeProvider() returns null iff nothing is configured.
      const info = describeProvider(provider);
      if (!info) {
        send({ type: 'no_model', message: 'No AI model is connected. Open Settings → Connect AI to add a cloud key or pull a local model.' });
        send({ type: 'done', toolsUsed: [] });
        return;
      }
      // Tell the UI exactly which provider + model is answering (carries no secrets).
      send({ type: 'model', label: info.label, model: info.model, jurisdiction: info.jurisdiction, local: info.local });
      // Size the preamble to the model: a small/local model (8B Ollama) chokes on
      // a full-vault briefing — it gets slow or silently truncates. A capable
      // cloud model takes the full context. (jurisdiction:'local' = on-box.)
      const isLocal = info.local;
      const recentN = isLocal ? 5 : 12;
      const sysCap = isLocal ? 5000 : 28000;

      // System = orientation + getContext briefing + (cloud only) memory retrieval.
      let system = CHAT_SYSTEM;
      try { const ctx = await handlers.getContext?.({ recentMessages: recentN }); if (typeof ctx === 'string' && ctx) system += `\n\n${ctx}`; } catch { /* honest-empty */ }
      if (!isLocal && policy.domains.includes('search') && typeof handlers.searchMindscape === 'function') {
        send({ type: 'tool_start', name: 'searchMemory' }); lastActivity = Date.now();
        try { const hits = await handlers.searchMindscape({ query: message, limit: 5 }); if (typeof hits === 'string' && hits) system += `\n\n## Possibly relevant to this question\n${hits}`; } catch { /* skip */ }
        send({ type: 'tool_complete', name: 'searchMemory' });
      }
      if (system.length > sysCap) system = system.slice(0, sysCap) + '\n\n[context truncated for this model]';

      const grantedNames = new Set(grantedTools.map((t) => t.name));
      const call = async (name, args) => {
        if (!grantedNames.has(name)) return `Tool '${name}' is not enabled for this conversation.`;
        const h = handlers[name];
        if (typeof h !== 'function') return `Unknown tool: ${name}`;
        const out = await h(args || {});
        return typeof out === 'string' ? out : JSON.stringify(out);
      };

      // Attempt loop: retry the whole turn while it produced NOTHING (stalled or
      // errored before any token). Once any text streams, we keep it — no retry
      // (re-streaming would duplicate into the same bubble).
      let result = null;
      let lastErr = null;
      for (let attempt = 0; ; attempt++) {
        if (clientGone) break;
        if (attempt > 0) {
          // Exponential backoff before re-attempting a turn that produced nothing.
          const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);   // 1s, 2s, …
          await new Promise((r) => setTimeout(r, backoff));
          if (clientGone) break;
          ctrl = new AbortController(); lastActivity = Date.now(); streaming = false;
          send({ type: 'retry', attempt });
          console.error(`[chat] empty/stalled — retry ${attempt}/${MAX_RETRIES} after ${backoff}ms`);
        }
        try { result = await harness.streamTurn({ provider, system, userMessage: message, tools: grantedTools, call, send: captureText, signal: ctrl.signal }); lastErr = null; }
        catch (e) { lastErr = e; console.error('[chat] attempt failed:', e?.status || '', e?.message); }
        if (clientGone || assistantText.trim() || attempt >= MAX_RETRIES) break;
      }

      if (!clientGone) {
        if (assistantText.trim()) {
          // Completed OR gracefully cut off mid-stream — keep the (possibly partial) answer.
          send({ type: 'done', toolsUsed: result?.toolsUsed || [] });
          res.write('data: [DONE]\n\n');
          const cap = (role, content) => captureMessage(db, { userId, role, content, source: CHAT_SOURCE, messageType: 'chat' }, enqueueEnrichment);
          cap('user', message).then(() => cap('assistant', assistantText.trim())).catch((e) => console.error('[chat] persist failed:', e?.message));
        } else {
          // Surface an ACTIONABLE reason from the upstream status (safe: status
          // codes + the provider label/model carry no secrets, per §1). A bare
          // "didn't respond" hides config problems like a wrong model name or key.
          const st = lastErr?.status;
          const who = info.label || 'The model';
          let msg = `${who} didn’t respond after several tries. Try another model in Settings → Intelligence.`;
          if (st === 401 || st === 403) msg = `${who} rejected the request — the API key looks invalid. Update it in Settings → Intelligence.`;
          else if (st === 404 || st === 400) msg = `${who} didn’t recognise the model “${info.model}”. Pick a valid model in Settings → Intelligence.`;
          else if (st === 429) msg = `${who} is rate-limited right now. Wait a moment or switch model in Settings → Intelligence.`;
          else if (st >= 500) msg = `${who} had a server error. Try again, or switch model in Settings → Intelligence.`;
          send({ type: 'error', message: msg });
          send({ type: 'done', toolsUsed: [] });
        }
      }
    } catch (err) {
      console.error('[chat] turn failed:', err?.message);
      if (!res.headersSent) { res.status(500).json({ error: 'Chat failed' }); return; }
      send({ type: 'error', message: 'Chat failed' });   // never echo err.message (§1)
      send({ type: 'done', toolsUsed: [] });
    } finally {
      clearInterval(keepalive);
      clearInterval(watchdog);
      try { res.end(); } catch { /* already closed */ }
    }
  });

  return router;
}

export default portalChatRouter;
