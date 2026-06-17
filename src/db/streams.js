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

const DAY_MS = 86400000;
const LIVE_WINDOW_MS = 15 * 60 * 1000; // "live" = activity within 15 min

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
  const { d1Query, connectors } = deps;
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
