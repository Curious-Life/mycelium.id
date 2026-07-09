/**
 * Gravity core — PURE math for the cluster attentional-weight measure.
 *
 *   gravity = mass × recency × centrality
 *
 * where (all per cluster, all in [0,1]):
 *   mass       = share of total activity (message_count / Σ message_count)
 *   recency    = exp-decay-weighted share of that mass toward recent months
 *   centrality = normalized co-firing degree (how connected/bridging)
 *
 * mass is primary; recency + centrality each modulate it between 0.4× and 1×:
 *   raw = mass · (0.4 + 0.6·recency) · (0.4 + 0.6·centrality)
 * Then per level: gravity = raw / max(raw)  (0..1 index for size/sort),
 *                 gravity_share = raw / Σ raw  (shares sum to 1).
 *
 * No DB, no crypto, no I/O — unit-tested in gravity-core.test.js.
 */

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 'YYYY-MM' → absolute month index (year*12 + month-1); 0 on malformed. */
export function ymToIndex(ym) {
	if (typeof ym !== 'string' || ym.length < 7 || ym[4] !== '-') return 0;
	const y = Number(ym.slice(0, 4));
	const m = Number(ym.slice(5, 7));
	if (!Number.isFinite(y) || !Number.isFinite(m)) return 0;
	return y * 12 + (m - 1);
}

/** Latest 'YYYY-MM' present across a list of [{month,count}] timelines (or null). */
export function latestMonth(timelines) {
	let best = null;
	let bestIdx = -Infinity;
	for (const tl of timelines) {
		if (!Array.isArray(tl)) continue;
		for (const p of tl) {
			const idx = ymToIndex(p?.month);
			if (p?.month && idx > bestIdx) { bestIdx = idx; best = p.month; }
		}
	}
	return best;
}

/**
 * Recency ∈ [0,1]: exp-decay-weighted fraction of a cluster's activity, by month age
 * relative to `refYm`. ~1 when activity is concentrated in recent months, ~0 when old.
 * τ (months) sets the half-life-ish scale. Empty/absent timeline → 0.
 */
export function recencyScore(timeline, refYm, tauMonths = 12) {
	if (!Array.isArray(timeline) || !timeline.length) return 0;
	const ref = ymToIndex(refYm);
	const tau = tauMonths > 0 ? tauMonths : 12;
	let wsum = 0, csum = 0;
	for (const p of timeline) {
		const c = Number(p?.count) || 0;
		if (c <= 0) continue;
		const age = Math.max(0, ref - ymToIndex(p?.month));
		wsum += c * Math.exp(-age / tau);
		csum += c;
	}
	return csum > 0 ? clamp(wsum / csum, 0, 1) : 0;
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;

/** Normalize rows [{id, raw, ...extra}] → Map(id → {...extra, gravity, gravity_share, raw}). */
function normalize(rows) {
	let max = 0, sum = 0;
	for (const r of rows) { if (r.raw > max) max = r.raw; sum += r.raw; }
	const out = new Map();
	for (const r of rows) {
		const { id, raw, ...extra } = r;
		out.set(id, {
			...extra,
			gravity: max > 0 ? r3(raw / max) : 0,
			gravity_share: sum > 0 ? r4(raw / sum) : 0,
			raw,
		});
	}
	return out;
}

/**
 * Combine per-territory {mass, recency, centrality} into gravity, and aggregate up to
 * realm + theme (mass-weighted means of recency/centrality, summed mass).
 *
 * @param {Array<{id:number, realmId:?number, themeId:?number, mass:number, recency:number, centrality:number}>} territories
 * @param {{wRecency?:number, wCentrality?:number}} [opts] modulation weights (default 0.6/0.6)
 * @returns {{territory:Map, realm:Map, theme:Map}} each Map(id → {gravity, gravity_share, raw})
 */
export function combineGravity(territories, opts = {}) {
	const wRec = opts.wRecency ?? 0.6;
	const wCen = opts.wCentrality ?? 0.6;
	// modulate x in [0,1] to [1-w, 1] so mass stays the driver
	const mod = (x, w) => (1 - w) + w * clamp(x, 0, 1);
	const rawOf = (mass, rec, cen) => mass * mod(rec, wRec) * mod(cen, wCen);

	const terrRows = territories.map((t) => ({ id: t.id, raw: rawOf(t.mass, t.recency, t.centrality) }));

	// Group territories → mass-weighted aggregate → raw. `keyFn` returns the group id
	// (null skips); `extraFn(t)` carries identity fields onto each group row so the
	// writer can address the row. Grouping is by the STRING form of the key so a
	// composite id (e.g. "realm:theme") works — `semantic_theme_id` is realm-local,
	// so themes MUST be keyed on (realm_id, theme_id), not theme_id alone.
	const aggregate = (keyFn, extraFn) => {
		const g = new Map();
		for (const t of territories) {
			const k = keyFn(t);
			if (k == null) continue;
			let a = g.get(k);
			if (!a) { a = { id: k, extra: extraFn ? extraFn(t) : {}, mass: 0, recW: 0, cenW: 0 }; g.set(k, a); }
			a.mass += t.mass;
			a.recW += t.recency * t.mass;
			a.cenW += t.centrality * t.mass;
		}
		return [...g.values()].map((a) => {
			const rec = a.mass > 0 ? a.recW / a.mass : 0;
			const cen = a.mass > 0 ? a.cenW / a.mass : 0;
			return { id: a.id, ...a.extra, raw: rawOf(a.mass, rec, cen) };
		});
	};

	return {
		territory: normalize(terrRows),
		realm: normalize(aggregate((t) => (t.realmId != null ? t.realmId : null))),
		// composite key: realm-local theme ids collide across realms → key on both,
		// carry realmId/themeId so the writer can UPDATE … WHERE realm_id=? AND semantic_theme_id=?
		theme: normalize(aggregate(
			(t) => (t.realmId != null && t.themeId != null ? `${t.realmId}:${t.themeId}` : null),
			(t) => ({ realmId: t.realmId, themeId: t.themeId }),
		)),
	};
}
