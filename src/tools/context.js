// Context-preamble domain (D5). The single entry point a connecting MCP client
// pulls at turn start to load preloaded mind state — so the client (Claude/etc.)
// acts as the agent without a server-side loop.
//
// This is the V1 single-user distillation of reference/core/context-assembly.js
// (the canonical version carries multi-agent/autonomous/cross-channel branches
// V1 doesn't need). It assembles, in one markdown blob:
//   - current date/time (prevents day-of-week hallucination)
//   - the internal model (model.md) + FLAGGED FOR DISCUSSION (flagged.md)
//     ← this is what makes flagForDiscussion actually surface
//   - recent messages across channels
//   - current cognitive phase (Fisher) + 7-day body state (Apple Health)
//   - persona claims (PersonaTree adoption — durable person-level claims)
// Each section is best-effort: a missing subsystem or empty file is skipped,
// never fatal. Plaintext is decrypted transparently by the injected helpers.
//
// @typedef {object} ContextDeps
// @property {() => any} getDb           lazy db namespace getter
// @property {(f: string) => Promise<string|null>} readMindFile  mind-files reader
// @property {string} userId

import { renderClaimsBlock } from '../claims/support-path.js';
import { toConfidence } from '../claims/confidence.js';
import { trimToTokenBudget } from '../inference/token-budget.js';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CORE_TOKEN_CAP = 1200; // defensive trim — the cycle keeps self.md ≤~1000 tok; never bloat context

