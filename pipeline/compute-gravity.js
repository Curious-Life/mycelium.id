#!/usr/bin/env node
/**
 * Cluster Gravity — per-cluster attentional weight (mass × recency × centrality).
 *
 * gravity = how much attention-mass a cluster holds: big AND recent AND well-connected
 * clusters pull hardest. Formalizes the previously-dormant `energy` (mass share) +
 * `temporal_saliency` (recency), and folds in co-firing centrality.
 *
 * Reads:  territory_profiles (message_count, activity_timeline, realm_id,
 *         semantic_theme_id, is_catchall), territory_cofire (daily+weekly).
 * Writes: territory_profiles.gravity/gravity_share, realms.*, semantic_themes.*
 *         (aggregated from member territories). Idempotent per-run UPDATEs.
 *
 * Storage: gravity/gravity_share are plaintext-inside-cipher REAL columns (like `energy`
 * / `current_vitality`); ENCRYPTED_FIELDS for these tables is [] so the adapter writes
 * them as-is under the vault's SQLCipher-at-rest. Never logs metric VALUES — counts only.
 *
 * Runs as step 9.5 (after compute-vitality) so activity_timeline + territory_cofire exist.
 *
 * V1 single-user port — mirrors pipeline/compute-vitality.js (boot() CLI, scope 'personal').
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/compute-gravity.js [--dry-run]
 */

import { pathToFileURL } from 'node:url';
import { createStageResult } from './lib/stage-result.js';
import { clamp, recencyScore, latestMonth, combineGravity } from './lib/gravity-core.js';

const RECENCY_TAU_MONTHS = 12; // recency decay scale (documented in gravity-core.js)

/** p-th percentile (0..1) of a numeric array; floor `floor`. */
function percentile(arr, p, floor = 1) {
	if (!arr.length) return floor;
	const sorted = [...arr].sort((a, b) => a - b);
	return Math.max(floor, sorted[Math.floor(sorted.length * p)] || floor);
}

/**
 * Core stage: compute + persist gravity for every level. Exported for the verify gate.
 * @returns {Promise<{territories:number, realms:number, themes:number, written:number}>}
 */
