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
import { resolveHarness } from './agent/resolve-harness.js';
import { toolsForDomains, normalizePolicy, defaultPolicy, DOMAINS, ALL_SCOPES } from './agent/tool-domains.js';
import { resolveInferenceConfigForTask } from './inference/resolve.js';
import { resolveModelProfile } from './inference/model-profile.js';
import { planGeneration, estimateTokens, trimToTokenBudget } from './inference/token-budget.js';
import { createEgressAuditSink } from './inference/egress.js';
import { createUsageSink } from './inference/usage.js';
import { captureMessage } from './ingest/capture.js';
import { hydrateHistoryBlock } from './agent/history.js';
import { AGENT_NATURE } from './agent/identity.js';

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

// The chat agent's identity — the single highest-leverage prompt in the app (it
// is the whole self of the primary surface). STATIC by design: dynamic state
// comes from the getContext preamble appended below, so this stays cache-stable
// (Anthropic prompt cache) + injection-free (no vault data interpolated here).
//
// Opens with the SHARED AGENT_NATURE fragment (identity.js) so chat and the
// reflection cycles read as ONE entity, then adds the live-chat mode guidance:
// the sovereign-vault framing + competence/guest/bold-internal-careful-external
// posture distilled from the operational personas this product draws on.
const CHAT_SYSTEM = `${AGENT_NATURE}

You're speaking with them live, on their own machine — their sovereign cognitive vault, where their notes, people, reflections, relationships and meaning-making all live. They've trusted you with the whole of it; treat that intimacy with care.

How you show up:
- Be direct, warm and concise. Skip the filler ("Great question!", "I'd be happy to help!") — just help. Have real opinions; it's fine to disagree, to prefer things, to push back when it serves them. Earn trust through competence, not eagerness.
- Be resourceful before asking. Recall from this memory first — search, list, getContext — and read the relevant document before answering from general knowledge. Come back with answers, not questions, when you can; admit uncertainty plainly when you can't.
- Be bold with internal actions (search, read, organize, remember) and careful with anything that leaves the vault. Capture what the owner shares when it's genuinely worth remembering — not performatively.

The briefing below is your current working context — treat it as already-known; weave it in, don't repeat it back verbatim.`;

// Capability line, appended per-turn. Constant text (injection-free, cache-stable);
// which one is chosen depends only on whether this turn actually carries action tools
// (capability-gated below — a tool-capable model, cloud OR local, gets them). A model
// like Claude infers "I can write" from the tool schemas, but open/EU/local models —
// and any model the preamble frames as a read-only "memory" — otherwise refuse to
// write and tell the user they "can't access files". CAN_ACT states the capability
// plainly and maps the user's words ("files", "notes") onto the vault tools.
// CANNOT_ACT is the honest fallback when no tools are attached, with how to enable.
const CAN_ACT = [
  'You can ACT on this vault, not only read it. When the user asks you to write, save,',
  'change, edit or organise something, DO IT with your tools rather than declining:',
  'saveDocument / updateDocument create and revise their documents; editMindFile,',
  'writeMindFileWhole and updateInternalModel edit your internal model of them; and',
  'remember, link, mark, createTask and captureMessage record facts, relations and',
  'tasks. "Files", "notes" and "documents" mean items inside this vault reached through',
  'these tools — not the operating-system filesystem. Confirm first only when an action',
  'is destructive or ambiguous; otherwise just do it and report what you did.',
].join(' ');
const CANNOT_ACT = [
  'No action tools are attached this turn, so you can discuss and recall but cannot',
  'create or edit documents right now. If the user asks you to write, save or change',
  'something, say so plainly and tell them how to enable it: pick a tool-capable model',
  'for the chat task in Settings → Intelligence, and grant the Documents and Mind files',
  'areas in Settings → AI Access.',
].join(' ');

