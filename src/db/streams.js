// src/db/streams.js — the unified Streams data layer.
//
// Phase 1 (this file): `spectrum()` — the at-a-glance "source spectrum". It reads
// ONLY plaintext aggregate columns (source/source_type, created_at, connector
// status) across messages + documents + health_daily + tasks, GROUP BY source.
// ZERO decryption happens here by design (§7 fail-safe: the always-on surface
// can never leak ciphertext-derived data, even on a bug). Per-row content is the
// river's job (Phase 2, `feed()`), not the spectrum's.
//
// Redaction is honoured: messages/documents filter `forgotten_at IS NULL`.
// health_daily/tasks have no soft-delete column (hard-deleted), so all rows count.

import { classifySource, canonicalSource, sourceForDocumentType, STREAM_KINDS } from '../streams/source-registry.js';
import { assembleTimelineMessages } from '../streams/assemble-messages.js';
import { hasVectorKey } from '../federation/lexicon.js';

const DAY_MS = 86400000;
const LIVE_WINDOW_MS = 15 * 60 * 1000; // "live" = activity within 15 min
const PREVIEW_MAX = 240;               // truncate document/task previews server-side

const truncate = (s) => {
  if (s == null) return '';
  const t = String(s);
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX).trimEnd() + '…' : t;
};

// One health day → a short headline string. Metrics are encrypted TEXT, decrypted
// to strings by the adapter; coerce to numbers for formatting.
function healthSummary(r) {
  const n = (v) => (v == null || v === '' ? null : Number(v));
  const parts = [];
  const sleep = n(r.sleep_duration_min);
  if (sleep != null && Number.isFinite(sleep)) {
    const h = Math.floor(sleep / 60), m = Math.round(sleep % 60);
    parts.push(`Sleep ${h}h${m ? ` ${m}m` : ''}`);
  }
  const steps = n(r.steps);
  if (steps != null && Number.isFinite(steps)) parts.push(`${Math.round(steps).toLocaleString()} steps`);
  const hrv = n(r.hrv_avg);
  if (hrv != null && Number.isFinite(hrv)) parts.push(`HRV ${Math.round(hrv)}`);
  const rhr = n(r.resting_hr);
  if (rhr != null && Number.isFinite(rhr)) parts.push(`RHR ${Math.round(rhr)}`);
  const mind = n(r.mindful_minutes);
  if (!parts.length && mind != null && Number.isFinite(mind)) parts.push(`${Math.round(mind)} min mindful`);
  return parts.join(' · ') || 'Health data';
}