export async function computeGravity({ db, userId, runId = null, dryRun = false, log = console.log }) {
	if (!db?.rawQuery) throw new TypeError('computeGravity: db.rawQuery required');
	if (typeof userId !== 'string') throw new TypeError('computeGravity: userId required');
	const asArray = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : []));
	const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

	// Active, non-dissolved territories. message_count is plaintext (mass key);
	// activity_timeline is ENCRYPTED JSON (adapter decrypts to a string on read).
	const territories = asArray(await db.rawQuery(
		`SELECT territory_id, message_count, activity_timeline, realm_id, semantic_theme_id,
		        COALESCE(is_catchall, 0) AS is_catchall
		 FROM territory_profiles
		 WHERE user_id = ? AND message_count > 0 AND dissolved_at IS NULL`,
		[userId],
	));
	log(`[gravity] ${territories.length} territories`);
	if (territories.length === 0) {
		log('[gravity] No territories. Exiting.');
		return { territories: 0, realms: 0, themes: 0, written: 0 };
	}

	// Co-firing edges — cofire_daily/weekly are the stable timescales for centrality.
	const edges = asArray(await db.rawQuery(
		`SELECT territory_a, territory_b, cofire_daily, cofire_weekly
		 FROM territory_cofire WHERE user_id = ?`,
		[userId],
	));

	const catchAll = new Set();
	for (const t of territories) if (t.is_catchall) catchAll.add(t.territory_id);

	// Weighted co-fire degree per territory (skip catch-all edges, mirroring vitality).
	const degree = new Map();
	for (const t of territories) degree.set(t.territory_id, 0);
	for (const e of edges) {
		if (catchAll.has(e.territory_a) || catchAll.has(e.territory_b)) continue;
		const w = num(e.cofire_daily) + num(e.cofire_weekly);
		if (w <= 0) continue;
		degree.set(e.territory_a, (degree.get(e.territory_a) || 0) + w);
		degree.set(e.territory_b, (degree.get(e.territory_b) || 0) + w);
	}
	const active = territories.filter((t) => !t.is_catchall);
	// p90 weighted degree — vault-size-normalized centrality denominator (matches the
	// vitality pipeline's convention; avoids a cloud-tuned magic constant).
	const p90deg = percentile(active.map((t) => degree.get(t.territory_id) || 0), 0.9);

	// Parse activity_timelines (encrypted JSON → decrypted string → array).
	const timelines = new Map();
	for (const t of territories) {
		let tl = [];
		if (t.activity_timeline) {
			try {
				const v = typeof t.activity_timeline === 'string' ? JSON.parse(t.activity_timeline) : t.activity_timeline;
				if (Array.isArray(v)) tl = v;
			} catch { /* malformed → empty (recency 0) */ }
		}
		timelines.set(t.territory_id, tl);
	}
	const refMonth = latestMonth([...timelines.values()]);

	const totalMessages = active.reduce((s, t) => s + num(t.message_count), 0) || 1;

	// Build per-territory {mass, recency, centrality}. Catch-alls get zeroed mass so
	// they never accrue gravity (mirrors vitality's catch-all handling).
	const rows = territories.map((t) => ({
		id: t.territory_id,
		realmId: t.realm_id ?? null,
		themeId: t.semantic_theme_id ?? null,
		mass: t.is_catchall ? 0 : num(t.message_count) / totalMessages,
		recency: t.is_catchall ? 0 : recencyScore(timelines.get(t.territory_id), refMonth, RECENCY_TAU_MONTHS),
		centrality: t.is_catchall ? 0 : clamp((degree.get(t.territory_id) || 0) / p90deg, 0, 1),
	}));

	const { territory, realm, theme } = combineGravity(rows);
	log(`[gravity] levels: ${territory.size} territories, ${realm.size} realms, ${theme.size} themes`);

	if (dryRun) {
		log('[gravity] Dry run — not writing');
		return { territories: territory.size, realms: realm.size, themes: theme.size, written: 0 };
	}

	const res = createStageResult('compute-gravity', { record: db.pipelineState.recorderFor(userId, 'compute-gravity') });
	let written = 0;
	const writeLevel = async (table, idCol, map) => {
		for (const [id, g] of map) {
			try {
				await db.rawQuery(
					`UPDATE ${table} SET gravity = ?, gravity_share = ? WHERE user_id = ? AND ${idCol} = ?`,
					[g.gravity, g.gravity_share, userId, id],
				);
				written++;
				res.ok();
			} catch (err) {
				res.fail(err);
				log(`[gravity] ${table} update failed for ${idCol}=${id}: ${err.message}`);
			}
		}
	};
	await writeLevel('territory_profiles', 'territory_id', territory);
	await writeLevel('realms', 'realm_id', realm);
	// semantic_theme_id is realm-local (PK is user_id+realm_id+semantic_theme_id), so the
	// theme rows carry both ids and the UPDATE must scope by BOTH — else one theme_id
	// stamps its gravity onto the same-numbered theme in every realm.
	for (const [, g] of theme) {
		if (g.realmId == null || g.themeId == null) continue;
		try {
			await db.rawQuery(
				`UPDATE semantic_themes SET gravity = ?, gravity_share = ?
				 WHERE user_id = ? AND realm_id = ? AND semantic_theme_id = ?`,
				[g.gravity, g.gravity_share, userId, g.realmId, g.themeId],
			);
			written++;
			res.ok();
		} catch (err) {
			res.fail(err);
			log(`[gravity] semantic_themes update failed for realm=${g.realmId} theme=${g.themeId}: ${err.message}`);
		}
	}

	await res.finalize();
	log(`[gravity] Done: ${written} gravity scores written`);
	return { territories: territory.size, realms: realm.size, themes: theme.size, written };
}

// ── CLI wrapper (boot() → unlock CryptoKeys before any write; mirrors compute-vitality) ──
async function runCli() {
	const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
	const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
	if (!process.env.USER_MASTER || !process.env.SYSTEM_KEY) {
		console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
		process.exit(1);
	}
	let runId = process.env.CLUSTERING_RUN_ID || null;
	const dryRun = process.argv.includes('--dry-run');

	const { boot } = await import('../src/index.js');
	const { db, close } = await boot({
		dbPath: DB_PATH,
		userHex: process.env.USER_MASTER,
		systemHex: process.env.SYSTEM_KEY,
		userId: USER_ID,
		embedder: null,
	});
	if (!runId) runId = await db.metrics.getCurrentEra(USER_ID).catch(() => null);
	try {
		await computeGravity({ db, userId: USER_ID, runId, dryRun });
	} finally {
		close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli().catch((err) => { console.error('[gravity] Fatal:', err); process.exit(1); });
}