// Compact "where your energy's been going" line from the domain/register mix (Context Engine L1c).
// Aggregates registers into their parent domain, drops unclassified-only noise.
function renderDomainMix(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const byDomain = new Map();
  for (const r of rows) {
    if (r.domain === '(unclassified)') continue;
    byDomain.set(r.domain, (byDomain.get(r.domain) || 0) + (Number(r.count) || 0));
  }
  if (!byDomain.size) return '';
  const top = [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `Last 24h: ${top.map(([d, n]) => `${d} (${n})`).join(' · ')}`;
}

export function createContextDomain(deps) {
  if (!deps) throw new TypeError('createContextDomain: deps required');
  const { getDb, readMindFile, userId } = deps;
  if (typeof getDb !== 'function') throw new TypeError('createContextDomain: getDb required');
  if (typeof readMindFile !== 'function') throw new TypeError('createContextDomain: readMindFile required');
  if (typeof userId !== 'string') throw new TypeError('createContextDomain: userId required');

  const tools = [
    {
      name: 'getContext',
      description:
        'Load your working context in one call — use this FIRST at the start of a conversation. '
        + 'Returns a single briefing: the current date/time, your private internal model, anything '
        + 'flagged for discussion, recent messages across channels, your current cognitive phase, and '
        + 'recent body-state (sleep/HRV/steps). After this, pull more detail on demand with '
        + 'searchMindscape, getDocument, getDailyMessages, or mindscape (topology by view).',
      inputSchema: {
        type: 'object',
        properties: {
          recentMessages: { type: 'number', description: 'How many recent messages to include (default 10, max 40).' },
          include: {
            type: 'array',
            items: { type: 'string', enum: ['core', 'mind', 'facts', 'people', 'messages', 'domains', 'phase', 'health', 'claims'] },
            description: 'Limit to specific sections. Omit for all.',
          },
        },
      },
    },
  ];

  const want = (include, section) => !include || include.includes(section);

  const handlers = {
    getContext: async (args = {}) => {
      const include = Array.isArray(args.include) && args.include.length ? args.include : null;
      const db = getDb();
      const sections = [];

      // ── time (always) ──
      let tz = 'UTC';
      try { tz = (db?.users && await db.users.getTimezone(userId)) || 'UTC'; } catch { /* default */ }
      const now = new Date();
      const fmt = (o) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz }).format(now);
      const tzLabel = tz.split('/').pop().replace(/_/g, ' ');
      sections.push(
        `**Current time:** ${fmt({ weekday: 'long' })}, ${fmt({ month: 'long', day: 'numeric', year: 'numeric' })} `
        + `${fmt({ hour: '2-digit', minute: '2-digit' })} (${tzLabel})`,
      );

      // ── core: who they are (bounded ≤~1k tok — LEADS the briefing) ──
      if (want(include, 'core')) {
        const core = await readMindFile('self.md').catch(() => null);
        if (core && core.trim()) {
          const bounded = trimToTokenBudget(core.trim(), CORE_TOKEN_CAP).text;
          sections.push(`---\n# WHO YOU ARE (core — your living read on them, kept tight)\n\n${bounded}`);
        }
      }

      // ── mind files: model + flagged ──
      if (want(include, 'mind')) {
        const [model, flagged] = await Promise.all([
          readMindFile('model.md').catch(() => null),
          readMindFile('flagged.md').catch(() => null),
        ]);
        if (model) sections.push(`---\n# YOUR INTERNAL MODEL (private — never share unless you choose to)\n\n${model.trim()}`);
        if (flagged) sections.push(`---\n# FLAGGED FOR DISCUSSION\n\n${flagged.trim()}`);
      }

      // ── facts you know (durable; pinned-first; sensitive excluded) ──
      if (want(include, 'facts') && db?.facts) {
        try {
          const rows = await db.facts.forContext({ userId, limit: 30 });
          if (rows?.length) {
            const lines = rows
              .map((f) => `- ${f.pinned ? '📌 ' : ''}**${f.category}/${f.key}**: ${(f.value || '').slice(0, 200)}`)
              .join('\n');
            sections.push(`---\n# FACTS YOU KNOW\n\n${lines}`);
          }
        } catch { /* non-fatal */ }
      }

      // ── people & projects (pinned entities only; sensitive excluded) ──
      if (want(include, 'people') && db?.entities) {
        try {
          const rows = await db.entities.forContext({ userId, limit: 20 });
          if (rows?.length) {
            const lines = rows
              .map((e) => `- **${e.type}: ${e.name}**${e.summary ? ` — ${(e.summary || '').slice(0, 160)}` : ''}`)
              .join('\n');
            sections.push(`---\n# PEOPLE & PROJECTS\n\n${lines}`);
          }
        } catch { /* non-fatal */ }
      }

      // ── recent messages ──
      if (want(include, 'messages') && db?.messages) {
        try {
          const limit = Math.min(Math.max(args.recentMessages || 10, 1), 40);
          const rows = await db.messages.selectRecent(userId, { limit, scope: 'personal' });
          if (rows?.length) {
            const lines = rows
              .slice()
              .reverse()
              .map((m) => {
                const who = m.role === 'user' ? 'Human' : 'You';
                const when = (m.created_at || '').replace('T', ' ').slice(0, 16);
                return `${m.pinned ? '📌 ' : ''}**${who}** _${when}_: ${(m.content || '').slice(0, 500)}`;
              })
              .join('\n');
            sections.push(`---\n# RECENT MESSAGES (last ${rows.length})\n\n${lines}`);
          }
        } catch { /* non-fatal */ }
      }

      // ── today's shape: domain/register mix (life-balance read, from the 1b labels) ──
      if (want(include, 'domains') && db?.messages?.domainMix) {
        try {
          const rows = await db.messages.domainMix(userId, {});
          const block = renderDomainMix(rows);
          if (block) sections.push(`---\n# TODAY'S SHAPE (where your energy's been going)\n\n${block}`);
        } catch { /* non-fatal */ }
      }

      // ── current cognitive phase ──
      if (want(include, 'phase') && db?.fisher) {
        try {
          const phase = await db.fisher.getCurrentPhase(userId, { level: 'realm' });
          if (phase?.phase) {
            sections.push(`---\n# COGNITIVE PHASE\n\nCurrent phase: **${phase.phase}** (realm level).`);
          }
        } catch { /* non-fatal */ }
      }

      // ── body state ──
      if (want(include, 'health') && db?.health) {
        try {
          const s = await db.health.getSummary(userId, 7);
          const a = s?.averages;
          if (a && Object.keys(a).length) {
            const parts = [];
            if (a.sleep_duration_min != null) parts.push(`sleep ~${Math.floor(a.sleep_duration_min / 60)}h${Math.round(a.sleep_duration_min % 60)}m`);
            if (a.hrv_avg != null) parts.push(`HRV ~${Math.round(a.hrv_avg)}ms`);
            if (a.resting_hr != null) parts.push(`RHR ~${Math.round(a.resting_hr)}bpm`);
            if (a.steps != null) parts.push(`~${Math.round(a.steps).toLocaleString()} steps/day`);
            if (parts.length) sections.push(`---\n# BODY STATE (7-day average)\n\n${parts.join(' · ')}`);
          }
        } catch { /* non-fatal */ }
      }

      // ── persona claims (durable person-level claims, highest confidence first) ──
      // Rendered as support paths at depth 0 under a token budget (PersonaTree
      // §3.6); the budget scopes THIS section only, never the rest of the brief.
      if (want(include, 'claims') && db?.claims) {
        try {
          const rows = await db.claims.listActive(userId, { limit: 12 });
          const claims = rows.map((c) => ({
            id: c.id, claimType: c.claimType, content: c.content,
            confidence: c.confidenceLogodds == null ? undefined : toConfidence(c.confidenceLogodds),
          }));
          const block = renderClaimsBlock(claims, { depth: 0, budgetTokens: 600 });
          if (block) sections.push(`---\n# WHAT YOU'VE LEARNED ABOUT THEM (claims — grounded in evidence over time)\n\n${block}`);
        } catch { /* non-fatal */ }
      }

      return sections.join('\n\n');
    },
  };

  return { tools, handlers };
}
