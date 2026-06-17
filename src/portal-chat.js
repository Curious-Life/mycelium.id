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
import { resolveInferenceConfigForTask } from './inference/resolve.js';
import { resolveModelProfile } from './inference/model-profile.js';
import { planGeneration, estimateTokens, trimToTokenBudget } from './inference/token-budget.js';
import { createEgressAuditSink } from './inference/egress.js';
import { createUsageSink } from './inference/usage.js';
import { captureMessage } from './ingest/capture.js';

const POLICY_KEY = 'AI_ACCESS_POLICY';
const CHAT_SOURCE = 'portal-chat';

// Agent identity (spec #4) — a user-chosen name + personality for their assistant,
// persisted in users.settings.agent and surfaced everywhere the AI is referenced
// (chat header via /agents) and in how it speaks (the system preamble below).
const DEFAULT_AGENT_NAME = 'Mycelium';
const PERSONALITIES = ['friendly', 'formal', 'concise', 'creative'];
const PERSONALITY_GUIDE = {
  friendly: 'Be warm, encouraging and personable.',
  formal: 'Maintain a formal, professional tone.',
  concise: 'Be brief and to the point — minimise elaboration.',
  creative: 'Be imaginative and expressive; offer fresh angles.',
};

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
  const harness = createAgentHarness({ onEgress: createEgressAuditSink(db, userId), onUsage: createUsageSink(db, userId, { source: 'chat' }), fetch, logger: (m) => console.error(`[chat] ${m}`) });

  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  async function readPolicy() {
    try { const raw = await db.secrets.get(userId, POLICY_KEY); return normalizePolicy(raw ? JSON.parse(raw) : null); }
    catch { return defaultPolicy(); }
  }

  async function readAgentIdentity() {
    try {
      const a = (await db.users?.getSettings?.(userId))?.agent || {};
      const name = (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : DEFAULT_AGENT_NAME;
      const personality = PERSONALITIES.includes(a.personality) ? a.personality : 'friendly';
      return { name, personality };
    } catch { return { name: DEFAULT_AGENT_NAME, personality: 'friendly' }; }
  }

  // ── GET /agents — single synthetic agent so the UI's picker + per-agent
  //    history filter work. V1 is single-user/single-agent. The name reflects the
  //    user's chosen agent identity (spec #4) so it propagates to the chat header.
  router.get('/agents', async (req, res) => {
    if (!auth(req, res)) return;
    const { name } = await readAgentIdentity();
    res.json({ agents: [{ id: 'personal-agent', name, color: 'amethyst', role: 'Your vault', status: 'online' }] });
  });

  // ── GET/PUT /agent-identity — the assistant's name + personality (spec #4).
  //    Set in onboarding, changeable here; non-secret → plain user settings.
  router.get('/agent-identity', async (req, res) => {
    if (!auth(req, res)) return;
    res.json({ ...(await readAgentIdentity()), personalities: PERSONALITIES });
  });
  router.put('/agent-identity', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const name = String(req.body?.name || '').trim().slice(0, 40) || DEFAULT_AGENT_NAME;
      const personality = PERSONALITIES.includes(req.body?.personality) ? req.body.personality : 'friendly';
      try { await db.users.create(userId, userId); } catch { /* row already exists */ }
      const s = (await db.users.getSettings(userId)) || {};
      await db.users.updateSettings(userId, { ...s, agent: { name, personality } });
      res.json({ ok: true, name, personality });
    } catch { res.status(500).json({ error: 'Could not save agent identity' }); }
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
    // Live-inference signal: a background_jobs row that surfaces in the global
    // header activity feed ("the model is working now"). Content-free per §1.
    let chatJob = null;
    // On client disconnect, clear the live-inference row immediately — nobody is
    // waiting on this turn, so it must not linger as a phantom "Thinking…" (the
    // server turn may keep generating/persisting; that's the harness's concern).
    req.on('close', () => { clientGone = true; ctrl.abort(); if (chatJob) db.activityFeed?.finish?.(chatJob).catch(() => {}); });
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
      if (Date.now() - lastActivity > limit) {
        ctrl.abort();
        // Turn declared stalled. CLEAR the live row here, not just in the finally:
        // a hung upstream fetch (Ollama dropped the request but the promise never
        // settles) can keep the handler from ever reaching the finally, which would
        // otherwise leave a permanent phantom "Thinking…". Null it so the heartbeat
        // below can't re-touch it.
        if (chatJob) { const j = chatJob; chatJob = null; db.activityFeed?.finish?.(j).catch(() => {}); }
      } else if (chatJob && !clientGone) {
        // keep the row fresh during a healthy long generation
        db.activityFeed?.heartbeat?.(chatJob).catch(() => {});
      }
    }, watchTick);

    try {
      send({ type: 'stream_start', streamIndex: 0 });

      const provider = await resolveInferenceConfigForTask(db, userId, 'chat');
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
      // "The model is working" → global activity feed (header indicator). The label
      // is a CONSTANT (never user content / model output) per the §1 feed contract.
      chatJob = await db.activityFeed?.begin?.({ userId, kind: 'inference:chat', stageLabel: isLocal ? 'Thinking · local model' : 'Thinking…' }).catch(() => null);
      const recentN = isLocal ? 5 : 12;
      // Model-aware budgeting: resolve the model's REAL window + output cap and
      // budget the system preamble in TOKENS, replacing the old binary 5000/28000
      // char cap (which starved 128k-window models and overflowed small ones). The
      // probe is fail-soft + cached → no profile ⇒ the legacy char cap below.
      const profile = await resolveModelProfile(provider, { fetch, defaultModel: info.model }).catch(() => null);
      const plan = profile ? planGeneration(profile, { task: 'chat' }) : null;
      const sysCap = isLocal ? 5000 : 28000; // fallback char cap when no profile
      // Local models (small on-box Ollama) are VERY slow to first token when tools
      // are attached — Ollama constrains generation to the tool grammar, which on a
      // 12B reasoning model pushes time-to-first-token to 30s+ (measured). They also
      // use tools poorly. So give local a fast, context-grounded turn (no tools — the
      // briefing is already in the system preamble); cloud keeps the full tool set.

      // System = orientation + getContext briefing + (cloud only) memory retrieval.
      const ident = await readAgentIdentity();
      // Identity preamble (spec #4): the user's chosen name + personality shape who
      // the assistant is and how it speaks, ahead of the static orientation.
      let system = `Your name is ${ident.name}. ${PERSONALITY_GUIDE[ident.personality] || ''} ${CHAT_SYSTEM}`.trim();
      try { const ctx = await handlers.getContext?.({ recentMessages: recentN }); if (typeof ctx === 'string' && ctx) system += `\n\n${ctx}`; } catch { /* honest-empty */ }
      if (!isLocal && policy.domains.includes('search') && typeof handlers.searchMindscape === 'function') {
        send({ type: 'tool_start', name: 'searchMemory' }); lastActivity = Date.now();
        try { const hits = await handlers.searchMindscape({ query: message, limit: 5 }); if (typeof hits === 'string' && hits) system += `\n\n## Possibly relevant to this question\n${hits}`; } catch { /* skip */ }
        send({ type: 'tool_complete', name: 'searchMemory' });
      }
      if (plan) {
        // Leave room for the user message + the model's output within the window.
        const budget = Math.max(512, plan.inputBudget - estimateTokens(message));
        const trimmed = trimToTokenBudget(system, budget);
        system = trimmed.text;
      } else if (system.length > sysCap) {
        system = system.slice(0, sysCap) + '\n\n[context truncated for this model]';
      }

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
        try { result = await harness.streamTurn({ provider, system, userMessage: message, tools: isLocal ? [] : grantedTools, call, send: captureText, signal: ctrl.signal, maxTokens: plan?.maxTokens, numCtx: plan?.numCtx }); lastErr = null; }
        catch (e) { lastErr = e; console.error('[chat] attempt failed:', e?.status || '', e?.message); }
        // A truncated turn is a definitive (if unhappy) completion — the model hit
        // its output cap, so retrying just re-hits it. Stop and surface it below.
        if (clientGone || assistantText.trim() || result?.truncated || attempt >= MAX_RETRIES) break;
      }

      if (!clientGone) {
        if (assistantText.trim() || result?.truncated) {
          // Completed, gracefully cut off mid-stream, OR truncated at the model's
          // output cap. A truncated turn is NOT a success: the (partial) answer is
          // incomplete and any save/edit the model was emitting did not finish
          // (truncated tool-call JSON no-ops). Tell the user explicitly so they
          // don't trust a "saved" that never happened.
          if (result?.truncated) {
            send({ type: 'truncated', message: 'The response hit the model’s output limit and was cut off — it may be incomplete, and any save or edit it was making did not finish. Ask it to continue, or retry with a shorter request (or raise the output limit in Settings → Intelligence).' });
          }
          send({ type: 'done', toolsUsed: result?.toolsUsed || [], truncated: !!result?.truncated });
          res.write('data: [DONE]\n\n');
          // Persist only when there's actual assistant text (a truncated tool-call
          // turn can have none) — never write an empty assistant bubble.
          if (assistantText.trim()) {
            const cap = (role, content) => captureMessage(db, { userId, role, content, source: CHAT_SOURCE, messageType: 'chat' }, enqueueEnrichment);
            cap('user', message).then(() => cap('assistant', assistantText.trim())).catch((e) => console.error('[chat] persist failed:', e?.message));
          }
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
      if (chatJob) db.activityFeed?.finish?.(chatJob).catch(() => {});
      try { res.end(); } catch { /* already closed */ }
    }
  });

  return router;
}

export default portalChatRouter;