export function portalChatRouter({ db, userId, tools, handlers, enqueueEnrichment, authenticatePortalRequest, fetch, restPort }) {
  if (!db) throw new Error('portalChatRouter: db required');
  if (!handlers || typeof handlers !== 'object') throw new Error('portalChatRouter: handlers required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalChatRouter: authenticatePortalRequest required');

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  const chatLog = (m) => console.error(`[chat] ${m}`);
  const harness = createAgentHarness({ onEgress: createEgressAuditSink(db, userId), onUsage: createUsageSink(db, userId, { source: 'chat' }), fetch, logger: chatLog });
  // The agent engine (harness) is resolved PER TURN by resolveHarness (below): 'native'
  // (default) = the in-process agent loop — the watchdog + retry turn-driver extracted
  // from this route so the same core serves channel + scheduler turns; 'cli' = the
  // Claude Code engine (C2). The native path is behavior-identical to the previous
  // module-scoped loop. See docs/HARNESS-CLI-DESIGN-2026-07-02.md.

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
      // Channel writes are ON by default for the personal agent (the per-agent toggle in
      // the Agents page; mirrors resolve-grant.ownerWriteEnabled — undefined ⇒ on).
      const channelWrite = a.channelWrite !== false;
      const scopes = Array.isArray(a.scopes) && a.scopes.length ? a.scopes.filter((s) => ALL_SCOPES.includes(s)) : [...ALL_SCOPES];
      return { name, personality, channelWrite, scopes };
    } catch { return { name: DEFAULT_AGENT_NAME, personality: 'friendly', channelWrite: true, scopes: [...ALL_SCOPES] }; }
  }

  // ── GET /agents — single synthetic agent so the UI's picker + per-agent
  //    history filter work. V1 is single-user/single-agent. The name reflects the
  //    user's chosen agent identity (spec #4) so it propagates to the chat header.
  router.get('/agents', async (req, res) => {
    if (!auth(req, res)) return;
    const { name } = await readAgentIdentity();
    res.json({ agents: [{ id: 'personal-agent', name, color: 'amethyst', role: 'Your vault', status: 'online' }] });
  });

  // ── GET/PUT /agent-identity — the assistant's name + personality + capability scopes +
  //    the channel-write toggle (spec #4 + Agents page). Non-secret → plain user settings.
  //    PUT MERGES into the existing agent settings (a partial update of one field must not
  //    wipe the others — e.g. toggling channelWrite must keep name/scopes).
  router.get('/agent-identity', async (req, res) => {
    if (!auth(req, res)) return;
    res.json({ ...(await readAgentIdentity()), personalities: PERSONALITIES, allScopes: [...ALL_SCOPES] });
  });
  router.put('/agent-identity', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      try { await db.users.create(userId, userId); } catch { /* row already exists */ }
      const s = (await db.users.getSettings(userId)) || {};
      const agent = { ...(s.agent || {}) };
      if (req.body?.name !== undefined) agent.name = String(req.body.name || '').trim().slice(0, 40) || DEFAULT_AGENT_NAME;
      if (req.body?.personality !== undefined) agent.personality = PERSONALITIES.includes(req.body.personality) ? req.body.personality : 'friendly';
      if (typeof req.body?.channelWrite === 'boolean') agent.channelWrite = req.body.channelWrite;
      if (Array.isArray(req.body?.scopes)) {
        const sc = req.body.scopes.filter((x) => ALL_SCOPES.includes(x));
        agent.scopes = sc.length ? sc : [...ALL_SCOPES];   // never empty — full access is the floor
      }
      if (agent.name === undefined) agent.name = DEFAULT_AGENT_NAME;
      if (agent.personality === undefined) agent.personality = 'friendly';
      await db.users.updateSettings(userId, { ...s, agent });
      res.json({ ok: true, name: agent.name, personality: agent.personality, channelWrite: agent.channelWrite !== false, scopes: Array.isArray(agent.scopes) ? agent.scopes : [...ALL_SCOPES] });
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
  //    With ?conversationId= the history is scoped to that ONE thread (Phase 5 chat
  //    threading); without it, the legacy cross-thread recent view (pre-threading
  //    turns carry no conversation_id, so they only surface here).
  router.get('/chat/history', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      // Same `chat:` namespace as /chat/stream (red-team RT3) — a chat read can only ever
      // see chat-sourced threads, never a channel conversation.
      const rawConv = typeof req.query.conversationId === 'string' ? req.query.conversationId.trim().slice(0, 100) : '';
      const conversationId = rawConv ? `chat:${rawConv}` : '';
      const toMsg = (r) => ({ id: r.id, role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content || '', timestamp: Date.parse(r.created_at) || Date.now(), source: r.source || CHAT_SOURCE });
      let msgs;
      let recoverable = 0;
      if (conversationId) {
        const rows = (await db.messages.selectByConversation(userId, conversationId, { limit })) || [];
        msgs = rows.map(toMsg).reverse();   // newest-first → chronological for display
        // When this thread is empty, report how many orphaned chat turns COULD be
        // recovered (saved with NULL conversation_id by the pre-fix WS send path),
        // so the UI can offer an explicit one-click recovery. A COUNT only — never
        // the rows themselves (that would break thread isolation; see RT3/C10).
        if (msgs.length === 0 && typeof db.messages.countOrphanChatHistory === 'function') {
          try { recoverable = await db.messages.countOrphanChatHistory(userId, { source: CHAT_SOURCE }); } catch { /* non-fatal */ }
        }
      } else {
        const rows = (await db.messages.selectRecent(userId, { limit: 200 })) || [];
        msgs = rows.filter((r) => r.source === CHAT_SOURCE).slice(0, limit).map(toMsg).reverse();
      }
      res.json({ messages: msgs, recoverable });
    } catch { res.json({ messages: [], recoverable: 0 }); }
  });

  // ── POST /chat/history/recover — EXPLICIT one-shot recovery of orphaned chat
  //    turns into THIS thread. The pre-fix WS send path saved turns with NULL
  //    conversation_id; this adopts them into the caller's conversationId so they
  //    thread again. User-initiated (a button), idempotent (drains the NULL pool
  //    once), and namespaced under `chat:` exactly like the read/stream paths.
  router.post('/chat/history/recover', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const rawConv = (typeof req.body?.conversationId === 'string' && req.body.conversationId.trim())
        ? req.body.conversationId.trim().slice(0, 100) : '';
      if (!rawConv) { res.status(400).json({ error: 'conversationId required' }); return; }
      const conversationId = `chat:${rawConv}`;
      const recovered = await db.messages.adoptOrphanChatHistory(userId, conversationId, { source: CHAT_SOURCE });
      const limit = Math.min(Number(req.body?.limit) || 50, 100);
      const rows = (await db.messages.selectByConversation(userId, conversationId, { limit })) || [];
      const toMsg = (r) => ({ id: r.id, role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content || '', timestamp: Date.parse(r.created_at) || Date.now(), source: r.source || CHAT_SOURCE });
      res.json({ recovered, messages: rows.map(toMsg).reverse() });
    } catch { res.status(500).json({ error: 'recover failed' }); }
  });

  // ── POST /chat/stream — the SSE turn.
  router.post('/chat/stream', async (req, res) => {
    if (!auth(req, res)) return;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) { res.status(400).json({ error: 'message required' }); return; }
    // Conversation thread key (Phase 5 chat threading): the client sends one UUID per
    // chat thread (new on "Clear"). Scopes history hydration + persistence to this
    // thread. Absent (legacy client) ⇒ stateless turn, exactly today's behavior.
    // SECURITY (red-team RT3, 2026-06-19): namespace under `chat:` so a client-supplied
    // id can NEVER address a CHANNEL conversation (bare chatId / `channel:*`) and pull
    // third-party message history into this cloud-egressed preamble. Chat owns `chat:`.
    const rawConv = (typeof req.body?.conversationId === 'string' && req.body.conversationId.trim())
      ? req.body.conversationId.trim().slice(0, 100)
      : null;
    const conversationId = rawConv ? `chat:${rawConv}` : null;

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
    // Live-inference signal: a background_jobs row that surfaces in the global
    // header activity feed ("the model is working now"). Content-free per §1.
    let chatJob = null;
    // The loop owns the watchdog now; these let it keep the live row honest. finishJob
    // nulls chatJob so a stall (or a hung upstream fetch that never settles) clears the
    // phantom "Thinking…" immediately, and a later heartbeat can't re-touch it.
    const finishJob = (status = 'done') => { if (chatJob) { const j = chatJob; chatJob = null; db.activityFeed?.finish?.(j, { status }).catch(() => {}); } };
    const heartbeatJob = () => { if (chatJob) db.activityFeed?.heartbeat?.(chatJob).catch(() => {}); };
    // External (client-gone) signal: on disconnect, abort the in-flight turn and
    // clear the live row immediately — nobody is waiting (the server turn may keep
    // generating/persisting; that's the loop/harness concern).
    const clientGoneCtrl = new AbortController();
    req.on('close', () => { clientGoneCtrl.abort(); finishJob(); });

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
      // Tools are gated on real model CAPABILITY, not geography. The probe reads
      // Ollama's /api/show capabilities (model-profile.js): a tool-capable model —
      // cloud OR a large local one — gets the full tool set and is a real agent; a
      // no-tool model gets none and degrades to a context-grounded relay (the briefing
      // is already in the preamble). Fail-safe default when the probe is unavailable:
      // cloud (!isLocal) ⇒ capable, bare local ⇒ not — matching model-profile's default.
      const toolsCapable = profile?.capabilities?.tools ?? !isLocal;

      // System = orientation + getContext briefing + (cloud only) memory retrieval.
      const ident = await readAgentIdentity();
      // Does this turn actually carry action tools? Mirrors the loop.run tools gate
      // below (toolsCapable + a non-empty grant). The capability line is chosen to
      // match, so the agent is never told it can write when it has nothing to write with.
      const hasActionTools = toolsCapable && grantedTools.length > 0;
      // Identity preamble (spec #4): the user's chosen name + personality shape who
      // the assistant is and how it speaks, ahead of the static orientation.
      let system = `Your name is ${ident.name}. ${PERSONALITY_GUIDE[ident.personality] || ''} ${CHAT_SYSTEM} ${hasActionTools ? CAN_ACT : CANNOT_ACT}`.trim();
      try { const ctx = await handlers.getContext?.({ recentMessages: recentN }); if (typeof ctx === 'string' && ctx) system += `\n\n${ctx}`; } catch { /* honest-empty */ }
      if (!isLocal && policy.domains.includes('search') && typeof handlers.searchMindscape === 'function') {
        send({ type: 'tool_start', name: 'searchMemory' });
        try { const hits = await handlers.searchMindscape({ query: message, limit: 5 }); if (typeof hits === 'string' && hits) system += `\n\n## Possibly relevant to this question\n${hits}`; } catch { /* skip */ }
        send({ type: 'tool_complete', name: 'searchMemory' });
      }
      // Conversation history (Phase 5 chat threading) → preamble, summarized + tail
      // when over budget (the SAME path the channel/scheduler turns use, run-turn.js).
      // The current message is NOT yet persisted, so this is PRIOR turns only — no dup.
      // The summarize call is signal-aware so a client disconnect mid-summary aborts it
      // instead of stalling the stream.
      if (conversationId) {
        try {
          const rows = await db.messages.selectByConversation(userId, conversationId, { limit: 50 });
          const history = (rows || []).reverse().map((r) => ({ role: r.role, content: r.content })).filter((m) => typeof m.content === 'string' && m.content.trim());
          if (history.length) {
            const contextWindow = plan ? (plan.inputBudget + (plan.maxTokens || 1024)) : 8192;
            const maxOutputTokens = plan?.maxTokens || 1024;
            const summarize = async (sys, usr, maxTokens) => {
              const r = await loop.run({ provider, system: sys, userMessage: usr, tools: [], call: async () => '', send: () => {}, maxTokens, signal: clientGoneCtrl.signal });
              return r?.text || '';
            };
            system += await hydrateHistoryBlock({
              history, contextWindow, maxOutputTokens, summarize,
              getSummary: db?.harness?.getSummary ? (u, c) => db.harness.getSummary(u, c) : undefined,
              putSummary: db?.harness?.putSummary ? (rec) => db.harness.putSummary(rec) : undefined,
              conversationId, userId,
            });
          }
        } catch (e) { console.error('[chat] history hydrate failed:', e?.message); }
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

      // Resolve the engine for this turn: native (default) or the Claude Code CLI
      // when the user has selected it AND it's eligible. Fail-safe: resolveHarness
      // never throws and returns native when 'cli' is ineligible (no binary / not a
      // subscription / cli engine not shipped yet), so this is behavior-identical to
      // the previous hardcoded native loop unless the user opts in and qualifies.
      const { loop } = await resolveHarness({
        db, userId, provider,
        deps: { harness, logger: chatLog, restPort },
      });

      // Drive the turn through the agent loop: the watchdog (TTFB/IDLE) +
      // retry-on-empty + first-token signalling live in loop.run. It streams
      // through our SSE `send`, keeps the live activity row honest via the callbacks,
      // and returns the accumulated answer + truncation/error state.
      const result = await loop.run({
        provider, system, userMessage: message, tools: toolsCapable ? grantedTools : [], call,
        send, maxTokens: plan?.maxTokens, numCtx: plan?.numCtx,
        ttfbMs: TTFB_MS, idleMs: IDLE_MS, maxRetries: MAX_RETRIES,
        signal: clientGoneCtrl.signal, onStall: () => finishJob(), onHeartbeat: heartbeatJob,
      });
      const assistantText = result.text;

      if (!result.clientGone) {
        if (assistantText.trim() || result.truncated) {
          // Completed, gracefully cut off mid-stream, OR truncated at the model's
          // output cap. A truncated turn is NOT a success: the (partial) answer is
          // incomplete and any save/edit the model was emitting did not finish
          // (truncated tool-call JSON no-ops). Tell the user explicitly so they
          // don't trust a "saved" that never happened.
          if (result.truncated) {
            send({ type: 'truncated', message: 'The response hit the model’s output limit and was cut off — it may be incomplete, and any save or edit it was making did not finish. Ask it to continue, or retry with a shorter request (or raise the output limit in Settings → Intelligence).' });
          }
          send({ type: 'done', toolsUsed: result.toolsUsed || [], truncated: !!result.truncated });
          res.write('data: [DONE]\n\n');
          // Persist only when there's actual assistant text (a truncated tool-call
          // turn can have none) — never write an empty assistant bubble.
          if (assistantText.trim()) {
            const cap = (role, content) => captureMessage(db, { userId, role, content, source: CHAT_SOURCE, messageType: 'chat', ...(conversationId ? { conversationId } : {}) }, enqueueEnrichment);
            cap('user', message).then(() => cap('assistant', assistantText.trim())).catch((e) => console.error('[chat] persist failed:', e?.message));
          }
        } else {
          // Surface an ACTIONABLE reason from the upstream status (safe: status
          // codes + the provider label/model carry no secrets, per §1). A bare
          // "didn't respond" hides config problems like a wrong model name or key.
          const st = result.lastErr?.status;
          const who = info.label || 'The model';
          let msg = `${who} didn’t respond after several tries. Try another model in Settings → Intelligence.`;
          if (st === 401 || st === 403) msg = `${who} rejected the request — the API key looks invalid. Update it in Settings → Intelligence.`;
          else if (st === 404 || st === 400) msg = `${who} didn’t recognise the model “${info.model}”. Pick a valid model in Settings → Intelligence.`;
          else if (st === 429) msg = `${who} is rate-limited right now. Wait a moment or switch model in Settings → Intelligence.`;
          else if (st >= 500) msg = `${who} had a server error. Try again, or switch model in Settings → Intelligence.`;
          finishJob('error');   // surface as a red blip in the header activity feed
          send({ type: 'error', message: msg });
          send({ type: 'done', toolsUsed: [] });
        }
      }
    } catch (err) {
      console.error('[chat] turn failed:', err?.message);
      finishJob('error');   // red blip in the header activity feed (status only, §1)
      if (!res.headersSent) { res.status(500).json({ error: 'Chat failed' }); return; }
      send({ type: 'error', message: 'Chat failed' });   // never echo err.message (§1)
      send({ type: 'done', toolsUsed: [] });
    } finally {
      clearInterval(keepalive);
      finishJob();
      try { res.end(); } catch { /* already closed */ }
    }
  });

  return router;
}

export default portalChatRouter;
