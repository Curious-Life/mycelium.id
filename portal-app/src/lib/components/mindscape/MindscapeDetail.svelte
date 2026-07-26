<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, apiPost } from '$lib/api';
	import { generate } from '$lib/generate';
	// D-004: embedded-vs-mapped + the rebuild control. Mounted on the REALM LIST — the surface a
	// user with a built map actually looks at, and the one where "369 of 2510" was invisible.
	import MapFreshness from './MapFreshness.svelte';
	// QA9 — the ONE collapse-header pattern, shared with PipelineStatus and taken from the live
	// process indicator (StatusPopover's vault-pill). Not a second implementation.
	import CollapsibleHeader from './CollapsibleHeader.svelte';

	// The Mindscape section's own disclosure. Default OPEN — it is the rail's primary content; the
	// collapse exists so a user working in the pipeline/measure sections can get it out of the way,
	// not to hide it by default. Stored as WHERE the user collapsed (a nav key) rather than as a
	// boolean, so a navigation re-opens it by construction — see `sectionExpanded` below.
	let collapsedAtNavKey = $state<string | null>(null);

	// Per-territory "describe more": deepen narration coverage for just this territory
	// (POST /mycelium/describe-more {territoryId} → spawns describe-chronicles.js as a
	// child, folds in unseen content). Background + safe; no event-loop peg.
	let describingTerritoryId: number | null = $state(null);
	let describeResetTimer: ReturnType<typeof setTimeout> | null = null;
	async function describeTerritory(territoryId: number) {
		if (territoryId == null) return;
		describingTerritoryId = territoryId;
		try { await apiPost('/portal/mycelium/describe-more', { territoryId }); }
		catch { /* surfaced via coverage refresh */ }
		finally {
			if (describeResetTimer) clearTimeout(describeResetTimer);
			describeResetTimer = setTimeout(() => { if (describingTerritoryId === territoryId) describingTerritoryId = null; }, 60_000);
		}
	}
	onDestroy(() => {
		if (describeResetTimer) clearTimeout(describeResetTimer);
		if (namingResetTimer) clearTimeout(namingResetTimer);
		if (awaitRowTimer) clearTimeout(awaitRowTimer);
		if (afterLingerTimer) clearTimeout(afterLingerTimer);
		if (washTimer) clearTimeout(washTimer);
	});
	import { activity, startActivityPolling, fmtEta, fmtAgo } from '$lib/stores/activity';
	import ActivityBars from '$lib/components/mindscape/ActivityBars.svelte';
	import {
		mindscapeState,
		mindscapePoints,
		visibleContacts,
		contactMessages,
		contactMessagesLoading,
		CLUSTER_COLORS,
		NOISE_COLOR,
		type TerritoryProfile,
		type SemanticThemeProfile,
	} from '$lib/stores/mindscape';

	const VISIBILITY_OPTIONS = [
		{ value: 'private', label: 'Private', icon: '🔒' },
		{ value: 'friends', label: 'Friends', icon: '👥' },
		{ value: 'public', label: 'Public', icon: '🌐' },
	] as const;

	let savingVisibility = $state(false);

	async function setVisibility(territoryId: number, visibility: string) {
		savingVisibility = true;
		try {
			const res = await api(`/portal/mindscape/territory/${territoryId}/visibility`, {
				method: 'PUT',
				body: JSON.stringify({ visibility }),
			});
			if (res.ok) {
				// Update local state
				const territories = $mindscapeState.territories;
				if (territories[territoryId]) {
					territories[territoryId].visibility = visibility as 'private' | 'friends' | 'public';
					mindscapeState.update(s => ({ ...s, territories: { ...territories } }));
				}
			}
		} catch {}
		savingVisibility = false;
	}

	marked.use({ breaks: true, gfm: true });

	function renderMarkdown(text: string | null): string {
		if (!text) return '';
		const preprocessed = text.replace(/^(\[\s?\]|\[x\])\s/gim, '- $1 ');
		return DOMPurify.sanitize(marked.parse(preprocessed) as string);
	}

	const msState = $derived($mindscapeState);
	const pointsStore = $derived($mindscapePoints);

	function getColor(id: number): string {
		if (id === -1) return NOISE_COLOR;
		return CLUSTER_COLORS[id % CLUSTER_COLORS.length];
	}

	function relativeDate(iso: string | null): string {
		if (!iso) return '';
		const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
		if (d === 0) return 'today';
		if (d === 1) return 'yesterday';
		if (d < 30) return `${d}d ago`;
		if (d < 365) return `${Math.floor(d/30)}mo ago`;
		return `${Math.floor(d/365)}y ago`;
	}

	// ── Contacts linked to selected territory ──
	const territoryContacts = $derived.by(() => {
		const tid = msState.selectedTerritoryId;
		if (tid === null) return [];
		return $visibleContacts.filter(c =>
			c.territories.some(t => t.territory_id === tid)
		).sort((a, b) => {
			const tierOrder: Record<string, number> = { inner: 0, engaged: 1, acknowledged: 2, connected: 3, noise: 4 };
			return (tierOrder[a.tier] ?? 5) - (tierOrder[b.tier] ?? 5);
		});
	});

	// ── Realm list (sorted by point count) ──
	const sortedRealms = $derived.by(() => {
		return Object.entries(pointsStore.realms)
			.map(([id, r]) => ({ id: Number(id), ...r }))
			.filter(r => (r.pointCount || 0) >= 3)
			.sort((a, b) => (b.pointCount || 0) - (a.pointCount || 0));
	});
	// A realm is "described" only once an AI has chronicled it. Until then the
	// pipeline stores a literal placeholder name ("Realm 0") + empty essence — so
	// presence-of-name is NOT a signal. We detect the placeholder and label such
	// realms as warm, greyed "Area N".
	//
	// ⚠️ DISPLAY-ONLY FALLBACK (II.2a). This predicate labels rows; it never COUNTS. Every
	// count ("12 of 40", "all named", the AFTER math) comes from GET /portal/mycelium/
	// naming-status, whose server counts with the PIPELINE'S OWN predicate
	// (pipeline/lib/naming-facts.js — wider than this one: it also knows "Territory N").
	// Two predicates for one fact is the drift that made a card say "all named" while the
	// job still found work — this copy stays only so unnamed rows can render as "Area N".
	function isPlaceholderName(name: string | null | undefined): boolean {
		return !name || /^realm\s+\d+$/i.test(String(name).trim());
	}
	function isRealmDescribed(r: any): boolean {
		return !isPlaceholderName(r?.name) || (typeof r?.essence === 'string' && r.essence.trim().length > 0);
	}
	function realmLabel(r: any, idx: number): string {
		return isRealmDescribed(r) ? r.name : `Area ${idx + 1}`;
	}
	const anyUndescribed = $derived(sortedRealms.some((r: any) => !isRealmDescribed(r)));
	const currentRealmIdx = $derived(sortedRealms.findIndex((r: any) => r.id === msState.selectedRealmId));

	// Is an AI connected? (any active provider — status may still be erroring, but a
	// configured provider means "Spawn" is done, so we offer "Illuminate" instead.)
	let aiConnected = $state(false);
	onMount(async () => {
		try {
			const res = await api('/portal/providers');
			if (res.ok) { const d = await res.json(); aiConnected = (d.providers || []).some((p: any) => p.is_active); }
		} catch { /* leave false — fall back to Spawn intelligence */ }
	});

	const genActive = $derived(['embedding', 'starting', 'running'].includes($generate.phase));
	function connectIntelligence() { goto('/settings?tab=intelligence'); }

	// ── The naming run surface (INTELLIGENCE-SCREEN-REDESIGN Part II) ─────────────────────────
	// "Illuminate" grown into a card with a lifecycle: BEFORE (what will happen, the served
	// token bound, percent named) · DURING (renders the describe:name FEED ROW — the single
	// owner of run progress, never a second computation) · AFTER (success / partial / fault /
	// choice) · EMPTY (all named ⇒ no card). The word "Illuminate" retires from the UI (II.6:
	// the verb glossary is Name / Describe / Map); it survives in code as the historical name.
	//
	// Number ownership (II.2a): percent-named comes from GET /mycelium/naming-status (server
	// counts with the pipeline's own predicate) and does NOT tick mid-run; run progress comes
	// from the ref-counted activity store (the same poller the popover/chip ride — ZERO new
	// pollers); naming-status is fetched per mount/gesture/completion, NEVER polled.
	type NamingStatus = {
		areas: { total: number; named: number; unnamed: number };
		forecast: { perUnitTokenBound: number; expectedTokensBound: number };
		narrator: { ready: boolean; label: string; model: string | null; local: boolean; jurisdiction: string | null };
	};
	let namingStatus = $state<NamingStatus | null>(null);
	let prevUnnamed: number | null = null;   // the unnamed count before the run — AFTER's math
	let after = $state<{ kind: 'success' | 'partial' | 'fault'; named: number; remaining: number } | null>(null);
	let announceText = $state('');           // the ONE persistent live region's text (II.7)
	let awaitingRow = $state(false);         // POST acked `running` but the feed poll hasn't shown the row yet
	let awaitRowTimer: ReturnType<typeof setTimeout> | null = null;
	let afterLingerTimer: ReturnType<typeof setTimeout> | null = null;
	let washTimer: ReturnType<typeof setTimeout> | null = null;
	let washIds = $state<Set<number>>(new Set());   // realm rows freshly renamed — the AFTER wash

	// Milestone announcements ONLY (start / done / error) — a per-tick announcement at the
	// feed's 2.5s cadence is a screen-reader DoS (II.7). The region persists and its
	// textContent is swapped; a node inserted already-containing-text announces inconsistently
	// across AT (the #204 round-3 lesson).
	function announce(text: string) { announceText = text; }

	async function loadNamingStatus(): Promise<NamingStatus | null> {
		try {
			const res = await api('/portal/mycelium/naming-status');
			if (!res.ok) return null;
			const d = await res.json();
			if (!d?.areas || !d?.narrator || !d?.forecast) return null;
			return d as NamingStatus;
		} catch { return null; }
	}
	onMount(async () => {
		const s = await loadNamingStatus();
		if (s) { namingStatus = s; prevUnnamed = s.areas.unnamed; }
	});
	// The DURING view reads the ref-counted activity store — the popover/chip's own poller.
	onMount(() => startActivityPolling());

	// The live describe:name row (this run), and the freshest terminal one (the outcome).
	const nameRow = $derived($activity.active.find((j) => j.kind === 'describe:name') ?? null);
	const recentNameRow = $derived($activity.recent.find((j) => j.kind === 'describe:name') ?? null);

	// Run-boundary detection: the row appearing clears `awaitingRow`; the row DISAPPEARING is
	// the completion signal → refetch the vault fact (the percent-named bar updates ONCE, at
	// completion — never mid-run) and derive the AFTER state by comparing counts (no new
	// server field).
	let hadRow = false;   // plain (non-reactive) — transition memory only, never rendered
	$effect(() => {
		const row = nameRow;
		if (row) { hadRow = true; awaitingRow = false; }
		else if (hadRow) { hadRow = false; void onRunFinished(); }
	});

	async function onRunFinished() {
		const s = await loadNamingStatus();
		if (s) namingStatus = s;
		const failed = recentNameRow?.status === 'error';
		const newUnnamed = s?.areas.unnamed ?? null;
		if (afterLingerTimer) { clearTimeout(afterLingerTimer); afterLingerTimer = null; }
		if (s && !s.narrator.ready) {
			// Consent refusal → the card renders the CHOICE, muted, not red (the `choice`
			// card state below — same render as the pre-empted BEFORE state).
			after = null;
			announce('No model is set up to name your areas');
		} else if (failed) {
			after = { kind: 'fault', named: 0, remaining: newUnnamed ?? 0 };
			announce('Naming your areas didn’t finish');
		} else if (newUnnamed != null && newUnnamed > 0) {
			after = { kind: 'partial', named: Math.max(0, (prevUnnamed ?? newUnnamed) - newUnnamed), remaining: newUnnamed };
			announce(`${newUnnamed} ${newUnnamed === 1 ? 'area' : 'areas'} couldn’t be named`);
		} else if (newUnnamed === 0) {
			const n = Math.max(0, prevUnnamed ?? 0);
			after = { kind: 'success', named: n, remaining: 0 };
			announce(n > 0 ? `Named ${n} ${n === 1 ? 'area' : 'areas'}` : 'All areas named');
			afterLingerTimer = setTimeout(() => { after = null; }, 10_000);
		}
		if (s) prevUnnamed = s.areas.unnamed;
		await refreshNamesInList();
	}

	// AFTER — the reward renders in the LIST, in place: reload the mindscape (the job close
	// already busted the server cache) and give each freshly-renamed row one background wash
	// (~400ms, staggered, max 10 — II.5; none under prefers-reduced-motion, in CSS).
	async function refreshNamesInList() {
		const before = new Map(Object.entries(pointsStore.realms).map(([id, r]: [string, any]) => [id, r?.name]));
		try { await mindscapeState.load(); } catch { /* the list keeps its last state */ }
		const renamed: number[] = [];
		for (const [id, r] of Object.entries(pointsStore.realms) as [string, any][]) {
			if (before.get(id) !== r?.name && !isPlaceholderName(r?.name)) renamed.push(Number(id));
		}
		washIds = new Set(renamed.slice(0, 10));
		if (washTimer) clearTimeout(washTimer);
		if (washIds.size) washTimer = setTimeout(() => { washIds = new Set(); }, 2_000);
	}

	// Illuminate = NAME the unnamed areas. It POSTs /mycelium/name-clusters → the naming job
	// (spawns pipeline/describe-clusters.js, the only writer of realm/territory name+essence),
	// NOT generate. generate re-clusters and its debounce SKIPS whenever topology exists, so
	// wiring Illuminate to it was the whole "does nothing" bug — its render condition (realms
	// exist) IS the route's skip condition (DISTILLATION-SURFACE-DESIGN §2/§3a). The job runs in
	// the background; its real progress + outcome (incl. an honest "no model approved" refusal)
	// stream to the activity feed (kind 'describe:name'). This state is just the click ack.
	let naming = $state<{ phase: 'idle' | 'starting' | 'running' | 'busy' | 'disk_low' | 'error'; message: string }>({ phase: 'idle', message: '' });
	let namingResetTimer: ReturnType<typeof setTimeout> | null = null;
	const namingActive = $derived(naming.phase === 'starting' || naming.phase === 'running');
	async function illuminateRealms() {
		naming = { phase: 'starting', message: '' };
		try {
			const data = await apiPost<{ status?: string; note?: string; detail?: { freeGb?: number; needGb?: number } | null }>('/portal/mycelium/name-clusters', {});
			if (data?.status === 'busy') naming = { phase: 'busy', message: data.note || 'A naming pass is already running.' };
			else if (data?.status === 'disk_low') {
				// Structured detail → an actionable number, not a dead-end (II.2 EDGE).
				const d = data.detail;
				const gb = d && Number.isFinite(d.needGb as number) && Number.isFinite(d.freeGb as number)
					? Math.max(1, Math.ceil((d.needGb as number) - (d.freeGb as number))) : null;
				naming = { phase: 'disk_low', message: gb != null
					? `Not enough free space to name your areas safely — free up ~${gb} GB, then try again.`
					: 'Not enough free space to name your areas safely — free up some disk space, then try again.' };
			} else {
				naming = { phase: 'running', message: 'Naming your areas — this runs in the background. Watch the activity feed.' };
				after = null;
				awaitingRow = true;   // hold DURING until the feed poll shows the row
				announce(namingStatus ? `Naming ${namingStatus.areas.unnamed} ${namingStatus.areas.unnamed === 1 ? 'area' : 'areas'}` : 'Naming your areas');
				if (awaitRowTimer) clearTimeout(awaitRowTimer);
				awaitRowTimer = setTimeout(() => {
					// A run so fast the poll never saw its row — settle via the same completion path.
					if (awaitingRow) { awaitingRow = false; void onRunFinished(); }
				}, 15_000);
			}
		} catch {
			naming = { phase: 'error', message: 'Couldn’t start naming your areas. Try again in a moment.' };
		} finally {
			if (namingResetTimer) clearTimeout(namingResetTimer);
			// Let the ack linger, then return the CTA to a clean state — the feed owns the real outcome.
			namingResetTimer = setTimeout(() => { if (naming.phase !== 'starting') naming = { phase: 'idle', message: '' }; }, 90_000);
		}
	}

	// ── Card state (II.2): one state at a time; BEFORE and EMPTY are ONE FACT (unnamed>0) with
	// opposite signs (§3.7a polarity), both owned by the SERVED count. When naming-status is
	// unavailable the card degrades to the pre-Part-II CTA (client-predicate guard) — a failed
	// status fetch must never delete the capability, and must never assert "all named".
	const during = $derived(nameRow != null || naming.phase === 'starting' || awaitingRow || naming.phase === 'busy');
	const cardState = $derived.by(() => {
		if (during) return 'during';
		if (after) return 'after';
		if (!namingStatus) return 'fallback';
		if (namingStatus.areas.unnamed === 0) return 'empty';
		return namingStatus.narrator.ready ? 'before' : 'choice';
	});
	// "Model + where it runs" — rendered from the SERVED narrator authority (the §4g fact),
	// never re-derived client-side (D9: never claim local-only when the route may egress).
	const whereRunsLine = $derived.by(() => {
		const n = namingStatus?.narrator;
		if (!n) return '';
		if (n.local) return `Runs with ${n.model || n.label} on this Mac — nothing leaves`;
		const jur = n.jurisdiction || '';
		const region = jur.startsWith('eu') ? ' (EU)' : jur.startsWith('us') ? ' (US)' : '';
		return `Runs via ${n.label}${region} — your approved provider`;
	});
	const whereRunsShort = $derived.by(() => {
		const n = namingStatus?.narrator;
		if (!n) return '';
		return n.local ? `${n.model || n.label} on this Mac` : `via ${n.label}`;
	});
	// "up to ~52k tokens" — the wire's OWN number (forecast.expectedTokensBound), a bound, never
	// summed with spent (II.2a). ~k formatting only; the bound is not a precision instrument.
	function fmtTokensBound(n: number): string {
		return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
	}
	const pctNamed = $derived(namingStatus && namingStatus.areas.total > 0
		? Math.round((namingStatus.areas.named / namingStatus.areas.total) * 100) : 0);

	// Helper: normalize entity to display name (handles both string and {name/text} formats)
	function entityName(e: any): string {
		if (typeof e === 'string') return e;
		return e?.name || e?.text || String(e);
	}

	// ── Themes for selected realm (with live territory counts) ──
	const themesForRealm = $derived.by(() => {
		if (msState.selectedRealmId === null) return [];
		const realmId = msState.selectedRealmId;

		// Count actual territories per theme from territories data
		const themeTerrCounts: Record<number, number> = {};
		const themeMsgCounts: Record<number, number> = {};
		for (const [, t] of Object.entries(pointsStore.territories)) {
			if (t.realmId === realmId && t.semanticThemeId != null) {
				themeTerrCounts[t.semanticThemeId] = (themeTerrCounts[t.semanticThemeId] || 0) + 1;
				themeMsgCounts[t.semanticThemeId] = (themeMsgCounts[t.semanticThemeId] || 0) + (t.count || 0);
			}
		}

		return Object.entries(pointsStore.semanticThemes)
			.filter(([key]) => key.startsWith(`${realmId}-`))
			.map(([, profile]) => ({
				...profile,
				// Override with live counts from territories data
				territoryCount: themeTerrCounts[profile.semanticThemeId] || profile.territoryCount || 0,
				messageCount: themeMsgCounts[profile.semanticThemeId] || profile.messageCount || 0,
			}))
			// Hide ghost themes — rows in semantic_themes that no live (non-dissolved)
			// territory points at. Previously they rendered with their old stored
			// counts and clicking them produced an empty drilldown.
			.filter(t => (themeTerrCounts[t.semanticThemeId] || 0) > 0)
			.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
	});

	// ── Territories for selected theme (or all in realm if no themes) ──
	const territoriesForView = $derived.by(() => {
		if (msState.selectedRealmId === null) return [];
		const realmId = msState.selectedRealmId;
		const themeId = msState.selectedSemanticThemeId;

		return Object.entries(pointsStore.territories)
			.filter(([, t]) => {
				if (t.realmId !== realmId) return false;
				if (themeId !== null) return t.semanticThemeId === themeId;
				return true;
			})
			.map(([id, t]) => ({ id: Number(id), ...t }))
			.sort((a, b) => (b.count || 0) - (a.count || 0));
	});

	// ── Current detail objects ──
	const currentRealm = $derived.by(() => {
		if (msState.selectedRealmId === null) return null;
		return pointsStore.realms[msState.selectedRealmId] || null;
	});

	const currentTheme = $derived.by(() => {
		if (msState.selectedRealmId === null || msState.selectedSemanticThemeId === null) return null;
		const key = `${msState.selectedRealmId}-${msState.selectedSemanticThemeId}`;
		return pointsStore.semanticThemes[key] || null;
	});

	const currentTerritory = $derived.by(() => {
		if (msState.selectedTerritoryId === null) return null;
		return pointsStore.territories[msState.selectedTerritoryId] || null;
	});

	// Navigation state
	const navLevel = $derived.by(() => {
		if (msState.selectedTerritoryId !== null) return 'territory-detail';
		if (msState.selectedSemanticThemeId !== null) return 'territories';
		if (msState.selectedRealmId !== null) return 'themes';
		return 'realms';
	});

	// ── QA9: a NAVIGATION always re-opens the section ────────────────────────────────────────
	// Collapsing while drilled in hides the breadcrumb, the Back button and the whole card — which
	// is correct, the user asked for it. What is NOT correct is staying collapsed through a
	// navigation the user performs somewhere ELSE: clicking a point in the 3D canvas, the unified
	// back gesture (`lib/nav/back-intent.ts`), or a deep link all change the drill level, and a
	// collapsed rail answers that with an apparently empty panel. Collapse is a "get this out of
	// my way", not a "stop showing me what I just selected" (independent review M-3).
	//
	// Expressed as a DERIVATION, not an $effect: we remember WHICH nav position the user collapsed
	// at, so "expanded" is simply "you are not where you collapsed". Any level or selection change
	// re-opens for free, a plain collapse (which moves no coordinate) is honoured, and there is no
	// effect ordering or dependency-tracking question to get wrong. The first attempt WAS an
	// $effect comparing against a plain `let`, and it silently never fired — measured in a real
	// browser: collapse, then drillIntoRealm() from outside the rail, and the section stayed shut.
	const navKey = $derived(
		`${navLevel}:${msState.selectedRealmId}:${msState.selectedSemanticThemeId}:${msState.selectedTerritoryId}`,
	);
	const sectionExpanded = $derived(collapsedAtNavKey !== navKey);

	// Selected activity bar (hover is owned by the ActivityBars component now).
	let selectedActivity = $state<{ month: string; count: number } | null>(null);
	let selectedActivityChronicle = $state<{ theme: string; signature: string; narrative: string } | null>(null);
	let selectedActivityLoading = $state(false);

	async function selectActivityBar(item: { month: string; count: number }) {
		if (selectedActivity?.month === item.month) {
			selectedActivity = null;
			selectedActivityChronicle = null;
			return;
		}
		selectedActivity = item;
		selectedActivityChronicle = null;
		selectedActivityLoading = true;

		// Check if we have a chronicle for this month
		try {
			const res = await api(`/portal/mindscape/time-chronicles`);
			if (res.ok) {
				const data = await res.json();
				const match = (data.chronicles || []).find((c: any) => c.period_key?.startsWith(item.month));
				if (match) {
					selectedActivityChronicle = { theme: match.theme, signature: match.signature, narrative: match.narrative || match.theme };
				}
			}
		} catch {}
		selectedActivityLoading = false;
	}

	// Per-period Illuminate (POST /mindscape/explore → time_chronicles) is deferred Phase G/C:
	// the endpoint doesn't exist and nothing writes time_chronicles yet, so the trigger was
	// removed (see the "coming soon" note in the period detail). Whole-mindscape Illuminate
	// (the top CTA → /mycelium/name-clusters) is the working path.

	const totalMessages = $derived(pointsStore.meta?.total || pointsStore.points.length);
	const totalRealms = $derived(Object.keys(pointsStore.realms).length);