// Build the ascending list of YYYY-MM-DD day keys for a window ending today (UTC).
function dayKeys(now, windowDays) {
  const keys = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    keys.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

// Per-table plaintext aggregate. `srcExpr` is the SQL expression yielding the raw
// source tag; `softDelete` adds the redaction filter when the table has one.
function aggregateSql(table, srcExpr, softDelete) {
  return `SELECT ${srcExpr} AS source,
            MAX(created_at) AS last_activity,
            COUNT(*) AS total_all,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS window_total,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today_total
          FROM ${table}
          WHERE user_id = ?${softDelete ? ' AND forgotten_at IS NULL' : ''}
          GROUP BY source`;
}
function bucketSql(table, srcExpr, softDelete) {
  return `SELECT ${srcExpr} AS source, substr(created_at, 1, 10) AS day, COUNT(*) AS c
          FROM ${table}
          WHERE user_id = ? AND created_at >= ?${softDelete ? ' AND forgotten_at IS NULL' : ''}
          GROUP BY source, day`;
}

export function createStreamsNamespace(deps) {
  if (!deps) throw new TypeError('createStreamsNamespace: deps required');
  const { d1Query, connectors, db } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createStreamsNamespace: d1Query required');

  // The four ingest tables, each contributing rows to the river + spectrum.
  // `srcExpr` resolves the raw source tag; documents map source_type → a source
  // tag in JS (sourceForDocumentType) since the closed set differs from messages.
  const TABLES = [
    { table: 'messages', srcExpr: "COALESCE(source, 'unknown')", softDelete: true, docType: false },
    { table: 'documents', srcExpr: "COALESCE(source_type, 'portal')", softDelete: true, docType: true },
    { table: 'health_daily', srcExpr: "COALESCE(source, 'apple_health')", softDelete: false, docType: false },
    { table: 'tasks', srcExpr: "'task'", softDelete: false, docType: false },
  ];

  return {
    /**
     * The source spectrum: one entry per canonical source the user actually has
     * (or has a connector configured for), with health + a daily volume sparkline.
     *
     * @param {string} userId
     * @param {{ windowDays?: number, nowMs?: number }} [opts] nowMs is injectable
     *   for deterministic tests; defaults to wall clock.
     * @returns {Promise<{ windowDays:number, days:string[], sources:Array }>}
     */
    async spectrum(userId, { windowDays = 7, nowMs } = {}) {
      const win = Math.min(Math.max(windowDays | 0, 1), 90);
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const days = dayKeys(now, win);
      const windowFloor = new Date(now - win * DAY_MS).toISOString();
      const todayFloor = new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';

      // Accumulator keyed by canonical source.
      const acc = new Map();
      const ensure = (canonical, kind) => {
        let e = acc.get(canonical);
        if (!e) {
          e = {
            source: canonical, kind,
            total: 0, today: 0, lastActivity: null,
            buckets: Object.fromEntries(days.map((d) => [d, 0])),
            connector: null,
          };
          acc.set(canonical, e);
        }
        return e;
      };
      const foldSource = (rawSource, docType) => {
        const raw = docType ? sourceForDocumentType(rawSource) : rawSource;
        return classifySource(raw);
      };

      for (const t of TABLES) {
        // Aggregates (totals + last activity).
        const agg = await d1Query(aggregateSql(t.table, t.srcExpr, t.softDelete), [windowFloor, todayFloor, userId]);
        for (const row of agg.results || []) {
          const { canonical, kind } = foldSource(row.source, t.docType);
          const e = ensure(canonical, kind);
          e.total += Number(row.window_total) || 0;
          e.today += Number(row.today_total) || 0;
          if (row.last_activity && (!e.lastActivity || row.last_activity > e.lastActivity)) {
            e.lastActivity = row.last_activity;
          }
        }
        // Daily buckets (sparkline) — windowed only.
        const buckets = await d1Query(bucketSql(t.table, t.srcExpr, t.softDelete), [userId, windowFloor]);
        for (const row of buckets.results || []) {
          const { canonical, kind } = foldSource(row.source, t.docType);
          const e = ensure(canonical, kind);
          if (row.day in e.buckets) e.buckets[row.day] += Number(row.c) || 0;
        }
      }

      // Join connector operational state (plaintext): surfaces connected-but-quiet
      // and errored connectors even with zero ingested items, and overrides status.
      let connectorRows = [];
      try { connectorRows = connectors?.list ? await connectors.list(userId) : []; } catch { connectorRows = []; }
      for (const c of connectorRows) {
        const { canonical, kind } = classifySource(c.id);
        const e = ensure(canonical, kind === 'other' ? 'connector' : kind);
        e.connector = {
          status: c.status || null,
          lastSyncAt: c.last_sync_at || null,
          lastOkAt: c.last_ok_at || null,
          lastErrorAt: c.last_error_at || null,
          idleStreak: c.idle_streak ?? null,
          itemsToday: c.items_today ?? null,
        };
        if (c.last_ok_at && (!e.lastActivity || c.last_ok_at > e.lastActivity)) e.lastActivity = c.last_ok_at;
      }

      const sources = [...acc.values()].map((e) => ({
        source: e.source,
        kind: e.kind,
        total: e.total,
        today: e.today,
        lastActivity: e.lastActivity,
        status: deriveStatus(e, now),
        sparkline: days.map((d) => e.buckets[d] || 0),
        connector: e.connector,
      }));

      // Most-active first; errored connectors floated up so they're not missed.
      sources.sort((a, b) => {
        if ((a.status === 'error') !== (b.status === 'error')) return a.status === 'error' ? -1 : 1;
        return (b.lastActivity || '').localeCompare(a.lastActivity || '');
      });

      return { windowDays: win, days, kinds: STREAM_KINDS, sources };
    },

    /**
     * The unified river: recent items across messages + documents + health_daily
     * + tasks, interleaved by created_at DESC with a single cursor.
     *
     * SECURITY (§7): each arm is an EXPLICIT, vector-free column projection (never
     * SELECT *, never embedding_768/centroid). Per-row content auto-decrypts at the
     * adapter. Raw message `metadata` is stripped (assembleTimelineMessages). The
     * assembled payload is run through hasVectorKey() as a belt-and-suspenders egress
     * guard — a match fails closed (throws), never serves.
     *
     * @param {string} userId
     * @param {{ limit?:number, before?:string, since?:string, types?:string[] }} [opts]
     *   before = ISO cursor (exclusive); since = ISO floor (time scope); types =
     *   subset of ['message','document','health','task'] (default: all).
     * @returns {Promise<{ items: object[], nextCursor: string|null }>}
     */
    async feed(userId, { limit = 40, before, since, types } = {}) {
      const lim = Math.min(Math.max(limit | 0, 1), 100);
      const want = new Set(Array.isArray(types) && types.length ? types : ['message', 'document', 'health', 'task']);
      const range = (extra = []) => {
        // shared WHERE tail + params for created_at windowing
        let sql = '';
        const params = [];
        if (before) { sql += ' AND created_at < ?'; params.push(before); }
        if (since) { sql += ' AND created_at >= ?'; params.push(since); }
        return { sql, params, extra };
      };

      const arms = [];

      // message — selectTimeline is already vector-free; assemble joins attachments
      // + strips metadata (shared with GET /messages). scope:'all' mirrors the river.
      if (want.has('message') && db?.messages?.selectTimeline) {
        arms.push((async () => {
          const rows = await db.messages.selectTimeline(userId, { limit: lim + 1, before, since, scope: 'all' });
          const msgs = await assembleTimelineMessages(rows, { db, userId });
          return msgs.map((m) => ({
            type: 'message', id: m.id, source: m.source || 'unknown', createdAt: m.created_at, message: m,
          }));
        })());
      }

      // document — getForShare-shape + created_at, minus content (summary is the row
      // preview; content is a click-through). Excludes internal + forgotten.
      if (want.has('document')) {
        arms.push((async () => {
          const r = range();
          const res = await d1Query(
            `SELECT path, title, summary, source_type, created_at
               FROM documents
              WHERE user_id = ? AND forgotten_at IS NULL AND is_internal = 0${r.sql}
              ORDER BY created_at DESC LIMIT ?`,
            [userId, ...r.params, lim + 1],
          );
          return (res.results || []).map((d) => ({
            type: 'document', id: `doc:${d.path}`, source: sourceForDocumentType(d.source_type), createdAt: d.created_at,
            title: d.title || d.path, preview: truncate(d.summary), path: d.path, sourceType: d.source_type,
          }));
        })());
      }

      // health — explicit metric columns (no vector columns exist on this table);
      // one row per day with a short headline summary.
      if (want.has('health')) {
        arms.push((async () => {
          const r = range();
          const res = await d1Query(
            `SELECT id, date, source, created_at, sleep_duration_min, steps, hrv_avg, resting_hr,
                    active_energy_kcal, workout_minutes, mindful_minutes
               FROM health_daily
              WHERE user_id = ?${r.sql}
              ORDER BY created_at DESC LIMIT ?`,
            [userId, ...r.params, lim + 1],
          );
          return (res.results || []).map((h) => ({
            type: 'health', id: `health:${h.id}`, source: h.source || 'apple_health', createdAt: h.created_at,
            date: h.date, preview: healthSummary(h),
          }));
        })());
      }

      // task — title auto-decrypts; status/priority/dates are plaintext. Exclude
      // soft-deleted (status). No vector columns exist on this table.
      if (want.has('task')) {
        arms.push((async () => {
          const r = range();
          const res = await d1Query(
            `SELECT id, title, status, priority, due_date, created_at, completed_at
               FROM tasks
              WHERE user_id = ? AND (status IS NULL OR status != 'deleted')${r.sql}
              ORDER BY created_at DESC LIMIT ?`,
            [userId, ...r.params, lim + 1],
          );
          return (res.results || []).map((t) => ({
            type: 'task', id: `task:${t.id}`, source: 'task', createdAt: t.created_at,
            title: truncate(t.title), status: t.status, priority: t.priority,
            dueDate: t.due_date, completedAt: t.completed_at,
          }));
        })());
      }

      const armResults = await Promise.all(arms);
      // k-way merge: created_at is the SAME ISO %f format in all four tables, so a
      // lexicographic string compare sorts the union correctly (verified).
      const merged = armResults.flat()
        .filter((it) => it && it.createdAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

      const items = merged.slice(0, lim);
      const nextCursor = merged.length > lim && items.length ? items[items.length - 1].createdAt : null;

      // §7 belt-and-suspenders: refuse to serve if any vector field slipped through.
      if (hasVectorKey(items)) throw new Error('streams.feed: refusing to serve a vector field (§7)');

      return { items, nextCursor };
    },
  };
}

// status: 'error' | 'live' | 'synced' | 'idle'
function deriveStatus(e, now) {
  const c = e.connector;
  if (c) {
    if (c.status === 'error' || (c.lastErrorAt && (!c.lastOkAt || c.lastErrorAt > c.lastOkAt))) return 'error';
    if (c.status === 'syncing' || c.status === 'connecting') return 'live';
  }
  if (e.lastActivity) {
    const age = now - Date.parse(e.lastActivity);
    if (Number.isFinite(age) && age <= LIVE_WINDOW_MS) return 'live';
  }
  if (c && (c.status === 'connected' || c.lastOkAt)) return 'synced';
  return 'idle';
}