</script>

<div class="mindscape-nav">
	<!-- ONE persistent visually-hidden live region (II.7 / P8): always mounted, textContent
	     SWAPPED at milestones only (start / done / error — never per tick). Inserting a node
	     that already contains the message is announced inconsistently across AT (#204 r3);
	     a stable region whose text changes is the robust pattern. Choices announce politely —
	     a choice is not an alert. -->
	<div class="sr-live" aria-live="polite">{announceText}</div>

	<!-- QA9: the Mindscape section gets the SAME whole-header disclosure as the pipeline card and
	     the live process indicator — one pattern, one component (CollapsibleHeader). It stays
	     OUTSIDE the {#if sectionExpanded} below so collapsing can never hide its own way back.
	     Default open: this is the rail's primary content, not an optional detail.
	     A FUNCTION BINDING, because `sectionExpanded` is derived, not stored: collapsing records
	     the nav position it happened at, expanding clears it. That is what makes a navigation
	     re-open the section by construction rather than by an effect racing the store. -->
	<CollapsibleHeader
		bind:expanded={() => sectionExpanded, (v) => (collapsedAtNavKey = v ? null : navKey)}
		label="the mindscape navigator"
		testid="mindscape-section-toggle"
		extraClass="rail-section-header"
	>
		<span class="rail-section-title">Mindscape</span>
		{#if totalRealms > 0}
			<span class="rail-section-sub">{totalRealms} {totalRealms === 1 ? 'area' : 'areas'}</span>
		{/if}
	</CollapsibleHeader>

	{#if sectionExpanded}
	<!-- Breadcrumb — hidden at the realms root (a lone "Mycelium" there just
	     duplicates the page). Shown only once drilled in, as a back-path. -->
	{#if navLevel !== 'realms'}
	<div class="breadcrumb">
		<button class="breadcrumb-link" onclick={() => mindscapeState.resetNavigation()}>
			Areas
		</button>
		{#if msState.selectedRealmId !== null}
			<span class="breadcrumb-sep">/</span>
			<button
				class="breadcrumb-link"
				class:active={navLevel === 'themes'}
				onclick={() => mindscapeState.drillIntoRealm(msState.selectedRealmId!)}
			>
				{currentRealm && isRealmDescribed(currentRealm) ? currentRealm.name : `Area ${currentRealmIdx + 1}`}
			</button>
		{/if}
		{#if msState.selectedSemanticThemeId !== null && currentTheme}
			<span class="breadcrumb-sep">/</span>
			<button
				class="breadcrumb-link"
				class:active={navLevel === 'territories'}
				onclick={() => mindscapeState.drillIntoTheme(msState.selectedRealmId!, msState.selectedSemanticThemeId!)}
			>
				{currentTheme.name}
			</button>
		{/if}
		{#if msState.selectedTerritoryId !== null && currentTerritory}
			<span class="breadcrumb-sep">/</span>
			<span class="breadcrumb-current">{currentTerritory.name || `T${msState.selectedTerritoryId}`}</span>
		{/if}
	</div>
	{/if}

	<!-- Back control (R4-BACKBTN) — lives IN the side section, directly above the cards, once
	     drilled in. It replaces the button that used to float on the 3D canvas (top-left), which
	     read as "outside the side section and too far" from the list it navigates. `goBack()`
	     already walks the hierarchy (territory → theme → realm → root), so one handler covers every
	     level. Hidden at the realms root — there is nowhere to go back to. -->
	{#if navLevel !== 'realms'}
		<button class="detail-back" onclick={() => mindscapeState.goBack()}>
			<span aria-hidden="true">&larr;</span> Back
		</button>
	{/if}

	<div class="nav-content">
		{#if navLevel === 'realms'}
			<!-- ═══ REALM LIST ═══ -->
			{#if cardState === 'empty' && sortedRealms.length > 0 && namingStatus}
				<!-- EMPTY (II.2): all named ⇒ NO card, NO CTA — one muted line. BEFORE and EMPTY
				     are one served fact (areas.unnamed) with opposite signs, never both. -->
				<p class="all-named-line">{namingStatus.areas.total} {namingStatus.areas.total === 1 ? 'area' : 'areas'} · all named</p>
			{/if}
			<div class="nav-list">
				{#each sortedRealms as realm, i (realm.id)}
					{@const described = isRealmDescribed(realm)}
					<button
						class="nav-item realm-item"
						class:undescribed={!described}
						class:renamed={washIds.has(realm.id)}
						style={washIds.has(realm.id) ? `animation-delay: ${[...washIds].indexOf(realm.id) * 40}ms` : ''}
						onclick={() => mindscapeState.drillIntoRealm(realm.id)}
						onmouseenter={() => mindscapeState.setHovered('realm', realm.id)}
						onmouseleave={() => mindscapeState.setHovered('realm', null)}
					>
						<span class="nav-dot" class:muted={!described} style={described ? `background: ${getColor(realm.id)}` : ''}></span>
						<div class="nav-item-content">
							<span class="nav-item-name">{realmLabel(realm, i)}</span>
							<span class="nav-item-stats">{realm.pointCount?.toLocaleString()} points · {realm.territoryCount} {realm.territoryCount === 1 ? 'territory' : 'territories'}</span>
							{#if described && realm.essence}
								<span class="nav-item-essence">{realm.essence}</span>
							{/if}
						</div>
					</button>
				{/each}
			</div>

			<!-- The AUTO-generate outcome render site (D2 pins these: `$generate` had NO render
			     site app-wide, so both an error and "already built" were SILENCE — design §5.4;
			     a reviewer once deleted the whole button and the suite still said GO). A snippet
			     because it renders inside the BEFORE card (next to the CTA) AND in the fallback
			     branch, and duplicating the phase enumeration is how phases go silent. -->
			{#snippet genNotes()}
				{#if $generate.phase === 'up-to-date'}
					<p class="cta-note">{$generate.message || 'Your map is already built.'}</p>
				{:else if $generate.phase === 'error' && $generate.error}
					<p class="cta-note err">{$generate.error}</p>
				{:else if $generate.phase === 'embedding' && $generate.message}
					<p class="cta-note">{$generate.message}</p>
				{/if}
			{/snippet}

			{#if sortedRealms.length > 0}
				<!-- ═══ THE NAMING RUN SURFACE (Part II) — the Illuminate CTA grown into a card.
				     It POSTs /mycelium/name-clusters → the naming job (describe-clusters.js, the
				     ONLY writer of realm/territory name+essence) in gap-fill mode — NOT generate
				     (its debounce skips whenever topology exists: the old "does nothing" bug).
				     describe-more is NOT this act: it spawns describe-chronicles, which PRESERVES
				     names and writes prose, never a name.
				     §1: the card is CONTENT-FREE in every state — counts, model ids, times; the
				     names render only in the area list above (the rendered vault, gate IL8). -->
				{#if cardState === 'during'}
					<div class="naming-card nc-swap">
						<!-- DURING renders the FEED ROW — the single owner of run progress (IL4):
						     step/total, ETA, elapsed are the row's own numbers, never recomputed.
						     The percent-named bar does NOT tick here (two owners = the R4 defect). -->
						<div class="nc-title-row">
							<span class="nc-title">{nameRow?.stage || 'Naming your areas'}</span>
							<span class="nc-state">● running</span>
						</div>
						<div class="nc-bar" role="progressbar" aria-label="Naming your areas"
							aria-valuemin="0" aria-valuemax={nameRow?.total || 0} aria-valuenow={nameRow?.done || 0}>
							<div class="nc-bar-fill running" style="width: {nameRow && nameRow.total > 0 ? Math.min(100, (nameRow.done / nameRow.total) * 100) : 0}%"></div>
						</div>
						<p class="nc-fact">
							{#if nameRow && nameRow.total > 0}
								{nameRow.done} of {nameRow.total}{#if fmtEta(nameRow.etaSeconds)}&nbsp;· {fmtEta(nameRow.etaSeconds)} left{/if}
							{:else}
								Starting…
							{/if}
						</p>
						<p class="nc-meta">
							{#if nameRow?.startedAt}
								Started {fmtAgo(nameRow.startedAt)}{#if whereRunsShort}&nbsp;· {whereRunsShort}{/if}
							{:else if naming.phase === 'busy' && naming.message}
								{naming.message}
							{/if}
						</p>
					</div>
				{:else if cardState === 'after' && after}
					<div class="naming-card nc-swap">
						{#if after.kind === 'success'}
							<p class="nc-fact">Named {after.named} {after.named === 1 ? 'area' : 'areas'} just now</p>
						{:else if after.kind === 'partial'}
							<div class="nc-bar" aria-hidden="true"><div class="nc-bar-fill" style="width: {pctNamed}%"></div></div>
							<p class="nc-fact">Named {after.named} {after.named === 1 ? 'area' : 'areas'} — {after.remaining} couldn’t be named ·
								<button class="nc-link" onclick={illuminateRealms}>Try again</button></p>
						{:else}
							<p class="nc-fact nc-err">Naming your areas didn’t finish.
								<button class="nc-link" onclick={illuminateRealms}>Try again</button></p>
						{/if}
					</div>
					{#if naming.phase === 'idle'}{@render genNotes()}{/if}
				{:else if cardState === 'before' && namingStatus}
					<div class="naming-card nc-swap">
						<span class="nc-title">Name your areas</span>
						<p class="nc-fact">{namingStatus.areas.unnamed} of your {namingStatus.areas.total} areas still have placeholder names.</p>
						<div class="nc-bar" aria-hidden="true"><div class="nc-bar-fill" style="width: {pctNamed}%"></div></div>
						<p class="nc-meta">{namingStatus.areas.named} named · {pctNamed}%</p>
						<ul class="nc-facts">
							<!-- The served §4g authority — never client-derived (D9). -->
							<li>{whereRunsLine}</li>
							<!-- The wire's own bound: "up to ~" is true by construction (II.3);
							     never summed with spent. -->
							<li>Uses up to ~{fmtTokensBound(namingStatus.forecast.expectedTokensBound)} tokens{namingStatus.narrator.local ? ', free on your hardware' : `, on your ${namingStatus.narrator.label} plan`}</li>
							<!-- PRESERVE gap-fill is a FACT of the job, stated as the guarantee. -->
							<li>Keeps every name you already have</li>
						</ul>
						<!-- NO duration claim pre-start: no banked naming throughput exists, and
						     inventing one repeats the "~40 msgs/min" lie #204 refuted. -->
						<button class="realm-cta illuminate nc-cta" onclick={illuminateRealms} disabled={namingActive || genActive}>
							<span class="cta-title">Name {namingStatus.areas.unnamed} {namingStatus.areas.unnamed === 1 ? 'area' : 'areas'}</span>
						</button>
						<p class="nc-meta">You’ll see live progress here and in the feed; a real time estimate appears once it starts.</p>
						{#if naming.phase !== 'idle' && naming.message}
							<p class="cta-note" class:err={naming.phase === 'error' || naming.phase === 'disk_low'}>{naming.message}</p>
						{/if}
						{#if naming.phase === 'idle'}{@render genNotes()}{/if}
					</div>
				{:else if cardState === 'choice'}
					<div class="naming-card nc-swap">
						<!-- No capability: the CTA is REPLACED by the choice, muted, not red — a
						     choice is not an alert (§8.2), and pre-empting the click-then-refusal
						     path beats manufacturing it (IL3). The pipeline's own refusal (N5b)
						     stays as defense-in-depth. -->
						<span class="nc-title">Name your areas</span>
						<p class="nc-choice">No model is set up to name your areas ·
							<button class="nc-link" onclick={connectIntelligence}>Choose a model →</button></p>
					</div>
					{#if naming.phase === 'idle'}{@render genNotes()}{/if}
				{:else if cardState === 'empty'}
					{#if naming.phase === 'idle'}{@render genNotes()}{/if}
				{:else if anyUndescribed}
					<!-- FALLBACK: naming-status unavailable. The pre-Part-II CTA on the CLIENT
					     predicate — a failed status fetch must never delete the capability (and
					     must never render a fake bundle of counts it doesn't have). -->
					{#if aiConnected}
						<button class="realm-cta illuminate" onclick={illuminateRealms} disabled={namingActive || genActive}>
							<span class="cta-icon">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
							</span>
							<span class="cta-body">
								<span class="cta-title">{namingActive ? 'Naming…' : 'Name your areas'}</span>
								<span class="cta-sub">{namingActive ? 'Naming your areas.' : 'Let your AI name these areas.'}</span>
							</span>
						</button>

						<!-- ⚠️ THE OUTCOME, RENDERED. This is the click ack; the full progress +
						     the honest "no model approved" refusal stream to the activity feed
						     (kind 'describe:name'). A CTA that reports nothing is the original
						     bug (design §5.4 "representable ≠ shown"). -->
						{#if naming.phase !== 'idle' && naming.message}
							<p class="cta-note" class:err={naming.phase === 'error' || naming.phase === 'disk_low'}>{naming.message}</p>
						{/if}

						{#if naming.phase === 'idle'}{@render genNotes()}{/if}
					{:else}
						<button class="realm-cta spawn" onclick={connectIntelligence}>
							<span class="cta-icon">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
							</span>
							<span class="cta-body">
								<span class="cta-title">Spawn intelligence</span>
								<span class="cta-sub">Connect an AI to name &amp; explore your areas.</span>
							</span>
							<span class="cta-arrow">→</span>
						</button>
					{/if}
				{/if}
			{/if}

			<!-- ⚠️ MOUNTED UNCONDITIONALLY at the realm level, deliberately (D-004). It is NOT
			     nested under the naming card's cardState, and NOT under `sortedRealms.length > 0`:
			     the whole defect was a remedy that existed only behind a condition the user could
			     not reach. This component owns its own honest empty/unknown states. -->
			<MapFreshness />

			{#if totalMessages > 0}
				<div class="nav-footer">
					{totalMessages.toLocaleString()} messages · {totalRealms} {totalRealms === 1 ? 'area' : 'areas'}
				</div>
			{/if}

		{:else if navLevel === 'themes'}
			<!-- ═══ THEME LIST (within a realm) ═══ -->
			{#if currentRealm}
				<div class="section-header">
					<p class="section-stats">{currentRealm.pointCount?.toLocaleString()} points · {currentRealm.territoryCount} territories</p>
					{#if currentRealm.essence}
						<p class="section-essence">{currentRealm.essence}</p>
					{/if}
					{#if currentRealm.storyCurrentChapter}
						<p class="section-chapter">{currentRealm.storyCurrentChapter}</p>
					{/if}
					{#if currentRealm.topEntities && currentRealm.topEntities.length > 0}
						<div class="section-entities">
							{#each currentRealm.topEntities.slice(0, 8) as entity}
								<span class="entity-tag">{entityName(entity)}</span>
							{/each}
						</div>
					{/if}
					{#if currentRealm.signaturePatterns && currentRealm.signaturePatterns.length > 0}
						<div class="section-patterns">
							{#each currentRealm.signaturePatterns.slice(0, 4) as p}
								<span class="pattern-tag">{p}</span>
							{/each}
						</div>
					{/if}
				</div>
				<!-- R4-ACTIVITYBARS: realm level now uses the SAME timestamped, hover-tooltip bars as
				     the theme + territory levels (was a bare sparkline with no time context). -->
				{#if currentRealm.activity && currentRealm.activity.length > 0}
					<ActivityBars data={currentRealm.activity} />
				{/if}
			{/if}

			{#if themesForRealm.length > 0}
				<div class="nav-list">
					{#each themesForRealm as theme (theme.semanticThemeId)}
						<button
							class="nav-item theme-item"
							onclick={() => mindscapeState.drillIntoTheme(msState.selectedRealmId!, theme.semanticThemeId)}
							onmouseenter={() => mindscapeState.setHovered('theme', theme.semanticThemeId)}
							onmouseleave={() => mindscapeState.setHovered('theme', null)}
						>
							<div class="nav-item-content">
								<span class="nav-item-name">{theme.name}</span>
								<span class="nav-item-stats">{theme.messageCount?.toLocaleString()} messages · {theme.territoryCount} territories</span>
								{#if theme.essence}
									<span class="nav-item-essence">{theme.essence}</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{:else}
				<!-- No themes — show territories directly -->
				<div class="nav-list">
					{#each territoriesForView as territory (territory.id)}
						<button
							class="nav-item territory-item"
							class:selected={msState.selectedTerritoryId === territory.id}
							onclick={() => mindscapeState.selectTerritory(msState.selectedTerritoryId === territory.id ? null : territory.id)}
							onmouseenter={() => mindscapeState.setHovered('territory', territory.id)}
							onmouseleave={() => mindscapeState.setHovered('territory', null)}
						>
							<span class="nav-dot" style="background: {getColor(territory.id)}"></span>
							<div class="nav-item-content">
								<span class="nav-item-name">{territory.name || `Territory ${territory.id}`}</span>
								<span class="nav-item-stats">{territory.count?.toLocaleString()} messages</span>
							</div>
						</button>
					{/each}
				</div>
			{/if}

		{:else if navLevel === 'territories'}
			<!-- ═══ TERRITORY LIST (within a theme) ═══ -->
			{#if currentTheme}
				<div class="section-header">
					<p class="section-stats">{territoriesForView.length} territories · {territoriesForView.reduce((s, t) => s + (t.count || 0), 0).toLocaleString()} messages</p>
					{#if currentTheme.essence}
						<p class="section-essence">{currentTheme.essence}</p>
					{/if}
					{#if currentTheme.storyArc}
						<p class="section-chapter">{currentTheme.storyArc}</p>
					{/if}
					{#if currentTheme.storyCurrentChapter}
						<p class="section-chapter"><strong>Now:</strong> {currentTheme.storyCurrentChapter}</p>
					{/if}
				</div>

				{#if currentTheme.activity && currentTheme.activity.length > 0}
					<!-- R4-ACTIVITYBARS: unified bars — friendly timestamps + hover time tooltip. -->
					<ActivityBars data={currentTheme.activity} />
				{/if}

				{#if currentTheme.topEntities && currentTheme.topEntities.length > 0}
					<div class="section-entities">
						{#each currentTheme.topEntities.slice(0, 10) as entity}
							<span class="entity-tag">{entityName(entity)}</span>
						{/each}
					</div>
				{/if}

				{#if currentTheme.signaturePatterns && currentTheme.signaturePatterns.length > 0}
					<div class="section-patterns">
						{#each currentTheme.signaturePatterns.slice(0, 4) as pattern}
							<p class="pattern-item">{pattern}</p>
						{/each}
					</div>
				{/if}
			{/if}

			<div class="nav-list">
				{#each territoriesForView as territory (territory.id)}
					<button
						class="nav-item territory-item"
						class:selected={msState.selectedTerritoryId === territory.id}
						onclick={() => mindscapeState.selectTerritory(msState.selectedTerritoryId === territory.id ? null : territory.id)}
						onmouseenter={() => mindscapeState.setHovered('territory', territory.id)}
						onmouseleave={() => mindscapeState.setHovered('territory', null)}
					>
						<span class="nav-dot" style="background: {getColor(territory.id)}"></span>
						<div class="nav-item-content">
							<span class="nav-item-name">{territory.name || `Territory ${territory.id}`}</span>
							<span class="nav-item-stats">{territory.count?.toLocaleString()} messages{#if territory.exploredPercent > 0} · {territory.exploredPercent.toFixed(0)}% explored{/if}</span>
						</div>
					</button>
				{/each}
			</div>

		{:else if navLevel === 'territory-detail' && currentTerritory}
			<!-- ═══ TERRITORY DETAIL ═══ -->
			<div class="detail-panel">
				<div class="detail-header">
					<div class="detail-color-bar" style="background-color: {getColor(msState.selectedTerritoryId!)}"></div>
					<div class="detail-title-row">
						<h2 class="detail-title">{currentTerritory.name}</h2>
						<select
							class="visibility-select"
							value={currentTerritory.visibility || 'private'}
							onchange={(e) => setVisibility(msState.selectedTerritoryId!, (e.target as HTMLSelectElement).value)}
							disabled={savingVisibility}
						>
							{#each VISIBILITY_OPTIONS as opt}
								<option value={opt.value}>{opt.icon} {opt.label}</option>
							{/each}
						</select>
					</div>
					<div class="badge-row">
						{#if currentTerritory.archetypeType}
							<span class="archetype-badge">{currentTerritory.archetypeType}</span>
						{/if}
						{#if currentTerritory.gravityShare != null && currentTerritory.gravityShare > 0}
							<!-- R4-AREADATA: the territory's gravitational pull — a computed scalar the
							     vault holds (gravity_share) that the detail used to drop. -->
							<span class="gravity-badge" title="Share of this mind's total gravity — how much it pulls the rest of your thinking toward it">◎ {(currentTerritory.gravityShare * 100).toFixed(currentTerritory.gravityShare < 0.1 ? 1 : 0)}% gravity</span>
						{/if}
						{#if currentTerritory.currentPhase === 'sparse' || currentTerritory.currentPhase === 'active' || currentTerritory.currentPhase === 'anchor'}
							<span class="phase-badge phase-{currentTerritory.currentPhase}">{currentTerritory.currentPhase} · {(currentTerritory.currentVitality || 0).toFixed(2)}</span>
						{/if}
						{#if currentTerritory.isAnchored}
							<span class="anchored-badge" title="Protected from re-clustering dissolution">⚓ anchored</span>
						{/if}
						{#if currentTerritory.evolvedFromCount > 0}
							<span class="evolved-badge" title="This territory inherited messages from {currentTerritory.evolvedFromCount} dissolved territory/territories">↳ evolved from {currentTerritory.evolvedFromCount}</span>
						{/if}
					</div>
					{#if currentTerritory.archetypeCharacter}
						<!-- R4-AREADATA: the archetype's CHARACTER (its persona voice) — held on the
						     profile (archetype_character) but never shown; only the type badge was. -->
						<p class="detail-archetype-char">{currentTerritory.archetypeCharacter}</p>
					{/if}
					<p class="detail-stats">
						{currentTerritory.count?.toLocaleString() || 0} messages
						{#if currentTerritory.exploredPercent > 0}
							· {currentTerritory.exploredPercent.toFixed(0)}% explored
						{/if}
						{#if currentTerritory.daysActive}
							· {currentTerritory.daysActive}d span
						{/if}
						{#if currentTerritory.firstActive}
							· since {currentTerritory.firstActive}
						{/if}
					</p>
					{#if currentTerritory.exploredPercent < 100 && msState.selectedTerritoryId != null}
						<button class="describe-more-btn" disabled={describingTerritoryId === msState.selectedTerritoryId}
							onclick={() => describeTerritory(msState.selectedTerritoryId!)}
							title="Deepen this area's description by folding in content not yet described">
							{describingTerritoryId === msState.selectedTerritoryId ? 'Describing…' : 'Describe more'}
						</button>
					{/if}
					{#if currentTerritory.temporalSaliency != null}
						<div class="saliency-row">
							<div class="saliency-bar-bg">
								<div class="saliency-bar-fill" style="width:{Math.round(currentTerritory.temporalSaliency * 100)}%;opacity:{0.4 + currentTerritory.temporalSaliency * 0.6}"></div>
							</div>
							<span class="saliency-label">
								{#if currentTerritory.temporalSaliency > 0.7}active now
								{:else if currentTerritory.temporalSaliency > 0.3}recent
								{:else if currentTerritory.temporalSaliency > 0.05}fading
								{:else}dormant{/if}
							</span>
							{#if currentTerritory.lastActive}
								<span class="saliency-date">{currentTerritory.lastActive}</span>
							{/if}
						</div>
					{/if}
				</div>
				{#if currentTerritory.essence}
					<div class="detail-essence">{currentTerritory.essence}</div>
				{/if}

				{#if currentTerritory.chronicle}
					<div class="detail-block">
						<h4>Chronicle</h4>
						<div class="chronicle-text">{currentTerritory.chronicle}</div>
					</div>
				{:else if !currentTerritory.essence}
					<!-- Undescribed territory (narration runs async after clustering): show a
					     clear pending state instead of a blank, broken-looking panel. -->
					<div class="detail-block">
						<div class="chronicle-text" style="opacity:0.6;font-style:italic">Still describing this territory — its essence and chronicle are being written. This runs automatically after generation; check back in a moment.</div>
					</div>
				{/if}

				{#if currentTerritory.activity && currentTerritory.activity.length > 0}
					<!-- R4-ACTIVITYBARS: unified bars — friendly timestamps + hover time tooltip.
					     The territory level keeps its click-to-open-a-period-chronicle interaction
					     via onSelect/selectedMonth; the period detail renders just below. -->
					<ActivityBars
						data={currentTerritory.activity}
						selectedMonth={selectedActivity?.month ?? null}
						onSelect={selectActivityBar}
					/>
					{#if selectedActivity}
						<div class="period-detail-wrap">
							<div class="period-detail">
								{#if selectedActivityLoading}
									<div class="period-loading">
										<div class="period-spinner"></div>
									</div>
								{:else if selectedActivityChronicle}
									<div class="period-chronicle">
										<span class="period-theme">{selectedActivityChronicle.theme}</span>
										{#if selectedActivityChronicle.signature}
											<span class="period-sig" class:sig-steady={selectedActivityChronicle.signature === 'steady'} class:sig-exploring={selectedActivityChronicle.signature === 'exploring'} class:sig-consolidating={selectedActivityChronicle.signature === 'consolidating'} class:sig-fragmenting={selectedActivityChronicle.signature === 'fragmenting'}>{selectedActivityChronicle.signature}</span>
										{/if}
									</div>
								{:else}
									<div class="period-dark">
										<span class="period-dark-label">{selectedActivity.month} &middot; {selectedActivity.count} points &middot; not yet explored</span>
										<!-- Period-level Illuminate (time-chronicles) is an unbuilt surface: there is no
										     /mindscape/explore job and nothing writes time_chronicles yet (deferred Phase G/C).
										     The old button POSTed a 404 and polled forever — disabled here so it can't present a
										     broken action. Whole-mindscape Illuminate (the top CTA) is the working path. -->
										<span class="period-illuminate-btn" style="opacity:0.55;cursor:default;" title="Per-period exploration isn't available yet">coming soon</span>
									</div>
								{/if}
							</div>
						</div>
					{/if}
				{/if}

				<div class="detail-body">
					{#if currentTerritory.signaturePatterns && currentTerritory.signaturePatterns.length > 0}
						<div class="detail-block">
							<h4>Patterns</h4>
							<ul class="detail-list">
								{#each currentTerritory.signaturePatterns as pattern}
									<li>{pattern}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if currentTerritory.storyBirth}
						<div class="detail-block">
							<h4>Origin</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.storyBirth)}</div>
						</div>
					{/if}
					{#if currentTerritory.storyArc}
						<div class="detail-block">
							<h4>Story Arc</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.storyArc)}</div>
						</div>
					{/if}
					{#if currentTerritory.storyCurrentChapter}
						<div class="detail-block">
							<h4>Current Chapter</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.storyCurrentChapter)}</div>
						</div>
					{/if}
					{#if currentTerritory.storyPeakMoments && currentTerritory.storyPeakMoments.length > 0}
						<!-- R4-AREADATA: peak moments (story_peak_moments) — on the payload, never rendered. -->
						<div class="detail-block">
							<h4>Peak Moments</h4>
							<ul class="detail-list">
								{#each currentTerritory.storyPeakMoments as moment}
									<li>{moment}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if currentTerritory.topEntities && currentTerritory.topEntities.length > 0}
						<div class="detail-block">
							<h4>Key Entities</h4>
							<div class="entity-tags">
								{#each currentTerritory.topEntities.slice(0, 12) as entity}
									<span class="entity-tag">{entityName(entity)}</span>
								{/each}
							</div>
						</div>
					{/if}
					{#if currentTerritory.uncertaintyEdges}
						<div class="detail-block">
							<h4>Connected Regions</h4>
							<p class="detail-text-secondary">{currentTerritory.uncertaintyEdges}</p>
						</div>
					{/if}
					{#if currentTerritory.agentWouldConsult && currentTerritory.agentWouldConsult.length > 0}
						<div class="detail-block">
							<h4>Cross-References</h4>
							<div class="cross-ref-tags">
								{#each currentTerritory.agentWouldConsult as ref}
									<span class="cross-ref-tag">{ref.territory_name || ref.for || JSON.stringify(ref)}</span>
								{/each}
							</div>
						</div>
					{/if}
					{#if territoryContacts.length > 0}
						<div class="detail-block">
							<h4>Linked Contacts</h4>
							<div class="contacts-list">
								{#each territoryContacts as contact}
									{@const isSelected = msState.selectedContactId === contact.id}
									<button
										class="contact-card"
										onmouseenter={() => mindscapeState.hoverContact(contact.id)}
										onmouseleave={() => mindscapeState.hoverContact(null)}
										onclick={() => mindscapeState.selectContact(isSelected ? null : contact.id)}
										class:selected={isSelected}
									>
										<div class="contact-name-row">
											<span class="contact-name">{contact.name}</span>
											{#if contact.source === 'linkedin'}
												<svg class="contact-source-icon" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
											{/if}
										</div>
										{#if contact.description?.essence}
											<p class="contact-essence">{contact.description.essence}</p>
										{/if}
										<div class="contact-meta">
											{#if contact.position}<span>{contact.position}</span>{/if}
											{#if contact.company}<span>{contact.company}</span>{/if}
											<span class="contact-tier">{contact.tier}</span>
										</div>
										<div class="contact-meta">
											{#if contact.interaction_count}
												<span>{contact.interaction_count} msg{#if contact.outbound_count} · {contact.outbound_count} sent{/if}</span>
											{/if}
											{#if contact.last_interaction_at}
												<span>last {relativeDate(contact.last_interaction_at)}</span>
											{/if}
											{#if contact.connected_at}
												<span>since {new Date(contact.connected_at).getFullYear()}</span>
											{/if}
										</div>
										{#if isSelected}
											<div class="contact-detail">
												{#if contact.email}
													<!-- svelte-ignore a11y_no_static_element_interactions -->
													<a href="mailto:{contact.email}" class="contact-email" onclick={(e) => e.stopPropagation()}>{contact.email}</a>
												{/if}
												{#if contact.linkedin_url}
													<!-- svelte-ignore a11y_no_static_element_interactions -->
													<a href={contact.linkedin_url} target="_blank" rel="noopener" class="contact-linkedin" onclick={(e) => e.stopPropagation()}>LinkedIn Profile</a>
												{/if}
												{#if contact.description}
													<div class="contact-chronicle">
														{#if contact.description.relationship_arc}
															<p class="chronicle-arc">{contact.description.relationship_arc}</p>
														{/if}
														{#if contact.description.interaction_style}
															<p class="chronicle-style">{contact.description.interaction_style}</p>
														{/if}
														{#if contact.description.notable_moments?.length}
															<div class="chronicle-moments">
																{#each contact.description.notable_moments as moment}
																	<p class="chronicle-moment">{moment}</p>
																{/each}
															</div>
														{/if}
														{#if contact.description.signature_topics?.length}
															<div class="chronicle-topics">
																{#each contact.description.signature_topics as topic}
																	<span class="chronicle-topic">{topic}</span>
																{/each}
															</div>
														{/if}
													</div>
												{/if}
												<div class="contact-territories">
													{#each contact.territories as t}
														<span class="territory-link" style="opacity: {0.5 + t.strength * 0.5}">
															{t.territory_name || `Territory ${t.territory_id}`}
															<span class="strength">({(t.strength * 100).toFixed(0)}%)</span>
														</span>
													{/each}
												</div>
												<!-- Messages -->
												<div class="contact-messages">
													{#if $contactMessagesLoading}
														<div class="contact-messages-loading">
															<div class="msg-spinner"></div>
															Loading...
														</div>
													{:else if $contactMessages.length === 0}
														<span class="contact-stats">No messages found</span>
													{:else}
														{#each $contactMessages as msg}
															<div class="contact-msg">
																<div class="contact-msg-header">
																	<span class="contact-msg-role" class:you={msg.role === 'user'}>
																		{msg.role === 'user' ? 'You' : contact.name.split(' ')[0]}
																	</span>
																	<span class="contact-msg-date">{new Date(msg.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
																</div>
																<p class="contact-msg-text">{msg.content}</p>
															</div>
														{/each}
													{/if}
												</div>
											</div>
										{/if}
									</button>
								{/each}
							</div>
						</div>
					{/if}
					{#if currentTerritory.uncertaintyOpenQuestions && currentTerritory.uncertaintyOpenQuestions.length > 0}
						<div class="detail-block">
							<h4>Open Questions</h4>
							<ul class="detail-list">
								{#each currentTerritory.uncertaintyOpenQuestions as question}
									<li>{question}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if currentTerritory.agentExpertise}
						<div class="detail-block">
							<h4>Expertise</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.agentExpertise)}</div>
						</div>
					{/if}
					{#if currentTerritory.agentCuriousAbout}
						<!-- R4-AREADATA: agent_curious_about — held on the profile, previously dropped. -->
						<div class="detail-block">
							<h4>Curious About</h4>
							<div class="markdown-content">{@html renderMarkdown(currentTerritory.agentCuriousAbout)}</div>
						</div>
					{/if}
					{#if currentTerritory.agentCanHelpWith && currentTerritory.agentCanHelpWith.length > 0}
						<!-- R4-AREADATA: agent_can_help_with — held on the profile, previously dropped. -->
						<div class="detail-block">
							<h4>Can Help With</h4>
							<ul class="detail-list">
								{#each currentTerritory.agentCanHelpWith as item}
									<li>{item}</li>
								{/each}
							</ul>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
	{/if}
</div>

<style>
	.mindscape-nav {
		/* D-034 ↻1. This used to be `height: 100%; overflow: hidden`, which is what made #350's
		   fix unreachable: as one of FIVE stacked sections in the rail it claimed the rail's
		   ENTIRE height, so its own bottom edge sat below the panel's clip line and the three
		   sections after it were off-screen at every scroll position. It is now a normal
		   content-sized block inside the rail's single scroll port (`.nav-rail`,
		   MindscapeView.svelte). No `height`, no `overflow` — the section must be exactly as tall
		   as what is in it and let the rail scroll it.
		   ⚠️ `overflow` MUST NOT COME BACK, on any axis, and not to clip the `border-radius`
		   below either — beyond re-creating the nested scroller, any overflow here makes THIS box
		   the nearest scrollport and the sticky `.breadcrumb` would pin to it instead of to the
		   rail, i.e. stop working. verify:mindscape-rail S4 fails the build on any of the three
		   overflow properties. */
		display: flex;
		flex-direction: column;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 10px;
	}

	/* The rail-section header (QA9) — the label + count inside <CollapsibleHeader>. The button
	   chrome and the caret belong to that component; only the CONTENT is styled here. */
	.rail-section-title {
		font-size: 0.74rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
	}
	.rail-section-sub {
		font-size: 0.68rem;
		color: var(--color-text-tertiary);
	}
	:global(.mindscape-nav > .rail-section-header) {
		padding: 10px 14px;
	}

	/* Breadcrumb — sticky so the drill path stays on screen while the rail scrolls. It used to
	   be pinned by `flex-shrink: 0` against a full-height section; that section is gone (see
	   `.mindscape-nav`), so `position: sticky` is what preserves the affordance. */
	.breadcrumb {
		position: sticky;
		top: 0;
		z-index: 2;
		background: var(--color-elevated);
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		flex-wrap: wrap;
	}
	.breadcrumb-link {
		color: var(--color-text-tertiary);
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.75rem;
		font-family: inherit;
		padding: 2px 4px;
		border-radius: 3px;
		transition: all 0.15s;
	}
	.breadcrumb-link:hover {
		color: var(--color-accent);
		background: rgba(229, 184, 76, 0.08);
	}
	.breadcrumb-link.active {
		color: var(--color-text-primary);
		font-weight: 600;
	}
	.breadcrumb-sep {
		color: var(--color-text-tertiary);
		font-size: 0.7rem;
		opacity: 0.5;
	}
	.breadcrumb-current {
		font-size: 0.75rem;
		color: var(--color-text-primary);
		font-weight: 600;
	}

	/* Back control (R4-BACKBTN) — sits directly above the card list, inside the side section. */
	.detail-back {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin: 10px 14px 0;
		padding: 5px 10px;
		font-size: 0.75rem;
		font-family: inherit;
		color: var(--color-text-secondary);
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 7px;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s, background 0.15s;
	}
	.detail-back:hover {
		color: var(--color-text-primary);
		border-color: var(--color-accent-aurum, var(--color-accent));
		background: rgba(229, 184, 76, 0.06);
	}

	/* The section's content — NOT a scroll port any more (D-034 ↻1).
	   #350 made this box scroll (`flex: 1; overflow-y: auto; min-height: 0`) and that part
	   worked: measured scrollHeight 1507 vs clientHeight 860. It fixed the wrong box. Its parent
	   claimed the whole rail height while sitting BELOW the pipeline card, so this scroller's own
	   bottom edge was already past the panel's clip line — the last stretch of every list was cut
	   off no matter how far you scrolled, and the sections after it were unreachable entirely.
	   Two nested scrollers were also the "only partially scrollable" feel: the wheel would stop
	   dead at this box's end with more rail still below.
	   There is now ONE scroller, `.nav-rail` in MindscapeView.svelte, at the level that governs
	   every section and every drill level. This box just holds content. */
	.nav-content {
		display: block;
	}

	/* Section header (realm/theme summary) */
	.section-header {
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.section-stats {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		margin: 0 0 4px;
	}
	.section-essence {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0 0 4px;
	}
	.section-chapter {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		font-style: italic;
		margin: 0;
	}
	.section-entities,
	.section-patterns {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 6px;
	}
	.detail-text-secondary {
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}
	.cross-ref-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
	}
	.cross-ref-tag {
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(229, 184, 76, 0.12);
		color: var(--color-accent-aurum);
	}
	.pattern-tag {
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(167, 139, 250, 0.12);
		color: var(--color-accent-amethyst);
	}

	/* Navigation list items */
	.nav-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px;
	}
	.nav-item {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 10px 12px;
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 11px;
		background: rgba(255, 255, 255, 0.025);
		text-align: left;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
		transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
	}
	.nav-item:hover {
		transform: translateY(-1px);
		background: rgba(229, 184, 76, 0.05);
		border-color: rgba(229, 184, 76, 0.28);
	}
	.nav-item.selected {
		background: rgba(229, 184, 76, 0.09);
		border-color: rgba(229, 184, 76, 0.4);
	}

	/* The one persistent live region — visually hidden, never display:none (that silences AT). */
	.sr-live {
		position: absolute;
		width: 1px; height: 1px;
		padding: 0; margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	/* ═══ The naming run surface (Part II, II.5) ═══
	   One card, full aside width, directly under the area list. 16px padding, 8px vertical
	   rhythm, three type levels (title 0.95rem emphasis · fact 0.8rem secondary · meta 0.72rem
	   tertiary). The bar is 6px/3px-radius in BEFORE (percent named) and DURING (run progress)
	   alike, so the swap reads as the same object changing meaning. Muted for choices, blue for
	   in-flight, red only for genuine faults. */
	.naming-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: calc(100% - 20px);
		margin: 4px 10px 10px;
		padding: 16px;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
	}
	/* 160ms opacity crossfade on state swaps (branch switch recreates the card). */
	.nc-swap { animation: nc-fade 160ms ease-out; }
	@keyframes nc-fade { from { opacity: 0; } to { opacity: 1; } }
	.nc-title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
	.nc-title { font-size: 0.95rem; font-weight: 500; color: var(--color-text-primary); }
	.nc-state { font-size: 0.72rem; color: var(--color-accent); white-space: nowrap; }
	.nc-fact { font-size: 0.8rem; color: var(--color-text-secondary); margin: 0; line-height: 1.5; }
	.nc-meta { font-size: 0.72rem; color: var(--color-text-tertiary); margin: 0; line-height: 1.4; }
	.nc-facts {
		list-style: none;
		display: flex; flex-direction: column; gap: 4px;
		margin: 0; padding: 0;
	}
	.nc-facts li { font-size: 0.8rem; color: var(--color-text-secondary); line-height: 1.5; padding-left: 12px; position: relative; }
	.nc-facts li::before { content: '·'; position: absolute; left: 2px; color: var(--color-text-tertiary); }
	.nc-bar {
		width: 100%; height: 6px; border-radius: 3px;
		background: var(--color-border);
		overflow: hidden;
	}
	/* Percent-named: accent, no gradient, no animation while idle. The bar never moves
	   backwards — totalSteps is set once up-front (as-built); DURING advances discretely per
	   feed tick (no fake easing between real datapoints). */
	.nc-bar-fill { height: 100%; border-radius: 3px; background: var(--color-accent-aurum, #e5b84c); }
	.nc-bar-fill.running { background: var(--color-accent, #5b9fe8); }
	.nc-cta {
		margin: 4px 0 0; width: 100%;
		justify-content: center;
		background: rgba(229, 184, 76, 0.09);
		border-color: rgba(229, 184, 76, 0.35);
	}
	.nc-cta:hover:not(:disabled) { background: rgba(229, 184, 76, 0.14); border-color: rgba(229, 184, 76, 0.5); }
	/* A choice is muted, never red (§8.2). */
	.nc-choice { font-size: 0.8rem; color: var(--color-text-tertiary); margin: 0; line-height: 1.5; }
	.nc-err { color: var(--color-accent-coral, #f87171); }
	.nc-link {
		background: none; border: none; padding: 0;
		font-family: inherit; font-size: inherit;
		color: var(--color-accent-aurum, #e5b84c);
		cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
	}
	.all-named-line {
		margin: 8px 14px 0;
		font-size: 0.72rem;
		color: var(--color-text-tertiary);
	}
	/* AFTER: one ~400ms background wash per freshly-renamed row (staggered via inline
	   animation-delay, max 10 rows). */
	.realm-item.renamed { animation: nc-wash 400ms ease-out backwards; }
	@keyframes nc-wash {
		from { background: rgba(229, 184, 76, 0.12); }
		to { background: rgba(255, 255, 255, 0.025); }
	}
	@media (prefers-reduced-motion: reduce) {
		.nc-swap { animation: none; }
		.realm-item.renamed { animation: none; }
	}

	/* Bottom CTA — describe the unnamed areas. Illuminate (AI connected) is a calm
	   glass card; Spawn intelligence keeps the warm gold invite. */
	.cta-note {
		margin: 0.4rem 0 0; font-size: 0.68rem; line-height: 1.4;
		color: var(--color-text-tertiary);
	}
	.cta-note.err { color: var(--color-accent-coral, #f87171); }

	.realm-cta {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		width: calc(100% - 20px);
		margin: 4px 10px 10px;
		padding: 0.7rem 0.8rem;
		border-radius: 12px;
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		color: var(--color-text-primary);
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
		transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
	}
	.realm-cta:hover:not(:disabled) { transform: translateY(-1px); }
	.realm-cta:disabled { cursor: default; opacity: 0.7; }
	.realm-cta.illuminate:hover:not(:disabled) {
		background: rgba(229, 184, 76, 0.05);
		border-color: rgba(229, 184, 76, 0.3);
	}
	.realm-cta.spawn {
		background: rgba(229, 184, 76, 0.06);
		border-color: rgba(229, 184, 76, 0.26);
	}
	.realm-cta.spawn:hover {
		background: rgba(229, 184, 76, 0.1);
		border-color: rgba(229, 184, 76, 0.45);
	}
	.cta-icon { display: flex; flex-shrink: 0; color: var(--color-accent-aurum, #e5b84c); }
	.cta-icon svg { width: 19px; height: 19px; }
	.cta-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.cta-title { font-size: 0.82rem; font-weight: 600; }
	.cta-sub { font-size: 0.68rem; color: var(--color-text-secondary); line-height: 1.4; }
	.cta-arrow { margin-left: auto; color: var(--color-accent-aurum, #e5b84c); font-size: 0.9rem; flex-shrink: 0; }
	.nav-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 5px;
		opacity: 0.7;
	}
	.nav-dot.muted {
		background: var(--color-text-tertiary);
		opacity: 0.3;
	}
	/* Undescribed realms — greyed until an AI chronicles them. */
	.realm-item.undescribed { opacity: 0.5; }
	.realm-item.undescribed:hover { opacity: 0.78; }
	.realm-item.undescribed .nav-item-name {
		color: var(--color-text-secondary);
		font-weight: 500;
	}
	.nav-item-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.nav-item-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-primary);
		line-height: 1.3;
	}
	.nav-item-stats {
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
	}
	.nav-item-essence {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* Footer */
	.nav-footer {
		padding: 8px 14px;
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		border-top: 1px solid var(--color-border);
		text-align: center;
		flex-shrink: 0;
	}

	/* Section-level extras (theme detail) */
	.section-entities {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.section-patterns {
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.pattern-item {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0 0 4px;
		padding-left: 10px;
		border-left: 2px solid rgba(229, 184, 76, 0.2);
	}

	/* ═══ Detail Panel (territory detail) ═══ */
	.detail-panel {
		display: flex;
		flex-direction: column;
	}
	.detail-header {
		padding: 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.detail-color-bar {
		width: 40px;
		height: 3px;
		border-radius: 2px;
		margin-bottom: 10px;
	}
	.detail-title-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.detail-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 6px;
		flex: 1;
	}
	.visibility-select {
		padding: 2px 6px;
		font-size: 0.65rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
		flex-shrink: 0;
		margin-top: 2px;
	}
	.visibility-select:focus {
		border-color: var(--color-accent-aurum);
		outline: none;
	}
	.badge-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 6px;
	}
	.phase-badge, .anchored-badge, .evolved-badge {
		display: inline-block;
		padding: 2px 8px;
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 1rem;
	}
	.phase-sparse { color: #94a3b8; background: rgba(148, 163, 184, 0.12); }
	.phase-active { color: #4ade80; background: rgba(74, 222, 128, 0.12); }
	.phase-anchor { color: #E5B84C; background: rgba(229, 184, 76, 0.15); }
	.anchored-badge { color: var(--color-text-secondary); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); }
	.evolved-badge { color: #c084fc; background: rgba(192, 132, 252, 0.1); cursor: help; }
	.gravity-badge {
		display: inline-block;
		padding: 2px 8px;
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 1rem;
		color: var(--color-accent-aurum, #E5B84C);
		background: rgba(229, 184, 76, 0.12);
		cursor: help;
	}
	.detail-archetype-char {
		font-size: 0.75rem;
		font-style: italic;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 6px 0 0;
	}

	.archetype-badge {
		display: inline-block;
		padding: 2px 8px;
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-accent);
		background: rgba(91, 159, 232, 0.1);
		border-radius: 1rem;
		margin-bottom: 6px;
	}
	.saliency-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.4rem 0 0.6rem;
	}
	.saliency-bar-bg {
		flex: 1;
		height: 3px;
		background: var(--color-border);
		border-radius: 2px;
		overflow: hidden;
		max-width: 120px;
	}
	.saliency-bar-fill {
		height: 100%;
		background: var(--color-accent);
		border-radius: 2px;
		transition: width 0.3s;
	}
	.saliency-label {
		font-size: 0.6rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-tertiary);
	}
	.saliency-date {
		font-size: 0.55rem;
		font-family: var(--font-mono);
		color: var(--color-text-tertiary);
		margin-left: auto;
	}
	.detail-stats {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		margin: 4px 0 0;
	}
	.detail-essence {
		font-size: 0.85rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.detail-body {
		padding: 10px 14px;
	}
	.detail-block {
		margin-bottom: 14px;
	}
	.detail-block:last-child {
		margin-bottom: 0;
	}
	.detail-block h4 {
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-tertiary);
		margin: 0 0 6px;
	}
	.chronicle-text {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
		line-height: 1.65;
		white-space: pre-wrap;
	}

	/* Activity bars now live in the shared ActivityBars.svelte (R4-ACTIVITYBARS). */
	/* Period detail below the activity chart (territory level). */
	.period-detail-wrap {
		padding: 0 14px 10px;
	}
	.period-detail {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		animation: period-fade 0.2s ease-out;
	}
	@keyframes period-fade {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.period-chronicle {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.period-theme {
		font-size: 0.7rem;
		color: var(--color-text-primary);
		font-weight: 500;
		line-height: 1.4;
	}
	.period-sig {
		font-size: 0.55rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.period-dark {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.period-dark-label {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
	}
	.period-illuminate-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		border: 1px solid rgba(229, 184, 76, 0.35);
		background: rgba(229, 184, 76, 0.06);
		color: var(--color-accent-aurum);
		border-radius: 12px;
		font-size: 0.55rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.period-illuminate-btn:hover:not(:disabled) {
		background: rgba(229, 184, 76, 0.15);
		border-color: var(--color-accent-aurum);
	}
	.period-illuminate-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.period-loading {
		display: flex;
		justify-content: center;
		padding: 4px;
	}
	.period-spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent-aurum);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	/* Entity tags */
	.entity-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.entity-tag {
		padding: 2px 6px;
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		background: var(--color-bg);
		border-radius: 4px;
	}

	/* Lists */
	.detail-list {
		margin: 0;
		padding-left: 16px;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
	}
	.detail-list li {
		margin-bottom: 3px;
	}

	/* Markdown content */
	.markdown-content {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
	}
	.markdown-content :global(p) {
		margin: 0.4em 0;
	}
	.markdown-content :global(p:first-child) {
		margin-top: 0;
	}
	.markdown-content :global(p:last-child) {
		margin-bottom: 0;
	}

	/* Social layer — contacts in territory detail */
	.contacts-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.contact-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border-radius: 6px;
		border: 1px solid var(--color-border);
		background: transparent;
		cursor: pointer;
		transition: all 0.15s;
	}
	.contact-card:hover {
		border-color: #E5B84C40;
		background: #E5B84C08;
	}
	.contact-card.selected {
		border-color: #E5B84C60;
		background: #E5B84C10;
	}
	.contact-name {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-emphasis);
	}
	.contact-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		margin-top: 2px;
	}
	.contact-tier {
		padding: 1px 5px;
		border-radius: 3px;
		background: #E5B84C18;
		color: #E5B84C;
		font-size: 0.6rem;
	}
	.contact-name-row {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.contact-source-icon {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}
	.contact-detail {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
	}
	.contact-essence {
		font-size: 0.6rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin-top: 3px;
	}
	.contact-chronicle {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
	}
	.chronicle-arc {
		font-size: 0.6rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin-bottom: 4px;
	}
	.chronicle-style {
		font-size: 0.55rem;
		color: var(--color-text-tertiary);
		font-style: italic;
		margin-bottom: 4px;
	}
	.chronicle-moments {
		margin-bottom: 4px;
	}
	.chronicle-moment {
		font-size: 0.55rem;
		color: var(--color-accent-aurum);
		padding-left: 8px;
		border-left: 2px solid var(--color-accent-aurum);
		margin-bottom: 2px;
	}
	.chronicle-topics {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 4px;
	}
	.chronicle-topic {
		font-size: 0.5rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: rgba(91, 159, 232, 0.1);
		color: var(--color-accent);
	}
	.contact-email,
	.contact-linkedin {
		display: block;
		font-size: 0.6rem;
		margin-bottom: 3px;
		text-decoration: none;
	}
	.contact-email {
		color: var(--color-accent);
	}
	.contact-email:hover,
	.contact-linkedin:hover {
		text-decoration: underline;
	}
	.contact-linkedin {
		color: #0A66C2;
	}
	.contact-messages {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
		max-height: 200px;
		overflow-y: auto;
	}
	.contact-messages-loading {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		padding: 4px 0;
	}
	.msg-spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.contact-msg {
		padding: 4px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.contact-msg:last-child {
		border-bottom: none;
	}
	.contact-msg-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
	}
	.contact-msg-role {
		font-size: 0.55rem;
		font-weight: 500;
		color: var(--color-accent-aurum);
	}
	.contact-msg-role.you {
		color: var(--color-accent);
	}
	.contact-msg-date {
		font-size: 0.5rem;
		color: var(--color-text-tertiary);
	}
	.contact-msg-text {
		font-size: 0.6rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.contact-territories {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		margin-top: 4px;
	}
	.territory-link {
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: var(--color-surface);
		color: var(--color-text-secondary);
	}
	.territory-link .strength {
		color: var(--color-text-tertiary);
		font-size: 0.55rem;
	}
	.contact-stats {
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		margin-top: 4px;
	}
	.describe-more-btn {
		margin-top: 6px; font-size: 0.72rem; padding: 0.25rem 0.7rem;
		border-radius: 999px; border: 1px solid rgba(125,182,217,0.5);
		background: rgba(125,182,217,0.12); color: #7DB6D9; cursor: pointer;
	}
	.describe-more-btn:disabled { opacity: 0.5; cursor: default; }
</style>
