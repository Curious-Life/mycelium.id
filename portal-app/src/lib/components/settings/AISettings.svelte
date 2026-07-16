<!--
	AI & Intelligence — the model that powers Mycelium's thinking (enrichment,
	narration, chat). Redesigned glassy surface: an active-model hero, then two
	clean lanes (Local · private / Cloud · your key), the connected set, and smart
	routing. Reuses the proven /portal/providers + /portal/hardware logic; only the
	presentation is new. This is the target of "Spawn intelligence" / "Connect AI".
-->
<script lang="ts">
	import OnboxTaskSelect from './OnboxTaskSelect.svelte';
	import ModelHealth from './ModelHealth.svelte';
	// §4g's exemption is SHARED state: the Intelligence screen prints the guarantee that depends
	// on it, and both are mounted in this same pane. Two independent copies = a false privacy
	// statement one scroll away (see the store's header).
	import { setSensitiveExempt, seedSensitiveExempt } from '$lib/stores/sensitive-exempt.svelte';
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Preset = { id: string; label: string; kind: 'openai' | 'anthropic'; baseUrl: string; jurisdiction: string; defaultModel: string };
	// `on_this_device` / `jurisdiction` are computed SERVER-side (publicRow in
	// src/portal-providers.js) with the one shared parser. They are not stored columns and
	// must not be re-derived from base_url here — see the JURIS/ON_DEVICE note below.
	type Provider = { id: number; provider: string; label: string | null; base_url: string | null; model_preference: string | null; is_active: number; status: string; last_used_at: string | null; on_this_device: boolean; jurisdiction: string };

	let presets = $state<Preset[]>([]);
	let providers = $state<Provider[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let chosen = $state<Preset | null>(null);
	let apiKey = $state('');
	let model = $state('');
	let customBaseUrl = $state('');
	let saving = $state(false);
	let saveErr = $state<string | null>(null);
	let testMsg = $state<Record<number, string>>({});

	// Auto-fill the model field (spec #9): once a provider + key (+ URL for a custom
	// endpoint) are entered, fetch that provider's available models and offer them
	// as a datalist. Degrades gracefully to free-text when listing isn't available.
	let cfModels = $state<string[]>([]);
	let cfModelsLoading = $state(false);
	let cfModelsErr = $state<string | null>(null);
	const MODELS_ERR: Record<string, string> = {
		auth_rejected: 'key rejected', no_key: 'enter your key first', not_found: 'no model list here',
		timeout: 'timed out', unreachable: 'unreachable', invalid_base_url: 'invalid endpoint',
		rate_limited: 'rate-limited', provider_error: 'provider error',
	};
	// A synthetic preset for an arbitrary endpoint / agent handler (spec #6) — the
	// user supplies the base URL + (optional) key themselves.
	const CUSTOM_PRESET: Preset = { id: 'custom', label: 'Custom endpoint / agent handler', kind: 'openai', baseUrl: '', jurisdiction: 'us-standard', defaultModel: '' };
	const isCustom = $derived(chosen?.id === 'custom');
	const showKey = $derived(chosen ? chosen.jurisdiction !== 'local' : false);
	const keyRequired = $derived(chosen ? (chosen.jurisdiction !== 'local' && chosen.id !== 'custom') : false);

	function customLabel(url: string): string {
		const u = url.trim();
		if (!u) return 'Custom endpoint';
		try { return `Custom · ${new URL(u).host}`; } catch { return 'Custom endpoint'; }
	}

	async function fetchModels() {
		if (!chosen) return;
		const base = chosen.baseUrl || customBaseUrl.trim();
		cfModelsLoading = true; cfModelsErr = null;
		try {
			const res = await api('/portal/providers/models', { method: 'POST', body: JSON.stringify({
				provider: chosen.kind === 'anthropic' ? 'anthropic' : 'custom',
				base_url: chosen.kind !== 'anthropic' ? base : undefined,
				api_key: apiKey.trim() || undefined,
			}) });
			const j = await res.json().catch(() => ({}));
			cfModels = Array.isArray(j.models) ? j.models : [];
			if (!j.ok) cfModelsErr = MODELS_ERR[j.error] ?? null;
			if (!model && cfModels.length) {
				model = chosen.defaultModel && cfModels.includes(chosen.defaultModel) ? chosen.defaultModel : cfModels[0];
			}
		} catch { cfModelsErr = 'could not load models'; }
		finally { cfModelsLoading = false; }
	}

	type Rec = { name: string; bestFor: string; estimatedGb: number; fitScore: number; fitLevel: string; blurb: string; installed: boolean; recommended?: boolean; recommendedFor?: string[]; ageMonths?: number | null };
	let hwRec = $state<{ hardware: any; available: number; recommendations: Rec[]; note: string | null; ollamaUp: boolean; ollamaInstalled: boolean } | null>(null);
	let hwLoading = $state(false);
	// Curate the list: by default show our recommended picks + recent models only
	// (the catalog has 300+, most stale). A search box reaches the full set.
	let modelQuery = $state('');
	const RECENCY_MONTHS = 12;
	const visibleModels = $derived.by(() => {
		const all = hwRec?.recommendations ?? [];
		const q = modelQuery.trim().toLowerCase();
		if (q) return all.filter((m: any) => m.name.toLowerCase().includes(q) || (m.bestFor || '').toLowerCase().includes(q));
		return all.filter((m: any) => m.recommended || m.ageMonths == null || m.ageMonths <= RECENCY_MONTHS);
	});
	let hwErr = $state<string | null>(null);
	let pulling = $state<Record<string, { pct: number; status: string; err?: string }>>({});

	// ── Claude subscription (opt-in) — import the user's own Claude Code login ──
	// Not a paste-a-key preset: a distinct flow that imports ~/.claude/.credentials.json
	// (POST /auth/claude/connect -> probe this device, else the browser PKCE flow via
	// /auth/claude/code; acknowledgeToS required on both) and stores the OAuth token.
	type SubAccount = { email?: string | null; displayName?: string | null; organization?: string | null; plan?: string | null };
	// health is PROBE-VERIFIED, not "a row exists" — the backend re-reads the live
	// credential stores on every call. `authenticated` is kept for back-compat but now
	// means USABLE. See src/portal-providers.js GET /auth/claude/status.
	type SubHealth = 'missing' | 'connected' | 'expired' | 'needs_reauth' | 'declined';
	let subStatus = $state<{
		authenticated: boolean; providerId: number | null; account?: SubAccount | null; model?: string | null;
		health?: SubHealth; source?: string | null; expiresAt?: number | null; scopeUnknown?: boolean; declinedSources?: string[];
	} | null>(null);

	// ── The connect LADDER (auto first, web only if needed) ──────────────────────
	// POST /auth/claude/connect probes this device; if nothing usable is found it hands
	// back a browser URL + the real reason. The user pastes the code back → /code.
	let subWebUrl = $state<string | null>(null);      // set when the ladder needs the web flow
	let subWebReason = $state<string | null>(null);   // absent | declined | wrong_scope | expired
	let subWebDetail = $state<string | null>(null);
	let subCode = $state('');

	// Human-readable, honest state — never a bare green tick.
	const SUB_UI: Record<SubHealth, { cls: string; icon: string; title: string; hint: string }> = {
		connected:    { cls: 'ok',   icon: '✓', title: 'Connected',          hint: '' },
		expired:      { cls: 'warn', icon: '↻', title: 'Session expired',    hint: 'It will renew automatically on the next request. If it keeps failing, reconnect.' },
		needs_reauth: { cls: 'err',  icon: '!', title: 'Needs reconnecting', hint: 'No usable Claude login was found on this device.' },
		declined:     { cls: 'warn', icon: '🔒', title: 'Keychain access denied', hint: "You're signed in, but macOS blocked access. Allow it, or connect in your browser instead." },
		missing:      { cls: 'err',  icon: '·', title: 'Not connected',      hint: '' },
	};
	const subHealth = $derived((subStatus?.health ?? (subStatus?.authenticated ? 'connected' : 'missing')) as SubHealth);
	// Never index SUB_UI unguarded: a NEWER backend health value (routine here — the repo
	// ships frontend-only deploys, so a stale portal against newer src/ is normal) would
	// otherwise dereference undefined and blank the whole Settings page.
	const subUi = $derived(SUB_UI[subHealth] ?? SUB_UI.missing);
	const subExpiryText = $derived.by(() => {
		const e = subStatus?.expiresAt;
		if (!e || !Number.isFinite(e)) return null;
		const mins = Math.round((e - Date.now()) / 60000);
		if (mins < 0) return 'expired';
		if (mins < 60) return `renews in ${mins} min`;
		return `renews in ${Math.round(mins / 60)} h`;
	});
	let subOpen = $state(false);          // import panel expanded
	let subAck = $state(false);           // ToS acknowledgment
	let subConnecting = $state(false);
	let subErr = $state<string | null>(null);
	let subSensitive = $state(false);     // §4g opt-in (allow the sub for persona/claim work)
	let subSensitiveBusy = $state(false);
	let webSearchOn = $state(true);       // owner web access (Anthropic-run search) — default on
	let webSearchBusy = $state(false);
	// Model choice for the subscription. Persisted as the provider row's model_preference;
	// empty falls back to the chat default (Opus 4.8). A curated CURRENT list is the
	// reliable baseline; `pullSubModels` best-effort augments it from Anthropic (the OAuth
	// token may lack models:list scope, so a failed pull just leaves the curated list).
	const CLAUDE_SUB_MODELS: { id: string; label: string }[] = [
		{ id: 'claude-opus-4-8', label: 'Opus 4.8 · most capable' },
		{ id: 'claude-sonnet-5', label: 'Sonnet 5 · balanced' },
		{ id: 'claude-fable-5', label: 'Fable 5 · creative' },
		{ id: 'claude-haiku-4-5', label: 'Haiku 4.5 · fastest' },
	];
	let subModelsPulled = $state<string[]>([]);
	let subModelsPulling = $state(false);
	const subModelOptions = $derived.by(() => {
		const seen = new Set(CLAUDE_SUB_MODELS.map((m) => m.id));
		const extra = subModelsPulled.filter((id) => !seen.has(id)).map((id) => ({ id, label: id }));
		return [...CLAUDE_SUB_MODELS, ...extra];
	});
	async function pullSubModels() {
		if (!subStatus?.providerId) return;
		subModelsPulling = true;
		try {
			const r = await api(`/portal/providers/${subStatus.providerId}/models`);
			const j = await r.json().catch(() => ({}));
			if (j?.ok && Array.isArray(j.models)) subModelsPulled = j.models.filter((m: string) => /claude/i.test(m));
		} catch { /* leave the curated list */ } finally { subModelsPulling = false; }
	}
	const subProvider = $derived(providers.find((p) => p.id === subStatus?.providerId) ?? null);
	const subModelValue = $derived(subProvider?.model_preference || 'claude-opus-4-8');
	let subModelBusy = $state(false);
	async function setSubModel(v: string) {
		if (!subStatus?.providerId || v === subModelValue) return;
		subModelBusy = true;
		try { await api(`/portal/providers/${subStatus.providerId}`, { method: 'PUT', body: JSON.stringify({ model_preference: v }) }); await load(); }
		catch { /* leave; the select reverts to the persisted value on reload */ }
		finally { subModelBusy = false; }
	}

	async function loadSub() {
		try {
			const [s, ss, ws] = await Promise.all([
				api('/portal/auth/claude/status').then((r) => r.json()).catch(() => null),
				api('/portal/providers/sensitive-subscription').then((r) => r.json()).catch(() => null),
				api('/portal/providers/web-search').then((r) => r.json()).catch(() => null),
			]);
			if (s?.ok) subStatus = {
				authenticated: !!s.authenticated, providerId: s.providerId ?? null, account: s.account ?? null, model: s.model ?? null,
				health: s.health ?? undefined, source: s.source ?? null, expiresAt: s.expiresAt ?? null,
				scopeUnknown: s.scopeUnknown === true, declinedSources: s.declinedSources ?? [],
			};
			// Publish on READ too, not just on write: the Intelligence screen renders the §4g
			// guarantee from this flag, so whichever component reads it first should tell the other.
			// SEED, not set — a load must never clobber a flip the user made mid-load. (An earlier
			// comment here claimed this delivers agreement "from the first paint"; it cannot —
			// loadSub is itself an async fetch. The screen gates its claim on `loaded` instead.)
			if (ss?.ok) { subSensitive = ss.allowed === true; seedSensitiveExempt(subSensitive); }
			if (ws?.ok) webSearchOn = ws.enabled !== false;
		} catch { /* section shows the connect state */ }
	}
	// The LADDER, step 1: try this device. The server probes every credential store; if it
	// finds a usable login we're connected with no prompt at all. If it can't, it returns
	// a browser URL + the REAL reason (absent / declined / wrong_scope / expired) — which
	// we show, instead of the old dead-end "Run `claude` and sign in first".
	async function importSub() {
		if (!subAck) return;
		subConnecting = true; subErr = null; subWebUrl = null; subWebReason = null; subWebDetail = null;
		try {
			const r = await api('/portal/auth/claude/connect', { method: 'POST', body: JSON.stringify({ acknowledgeToS: true }) });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error || 'Could not connect');
			if (j.connected) { subOpen = false; subAck = false; await loadSub(); await load(); return; }
			// Nothing usable on this device → hand the user the browser flow.
			subWebUrl = j.url || null;
			subWebReason = j.reason || null;
			subWebDetail = j.detail || null;
			if (!subWebUrl) throw new Error(j.detail || 'Could not start the browser sign-in');
		} catch (e: any) { subErr = e?.message || 'Could not connect'; }
		finally { subConnecting = false; }
	}

	// The LADDER, step 2: finish in the browser and paste the code back. Works on a
	// machine with no `claude` CLI at all — the case that previously could not connect.
	async function finishSubWeb() {
		if (!subCode.trim()) return;
		subConnecting = true; subErr = null;
		try {
			const r = await api('/portal/auth/claude/code', { method: 'POST', body: JSON.stringify({ acknowledgeToS: true, code: subCode.trim() }) });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error || 'Could not complete the connection');
			subOpen = false; subAck = false; subWebUrl = null; subCode = '';
			await loadSub(); await load();
		} catch (e: any) {
			// The server consumes the pending PKCE flow BEFORE exchanging, so ANY failure here
			// has already burned the verifier — a retry against the same link would always
			// 400 ("No pending connection"). Drop back to step 1 so Connect mints a fresh flow
			// instead of leaving a dead link + Finish button on screen.
			subErr = e?.message || 'Could not complete the connection';
			subWebUrl = null; subCode = '';
		}
		finally { subConnecting = false; }
	}
	async function disconnectSub() {
		subConnecting = true; subErr = null;
		try {
			// api() returns the Response regardless of status — check .ok so a failed
			// disconnect surfaces an error instead of silently "doing nothing".
			const r = await api('/portal/auth/claude/disconnect', { method: 'POST', body: '{}' });
			if (!r.ok) throw new Error('Disconnect failed');
			await loadSub(); await load();
		}
		catch (e: any) { subErr = e?.message || 'Failed to disconnect'; }
		finally { subConnecting = false; }
	}
	async function setSubSensitive(v: boolean) {
		subSensitiveBusy = true;
		try {
			const r = await api('/portal/providers/sensitive-subscription', { method: 'PUT', body: JSON.stringify({ allowed: v }) });
			if (r.ok) {
				subSensitive = (await r.json()).allowed === true;
				// PUBLISH IT. The Intelligence screen above renders the §4g guarantee from this
				// flag; without this it keeps printing "…stay in the EU or on your device" after
				// you flip the exemption ON, while the router already sends narrate to us-standard.
				setSensitiveExempt(subSensitive);
			}
		}
		catch { /* leave */ } finally { subSensitiveBusy = false; }
	}
	async function setWebSearch(v: boolean) {
		webSearchBusy = true;
		try { const r = await api('/portal/providers/web-search', { method: 'PUT', body: JSON.stringify({ enabled: v }) }); if (r.ok) webSearchOn = (await r.json()).enabled !== false; }
		catch { /* leave */ } finally { webSearchBusy = false; }
	}

	// Assistant identity (spec #4) — name + personality, changeable here and set in
	// onboarding. The name propagates to the chat header via /portal/chat/agents.
	let agentName = $state('');
	let agentPersonality = $state('friendly');
	let identityBusy = $state(false);
	let identitySaved = $state(false);
	const PERSONALITY_OPTS: { id: string; label: string }[] = [
		{ id: 'friendly', label: 'Friendly' },
		{ id: 'formal', label: 'Formal' },
		{ id: 'concise', label: 'Concise' },
		{ id: 'creative', label: 'Creative' },
	];
	async function loadIdentity() {
		try { const r = await api('/portal/agent-identity'); if (r.ok) { const j = await r.json(); agentName = j.name || ''; agentPersonality = j.personality || 'friendly'; } } catch { /* defaults */ }
	}
	async function saveIdentity() {
		identityBusy = true; identitySaved = false;
		try {
			const r = await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify({ name: agentName.trim(), personality: agentPersonality }) });
			if (r.ok) { const j = await r.json(); agentName = j.name; agentPersonality = j.personality; identitySaved = true; setTimeout(() => (identitySaved = false), 2000); }
		} catch { /* leave */ } finally { identityBusy = false; }
	}

	// Per-task model selection — ONE area, every task. Each task is either ON-BOX
	// (a local model NAME, runs on your device — categorize/enrich) or PROVIDER-routed
	// (a configured provider — chat/narrate/harness/reflection). `onboxTasks` comes from
	// the backend (ONBOX_TASKS) so the split is authoritative, not hardcoded here.
	let tasks = $state<string[]>([]);
	let onboxTasks = $state<string[]>([]);
	let taskModels = $state<Record<string, { providerId?: number; model?: string }>>({});
	let taskBusy = $state<string | null>(null);
	const TASK_LABELS: Record<string, string> = {
		chat: 'Chat & agents',
		narrate: 'Narration — mindscape names + chronicles',
		harness: 'Autonomous tasks — scheduled & background',
		reflection: 'Reflection cycles — your daily/weekly inner model',
		categorize: 'Labeling — per-message domains + registers',
		enrich: 'Enrichment — entities + gist per message',
	};
	// ── On-box model health (readiness `models` — src/readiness.js §3.10b) ──────────
	// The slice was COMPLETE and SERVED but had zero consumers here (design §3.10 line 571),
	// so approving Labeling and leaving Enrichment unset ran L2 dead AND silent. This is the
	// render. The health belongs next to the picker that CAUSES it — approving a model is
	// what starts the download this reports on.
	//
	// ⚠️ `slices=models` — ask for exactly what this screen renders, and NEVER `fresh`.
	// The pure scan is a multi-second SQLCipher decrypt; polling it per-call once hung the
	// app at boot. `models` itself is SYNC (it reads supervisors' in-memory health, never
	// the DB), so this stays cheap enough to poll while a pull is in flight.
	let models = $state<Record<string, any> | null>(null);
	let modelsPoll: ReturnType<typeof setInterval> | null = null;
	// The Intelligence pane is destroyed on a pane switch (SettingsView's {#if activePane}), and
	// a fetch in flight at that moment resolves AFTER the cleanup has run — it would then see
	// `busy && !modelsPoll` and start a fresh interval with no owner left to clear it. Harmless
	// while a pull finishes, but a member stuck busy (crash-looping, stalled) would poll every
	// 2s for the life of the page, once more per visit (independent review, 2026-07-16).
	let modelsDead = false;

	// The readiness member behind each on-box TASK. `categorize` (the setting) and `labeler`
	// (the health) are the same function under two names; `enrich`/`enricher` likewise. They
	// are approved INDEPENDENTLY — one member per task, never a shared object.
	const TASK_MEMBER: Record<string, string> = { categorize: 'labeler', enrich: 'enricher' };
	const healthOf = (task: string) => models?.[TASK_MEMBER[task]] ?? null;

	async function loadModels() {
		try {
			const r = await api('/portal/readiness?slices=models');
			if (r.ok) { models = (await r.json())?.models ?? null; maybePollModels(); }
		} catch { /* health simply doesn't render — never blocks the pickers */ }
	}
	// Poll ONLY while something is genuinely in flight. A model pull is multi-GB, so the
	// percentage has to move; once it settles there is nothing to watch and polling stops.
	function maybePollModels() {
		if (modelsDead) return;                 // a late fetch must not outlive the component
		const busy = Object.values(models || {}).some((m: any) =>
			['downloading', 'loading', 'starting', 'installing_deps'].includes(String(m?.status)));
		if (busy && !modelsPoll) modelsPoll = setInterval(loadModels, 2000);
		if (!busy && modelsPoll) { clearInterval(modelsPoll); modelsPoll = null; }
	}

	// Role-aware recommendations (curated operator picks, from /providers/presets).
	// labeling → a small on-box model (categorize/enrich); descriptions → an EU-ZDR cloud (narrate).
	let roleRecs = $state<{ labeling?: { model?: string }; descriptions?: { presetId?: string } } | null>(null);
	const isOnbox = (t: string) => onboxTasks.includes(t);
	const cloudTaskList = $derived(tasks.filter((t) => !isOnbox(t)));   // provider-routed
	const onboxTaskList = $derived(tasks.filter((t) => isOnbox(t)));     // on your device
	const onboxRecModel = $derived(roleRecs?.labeling?.model || 'qwen3.5:4b'); // recommended on-box pick
	// Installed local models to choose from (only known once hardware is detected).
	const installedLocal = $derived((hwRec?.recommendations ?? []).filter((m: any) => m.installed).map((m: any) => m.name));
	const onboxModelOf = (task: string) => taskModels[task]?.model || '';
	// Options for an on-box task's <select>: installed locals + the current pick, minus the
	// recommended — which is NOT dropped because it is "the default", but because it has its
	// own explicit <option value={onboxRecModel}> above and would otherwise render twice.
	// It must stay selectable: it is the model the whole recommendation exists to offer.
	function onboxOptions(task: string): string[] {
		const set = new Set<string>(installedLocal);
		const cur = onboxModelOf(task);
		if (cur) set.add(cur);
		set.delete(onboxRecModel);
		return [...set];
	}

	const FIT: Record<string, { label: string; cls: string }> = {
		perfect: { label: 'great fit', cls: 'fit-green' },
		good: { label: 'good fit', cls: 'fit-blue' },
		marginal: { label: 'tight', cls: 'fit-amber' },
		too_tight: { label: "won't fit", cls: 'fit-red' },
	};
	// Jurisdiction chip for a CONFIGURED row. `local` here means the shared parser's
	// jurisdiction 'local' WITHOUT loopback — i.e. a `.local` LAN host: the data left this
	// machine, so it cannot claim "on your device". The green on-device chip is ON_DEVICE
	// below, gated on the server's `on_this_device`, never on this map.
	const JURIS: Record<string, { label: string; cls: string }> = {
		'eu-zdr': { label: 'EU · zero-retention', cls: 'j-green' },
		'us-standard': { label: 'US · Cloud-Act', cls: 'j-amber' },
		'us-zdr': { label: 'US · zero-retention', cls: 'j-amber' },
		local: { label: 'on your local network', cls: 'j-amber' },
	};
	const ON_DEVICE = { label: 'on your device', cls: 'j-green' };

	const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';
	// Display name for a provider row. For Claude, the AUTH TYPE is the identity, so show
	// "Claude subscription" (oauth) / "Claude API" (key) rather than any stale stored label
	// (e.g. an old build wrote "Claude 3"). Non-Claude providers keep their own label.
	const providerLabel = (p: any) => {
		const prov = String(p?.provider || '').toLowerCase();
		if (prov === 'anthropic' || prov === 'claude') return String(p?.auth_type || '').toLowerCase() === 'oauth' ? 'Claude subscription' : 'Claude API';
		return p?.label || p?.provider;
	};

	// Cloud presets only here (local lane is the hardware recommender below).
	const cloudGroups = $derived([
		{ key: 'eu-zdr', title: 'EU-sovereign · recommended', items: presets.filter((p) => p.jurisdiction === 'eu-zdr') },
		{ key: 'us', title: 'US providers', items: presets.filter((p) => p.jurisdiction.startsWith('us')) },
	]);

	// ── Active model (hero) ──
	// The RESOLVED active provider — mirror the backend getActive(): among the
	// is_active rows (there's one per provider TYPE), the most-recently-used wins.
	// (find(is_active) was wrong — it returned whichever sorted first, e.g. Claude
	// before Regolo, so the UI showed a provider the system wasn't actually using.)
	const active = $derived(
		[...providers].filter((p) => p.is_active)
			.sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''))[0] ?? null,
	);
	// Both facts come from the SERVER (publicRow), computed with the one shared parser.
	// Do not re-derive either from base_url here — a substring regex over the URL string
	// is what made this badge lie in the first place.
	const activeInfo = $derived.by(() => {
		if (!active) return null;
		return {
			label: active.label || active.provider,
			model: active.model_preference || '',
			local: !!active.on_this_device,
			juris: active.jurisdiction ?? '',
		};
	});

	async function load() {
		loading = true; error = null;
		try {
			const [pr, cu] = await Promise.all([
				api('/portal/providers/presets').then((r) => r.json()),
				api('/portal/providers').then((r) => r.json()),
			]);
			presets = pr.presets || [];
			roleRecs = pr.roleRecommendations || null;
			providers = cu.providers || [];
		} catch (e: any) {
			error = e?.message || 'Failed to load providers';
		} finally {
			loading = false;
		}
	}
	async function loadTaskModels() {
		try { const r = await api('/portal/providers/task-models'); if (r.ok) { const j = await r.json(); tasks = j.tasks || []; onboxTasks = j.onboxTasks || ['categorize', 'enrich']; taskModels = j.taskModels || {}; } } catch { /* default: all tasks use the active provider */ }
	}
	async function setTaskModel(task: string, providerId: number | null) {
		taskBusy = task;
		try { const r = await api('/portal/providers/task-models', { method: 'PUT', body: JSON.stringify({ task, providerId }) }); if (r.ok) taskModels = (await r.json()).taskModels || {}; }
		catch { /* leave */ } finally { taskBusy = null; }
	}
	// On-box task (categorize/enrich): stores a LOCAL model NAME. Empty → NOT APPROVED:
	// nothing downloads and nothing runs for that task (§3.10c — the approval IS the setting).
	// It said "Empty → curated default" until 2026-07-16, which is the exact claim this round
	// killed; the identical sentence was fixed in portal-providers.js in the same diff and
	// missed here, 80 lines from the edit (re-review). Check for siblings, not just the file
	// you are in.
	async function setOnboxModel(task: string, model: string) {
		taskBusy = task;
		try { const r = await api('/portal/providers/task-models', { method: 'PUT', body: JSON.stringify({ task, model }) }); if (r.ok) taskModels = (await r.json()).taskModels || {}; }
		catch { /* leave */ } finally { taskBusy = null; }
		// The approval is what STARTS the pull, so re-read the health the click just changed —
		// otherwise approving a ~3.4GB model leaves the row reading "Off" until the next
		// visit, and the one download worth watching is the one nobody sees begin.
		loadModels();
	}
	// ── Voice transcription (dedicated Whisper — fast on-device STT) ──
	type WhisperCat = { model: string; label: string; sizeMB: number; blurb: string; recommended?: boolean };
	let trans = $state<{ health: any; model: string | null; catalog: WhisperCat[] } | null>(null);
	let transErr = $state<string | null>(null);
	let transBusy = $state(false);
	let transStarting = $state<string | null>(null); // model whose download we just kicked off (instant feedback)
	let transPoll: ReturnType<typeof setInterval> | null = null;

	async function loadTranscription() {
		try {
			const r = await api('/portal/transcription/status');
			if (r.ok) { trans = await r.json(); maybePollTranscription(); }
		} catch { /* section shows unavailable */ }
	}
	function maybePollTranscription() {
		const st = trans?.health?.status;
		const busy = st === 'downloading' || st === 'loading' || st === 'starting' || st === 'installing_deps';
		if (busy && !transPoll) transPoll = setInterval(loadTranscription, 2000);
		if (!busy && transPoll) { clearInterval(transPoll); transPoll = null; }
	}
	async function downloadWhisper(m: string) {
		if (transBusy) return; // ignore repeat clicks while one is in flight
		transBusy = true; transErr = null; transStarting = m;
		// Optimistic feedback + start polling IMMEDIATELY — the POST can take up to
		// ~20s (it waits for the service to come up), so don't leave the user staring
		// at an unchanged screen wondering if the click registered.
		if (!transPoll) transPoll = setInterval(loadTranscription, 2000);
		try {
			const r = await api('/portal/transcription/download', { method: 'POST', body: JSON.stringify({ model: m }) });
			const j = await r.json().catch(() => null);
			if (!r.ok || !j?.ok) throw new Error(j?.error || 'download failed');
			await loadTranscription();
		} catch (e: any) { transErr = e?.message || 'download failed'; }
		finally { transBusy = false; transStarting = null; }
	}

	onMount(() => {
		load(); loadTaskModels(); loadTranscription(); loadIdentity(); loadSub(); loadModels();
		return () => {
			if (transPoll) clearInterval(transPoll);
			modelsDead = true;
			if (modelsPoll) { clearInterval(modelsPoll); modelsPoll = null; }
		};
	});

	function choose(p: Preset) {
		chosen = p; apiKey = ''; model = p.defaultModel || ''; saveErr = null;
		customBaseUrl = ''; cfModels = []; cfModelsErr = null;
		// A keyless, known-endpoint provider (e.g. a local server) can list models
		// immediately; keyed/custom providers list after the user fills the form.
		if (!keyRequired && !isCustom) fetchModels();
	}

	async function connect(e: Event) {
		e.preventDefault();
		if (!chosen) return;
		saving = true; saveErr = null;
		const body: Record<string, unknown> = {
			provider: chosen.kind === 'anthropic' ? 'anthropic' : 'custom',
			label: isCustom ? customLabel(customBaseUrl) : chosen.label,
			model_preference: model.trim() || chosen.defaultModel || undefined,
		};
		if (chosen.kind !== 'anthropic') body.base_url = chosen.baseUrl || customBaseUrl.trim();
		if (apiKey.trim()) body.api_key = apiKey.trim();
		try {
			const res = await api('/portal/providers', { method: 'POST', body: JSON.stringify(body) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to connect');
			chosen = null; apiKey = ''; model = '';
			await load();
		} catch (e: any) {
			saveErr = e?.message || 'Failed to connect';
		} finally {
			saving = false;
		}
	}
	async function setActive(id: number) { await api(`/portal/providers/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) }); await load(); }
	// Removing a provider only deletes the CONNECTION (the ai_providers row). For a LOCAL
	// Ollama provider we additionally offer "delete from disk" (frees space) — a confirmed,
	// destructive Ollama HTTP delete. Non-local providers just remove the connection.
	let confirmRemoveId = $state<number | null>(null);
	let removeBusy = $state(false);
	// Server-computed loopback (publicRow.on_this_device) — the disk-delete is only ever
	// offered for a model on THIS machine. (/portal/hardware/delete independently refuses a
	// name that isn't actually installed on the local daemon, so this is the outer of two.)
	const isLocalProvider = (p: any) => !!p.on_this_device && !!p.model_preference;
	function onRemoveClick(p: any) {
		if (isLocalProvider(p)) confirmRemoveId = p.id;   // ask: connection-only vs also-disk
		else removeConnection(p.id);
	}
	async function removeConnection(id: number) {
		removeBusy = true;
		try { await api(`/portal/providers/${id}`, { method: 'DELETE' }); confirmRemoveId = null; await load(); }
		catch { /* leave */ } finally { removeBusy = false; }
	}
	async function removeAndDeleteDisk(p: any) {
		removeBusy = true;
		try {
			await api('/portal/hardware/delete', { method: 'POST', body: JSON.stringify({ name: p.model_preference }) });
			await api(`/portal/providers/${p.id}`, { method: 'DELETE' });
			confirmRemoveId = null; await load(); await loadRecommend();
		} catch { /* leave */ } finally { removeBusy = false; }
	}
	async function test(id: number) {
		testMsg = { ...testMsg, [id]: '…' };
		try {
			const res = await api(`/portal/providers/${id}/test`, { method: 'POST', body: '{}' });
			const data = await res.json().catch(() => ({}));
			testMsg = { ...testMsg, [id]: data?.result?.ok ? '✓ reachable' : `✗ ${data?.result?.error || 'failed'}` };
		} catch { testMsg = { ...testMsg, [id]: '✗ failed' }; }
		await load();
	}

	async function loadRecommend() {
		hwLoading = true; hwErr = null;
		try {
			const data = await api('/portal/hardware/recommend').then((r) => r.json());
			if (!data.ok) throw new Error(data.error || 'detection failed');
			hwRec = data;
		} catch (e: any) { hwErr = e?.message || 'Hardware detection failed'; }
		finally { hwLoading = false; }
	}
	const PULL_ERR: Record<string, string> = {
		not_installed: 'Ollama isn’t installed', checksum_mismatch: 'download failed verification',
		download_failed: 'download failed — check your connection', unsupported_platform: 'auto-install unavailable on this OS',
		start_timeout: "Ollama didn’t start — try again", spawn_failed: "couldn’t start Ollama", ollama_unavailable: 'Ollama unavailable',
	};
	async function pullAndUse(m: Rec) {
		pulling = { ...pulling, [m.name]: { pct: m.installed ? 100 : 0, status: m.installed ? 'installed' : 'starting…' } };
		try {
			if (!m.installed) {
				const res = await api('/portal/hardware/pull', { method: 'POST', body: JSON.stringify({ name: m.name }) });
				if (!res.body) throw new Error('no progress stream');
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let buf = '', ok = false;
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let nl: number;
					while ((nl = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
						if (!line.startsWith('data: ')) continue;
						const payload = line.slice(6);
						if (payload === '[DONE]') continue;
						let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
						if (ev.done) { ok = !!ev.ok; if (!ev.ok) throw new Error(PULL_ERR[ev.error] || ev.error || 'pull failed'); }
						else if (ev.total) { pulling = { ...pulling, [m.name]: { pct: Math.min(100, Math.round((ev.completed / ev.total) * 100)), status: ev.status || 'downloading…' } }; }
						else if (ev.status) { pulling = { ...pulling, [m.name]: { pct: pulling[m.name]?.pct ?? 0, status: ev.status } }; }
					}
				}
				if (!ok) throw new Error('pull did not complete');
			}
			const existing = providers.find((p) => p.base_url === OLLAMA_BASE && p.model_preference === m.name);
			if (existing) { await setActive(existing.id); }
			else {
				const cr = await api('/portal/providers', { method: 'POST', body: JSON.stringify({ provider: 'custom', label: `Local · ${m.name}`, base_url: OLLAMA_BASE, model_preference: m.name }) });
				const cd = await cr.json().catch(() => ({}));
				if (cr.ok && cd.id) await setActive(cd.id);
			}
			pulling = { ...pulling, [m.name]: { pct: 100, status: 'ready' } };
			await load(); await loadRecommend();
		} catch (e: any) {
			pulling = { ...pulling, [m.name]: { pct: 0, status: 'failed', err: e?.message || 'failed' } };
		}
	}
</script>

<div class="ai-page">
	<!-- ── Active intelligence (hero) ── -->
	<div class="hero" class:none={!active}>
		<span class="hero-spark" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
		</span>
		<div class="hero-body">
			{#if activeInfo}
				<span class="hero-label">Using {activeInfo.label}{#if activeInfo.model && !activeInfo.label.includes(activeInfo.model)} · <span class="hero-model">{activeInfo.model}</span>{/if}</span>
				{#if activeInfo.local}<span class="chip {ON_DEVICE.cls}">{ON_DEVICE.label}</span>
				{:else if JURIS[activeInfo.juris]}<span class="chip {JURIS[activeInfo.juris].cls}">{JURIS[activeInfo.juris].label}</span>{/if}
				{#if active?.id === subStatus?.providerId && subStatus?.account?.email}<span class="hero-sub">{subStatus.account.email}</span>{/if}
			{:else}
				<span class="hero-label">No intelligence connected yet</span>
				<span class="hero-sub">Connect one below — local &amp; private, or a cloud key.</span>
			{/if}
		</div>
	</div>

	<!-- ── Assistant identity (name + personality) ── -->
	<div class="lane">
		<div class="lane-head"><span class="lane-title">Your assistant</span><span class="lane-tag">name &amp; personality</span></div>
		<div class="identity-row">
			<input class="inp id-name" type="text" maxlength="40" bind:value={agentName} placeholder="Mycelium" aria-label="Assistant name" />
			<select class="task-select id-persona" bind:value={agentPersonality} aria-label="Personality">
				{#each PERSONALITY_OPTS as o}<option value={o.id}>{o.label}</option>{/each}
			</select>
			<button class="solid-btn" disabled={identityBusy} onclick={saveIdentity}>{identityBusy ? 'Saving…' : identitySaved ? '✓ Saved' : 'Save'}</button>
		</div>
		<p class="muted-xs">This name appears wherever your AI shows up — chat, notifications, settings.</p>
	</div>

	{#if loading}
		<div class="muted pulse">Loading…</div>
	{:else if error}
		<div class="err-box">{error}</div>
	{:else}
		<!-- ── Connect ── -->
		<div class="lane">
			<div class="lane-head"><span class="lane-title">Local</span><span class="lane-tag j-green">private · on your device</span></div>
			{#if !hwRec && !hwLoading}
				<button class="ghost-btn" onclick={loadRecommend}>✨ Recommend a model for my hardware</button>
			{:else if hwLoading}
				<div class="muted pulse">Detecting hardware…</div>
			{:else if hwErr}
				<div class="err-box">{hwErr}</div>
			{:else if hwRec}
				<p class="muted-xs">
					{hwRec.hardware.hasGpu ? `${hwRec.hardware.gpuName} · ${hwRec.hardware.gpuVramGb}GB` : `${hwRec.hardware.cpuCores}-core CPU`} · {hwRec.hardware.totalRamGb}GB RAM
					{#if !hwRec.ollamaInstalled}· Ollama auto-installs on first pick{/if}
				</p>
				{#if hwRec.note}<p class="note-amber">{hwRec.note}</p>{/if}
				<input class="model-search" type="text" bind:value={modelQuery} placeholder="Search all models…" autocomplete="off" />
				<div class="rec-list">
					{#each visibleModels as m (m.name)}
						<div class="row" class:dim={m.fitScore === 0} class:rec-top={m.recommended}>
							<span class="mono">{m.name}</span>
							{#if m.recommended}<span class="chip rec-pick">★ recommended</span>{/if}
							{#if m.recommendedFor?.includes('labeling')}<span class="chip rec-role" title="Recommended for the on-box labeling model (Context Engine L1)">★ for labeling</span>{/if}
							<span class="chip {FIT[m.fitLevel]?.cls ?? ''}">{FIT[m.fitLevel]?.label ?? m.fitLevel}</span>
							<span class="row-blurb">{m.bestFor} · ~{m.estimatedGb}GB</span>
							<span class="row-action">
								{#if pulling[m.name]}
									{#if pulling[m.name].err}<span class="x-red">{pulling[m.name].err}</span>
									{:else if pulling[m.name].status === 'ready'}<span class="x-green">✓ ready</span>
									{:else}<span class="muted-xs">{pulling[m.name].status}{pulling[m.name].pct ? ` ${pulling[m.name].pct}%` : ''}</span>{/if}
								{:else}
									<button class="link-btn" onclick={() => pullAndUse(m)}>{m.installed ? 'Use' : 'Pull & use'}</button>
								{/if}
							</span>
						</div>
					{:else}
						<p class="muted-xs">No models match “{modelQuery}”.</p>
					{/each}
				</div>
			{/if}
		</div>

		<div class="lane">
			<div class="lane-head"><span class="lane-title">Cloud</span><span class="lane-tag">your key · encrypted in your vault</span></div>
			{#if chosen}
				<form onsubmit={connect} class="connect-form">
					<div class="cf-head"><span class="cf-name">{chosen.label}</span>{#if JURIS[chosen.jurisdiction]}<span class="chip {JURIS[chosen.jurisdiction].cls}">{JURIS[chosen.jurisdiction].label}</span>{/if}</div>
					{#if isCustom}<input type="url" bind:value={customBaseUrl} placeholder="https://endpoint.example/v1 — base URL or agent handler" autocomplete="off" class="inp" />{/if}
					{#if showKey}<input type="password" bind:value={apiKey} placeholder={keyRequired ? 'API key' : 'API key (optional)'} autocomplete="off" class="inp" />{/if}
					<div class="model-field">
						<input type="text" list="cf-models" bind:value={model} placeholder={chosen.defaultModel || 'model'} class="inp" />
						<button type="button" class="link-btn load-models" onclick={fetchModels} disabled={cfModelsLoading || (isCustom && !customBaseUrl.trim())}>
							{cfModelsLoading ? 'Loading…' : cfModels.length ? `↻ ${cfModels.length}` : 'Load models'}
						</button>
					</div>
					<datalist id="cf-models">{#each cfModels as m}<option value={m}></option>{/each}</datalist>
					{#if cfModelsErr}<div class="muted-xs">Couldn’t list models ({cfModelsErr}) — type the model id.</div>{/if}
					<div class="cf-actions">
						<button type="submit" disabled={saving || (keyRequired && !apiKey.trim()) || (isCustom && !customBaseUrl.trim())} class="solid-btn">{saving ? 'Connecting…' : 'Connect'}</button>
						<button type="button" class="link-btn dim-link" onclick={() => (chosen = null)}>Cancel</button>
					</div>
					{#if saveErr}<div class="x-red">{saveErr}</div>{/if}
				</form>
			{:else if subOpen}
				<div class="connect-form">
					<div class="cf-head"><span class="cf-name">Connect your Claude subscription</span><span class="chip j-amber">US · opt-in</span></div>
					{#if !subWebUrl}
						<!-- Ladder step 1: try THIS device. The server probes every credential store. -->
						<p class="muted-xs">Uses the Claude login already on this device if there is one — otherwise you'll sign in through your browser. No API key either way. Automating a Pro/Max subscription may be against Anthropic's terms; you accept that risk.</p>
						<label class="ack"><input type="checkbox" bind:checked={subAck} /> <span>I understand and accept the terms risk</span></label>
						{#if subErr}<div class="x-red">{subErr}</div>{/if}
						<div class="cf-actions">
							<button type="button" class="solid-btn" disabled={!subAck || subConnecting} onclick={importSub}>{subConnecting ? 'Connecting…' : 'Connect'}</button>
							<button type="button" class="link-btn dim-link" onclick={() => { subOpen = false; subErr = null; }}>Cancel</button>
						</div>
					{:else}
						<!-- Ladder step 2: nothing usable here → the BROWSER flow. This is what lets a
						     machine with no `claude` CLI connect at all — previously impossible. The
						     reason is the REAL one from the probe, not a generic "sign in first". -->
						<p class="muted-xs">
							{#if subWebReason === 'declined'}macOS blocked access to your saved Claude login — you're signed in, but we can't read it. Sign in through your browser instead:
							{:else if subWebReason === 'wrong_scope'}The login on this device is an admin setup-token, not a subscription sign-in. Sign in through your browser:
							{:else if subWebReason === 'expired'}Your Claude session couldn't be renewed. Sign in again:
							{:else}No Claude login found on this device. Sign in through your browser:
							{/if}
						</p>
						{#if subWebDetail}<p class="muted-xs sub-diag">{subWebDetail}</p>{/if}
						<div class="cf-actions">
							<a class="solid-btn" href={subWebUrl} target="_blank" rel="noreferrer noopener">Open Claude sign-in ↗</a>
						</div>
						<p class="muted-xs">Approve it, then paste the code Claude gives you:</p>
						<input class="input" placeholder="Paste the code from Claude" bind:value={subCode} autocomplete="off" spellcheck="false"
							onkeydown={(e) => { if (e.key === 'Enter' && subCode.trim()) finishSubWeb(); }} />
						{#if subErr}<div class="x-red">{subErr}</div>{/if}
						<div class="cf-actions">
							<button type="button" class="solid-btn" disabled={!subCode.trim() || subConnecting} onclick={finishSubWeb}>{subConnecting ? 'Connecting…' : 'Finish connecting'}</button>
							<button type="button" class="link-btn dim-link" onclick={() => { subOpen = false; subWebUrl = null; subCode = ''; subErr = null; }}>Cancel</button>
						</div>
					{/if}
				</div>
			{:else}
				{#each cloudGroups as g (g.key)}
					{#if g.items.length}
						<div class="preset-group">
							<div class="group-title">{g.title}</div>
							<div class="chips-row">
								{#each g.items as p (p.id)}<button class="preset-chip" class:rec-desc={roleRecs?.descriptions?.presetId === p.id} title={roleRecs?.descriptions?.presetId === p.id ? 'Recommended for descriptions — mindscape narration (the narrate task), on modest hardware' : undefined} onclick={() => choose(p)}>{#if roleRecs?.descriptions?.presetId === p.id}★ {/if}{p.label}</button>{/each}
							</div>
						</div>
					{/if}
				{/each}
				<div class="preset-group sub-group">
					<div class="group-title">Your Claude subscription</div>
					{#if subStatus?.authenticated || subHealth === 'declined' || subHealth === 'needs_reauth'}
						<!-- Probe-verified state — NOT "a row exists". The old card showed a green
						     tick for a token revoked months ago; this reports what is actually true. -->
						<div class="sub-row">
							<span class="sub-ok" class:sub-warn={subUi.cls === 'warn'} class:sub-err={subUi.cls === 'err'}>
								{subUi.icon}
								{#if subHealth === 'connected'}{subStatus?.account?.email ? `Connected as ${subStatus.account.email}` : 'Using your Claude Pro/Max plan'}
								{:else}{subUi.title}{/if}
							</span>
							{#if subHealth === 'needs_reauth' || subHealth === 'declined'}
								<button class="link-btn" disabled={subConnecting} onclick={() => { subOpen = true; subErr = null; }}>Reconnect</button>
							{/if}
							<button class="link-btn x-red-link" disabled={subConnecting} onclick={disconnectSub}>Disconnect</button>
						</div>
						{#if subUi.hint}<div class="sub-meta">{subUi.hint}</div>{/if}
						{#if subStatus?.account?.plan || subStatus?.account?.organization}
							<div class="sub-meta">{[subStatus?.account?.plan, subStatus?.account?.organization].filter(Boolean).join(' · ')}</div>
						{/if}
						<!-- Non-secret diagnostics: which store the credential came from, and when it
						     renews. Previously the card could not tell you either. -->
						{#if subHealth === 'connected' || subHealth === 'expired'}
							<div class="sub-meta sub-diag">
								{#if subExpiryText}{subExpiryText}{/if}
								{#if subStatus?.source}{subExpiryText ? ' · ' : ''}from {subStatus.source.replace(/-/g, ' ')}{/if}
								{#if subStatus?.scopeUnknown} · scope unverified (env token){/if}
							</div>
						{/if}
						<!-- Model + sensitive-work controls only make sense for a USABLE subscription.
						     Showing them while it needs reconnecting implies it's working. -->
						{#if subStatus?.authenticated}
							<div class="sub-model-row">
								<span class="sub-model-label">Model</span>
								<div class="sub-model-ctl">
									<select class="task-select" disabled={subModelBusy} value={subModelValue} onchange={(e) => setSubModel((e.currentTarget as HTMLSelectElement).value)}>
										{#each subModelOptions as m}
											<option value={m.id}>{m.label}</option>
										{/each}
									</select>
									<button class="link-btn dim-link" disabled={subModelsPulling} onclick={pullSubModels} title="Fetch the models your account can use">{subModelsPulling ? '…' : 'Refresh'}</button>
								</div>
							</div>
							<button class="sub-toggle" role="switch" aria-checked={subSensitive} disabled={subSensitiveBusy} onclick={() => setSubSensitive(!subSensitive)}>
								<span class="toggle sm" class:on={subSensitive}><span class="knob"></span></span>
								<span class="sub-toggle-body"><span class="sub-toggle-title">Also use it for sensitive work</span><span class="sub-toggle-sub">Let your subscription process persona, claim &amp; description analysis — otherwise kept on-device/EU. Off by default.</span></span>
							</button>
						{/if}
					{:else}
						<p class="muted-xs">Use your existing Claude login instead of an API key — no key to paste.</p>
						<button class="preset-chip sub-chip" onclick={() => { subOpen = true; subErr = null; }}>✦ Connect with your Claude login</button>
					{/if}
					{#if subErr && !subOpen}<div class="x-red">{subErr}</div>{/if}
				</div>
				<div class="preset-group">
					<div class="group-title">Other</div>
					<div class="chips-row">
						<button class="preset-chip" onclick={() => choose(CUSTOM_PRESET)}>+ Custom endpoint / agent handler</button>
					</div>
				</div>
			{/if}
		</div>

		<!-- ── Connected ── -->
		{#if providers.length}
			<div class="lane">
				<div class="lane-head"><span class="lane-title">Connected</span></div>
				{#each providers as p (p.id)}
					<div class="row">
						<span class="dot" class:on={p.id === active?.id}></span>
						<span class="conn-name">{providerLabel(p)}</span>
						{#if p.id === active?.id}<span class="chip j-green">active</span>{/if}
						<span class="row-action">
							{#if confirmRemoveId === p.id}
								<span class="muted-xs">Delete <strong>{p.model_preference}</strong> from disk?</span>
								<button class="link-btn dim-link" disabled={removeBusy} onclick={() => removeConnection(p.id)}>Connection only</button>
								<button class="link-btn x-red-link" disabled={removeBusy} onclick={() => removeAndDeleteDisk(p)}>Delete from disk</button>
								<button class="link-btn dim-link" onclick={() => (confirmRemoveId = null)}>Cancel</button>
							{:else}
								{#if testMsg[p.id]}<span class="muted-xs">{testMsg[p.id]}</span>{/if}
								{#if p.id !== active?.id}<button class="link-btn" onclick={() => setActive(p.id)}>Use</button>{/if}
								<button class="link-btn dim-link" onclick={() => test(p.id)}>Test</button>
								<button class="link-btn x-red-link" onclick={() => onRemoveClick(p)}>Remove</button>
							{/if}
						</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- ── Web access (owner-only, Anthropic-run search) ── -->
		<div class="lane">
			<button class="sub-toggle" role="switch" aria-checked={webSearchOn} disabled={webSearchBusy} onclick={() => setWebSearch(!webSearchOn)}>
				<span class="toggle sm" class:on={webSearchOn}><span class="knob"></span></span>
				<span class="sub-toggle-body"><span class="sub-toggle-title">Web access</span><span class="sub-toggle-sub">Let your agent search the web and fetch pages (Claude runs it). Available to you in chat &amp; your own DMs — never to other people messaging your bot.</span></span>
			</button>
		</div>

		<!-- ── Models per task — ONE area: on-box (local) + provider-routed ── -->
		{#if tasks.length}
			<div class="lane">
				<div class="lane-head"><span class="lane-title">Models</span><span class="lane-tag">per task</span></div>
				<p class="muted task-intro">Pick the model for each kind of work. The first group runs <strong>on your device</strong> (private + free, bulk over your whole vault); the rest route to a configured provider — left unset, they use your active provider.</p>

				{#if onboxTaskList.length}
					<div class="group-title">On your device · private</div>
					<!-- The EMBEDDER — bundled, and deliberately NOT a task row: it has no picker
					     because it has no choice (§3.10d-c). Rendering it as an approvable card with
					     a pre-ticked box would present a non-choice as consent. It is listed anyway
					     because it is the one on-box model every vault runs, and an owner reading a
					     list of what runs on their device should not have to infer the search index. -->
					<div class="task-row">
						<span class="task-label">Search — semantic recall</span>
						<div class="task-ctl"><ModelHealth kind="included" health={models?.embedder} /></div>
					</div>
					{#each onboxTaskList as task}
						<div class="task-row">
							<span class="task-label">{TASK_LABELS[task] || task}</span>
							<div class="task-ctl">
								<!-- The approval IS the value (§3.10c). Extracted so a gate can MOUNT and drive
								     it — see OnboxTaskSelect.svelte for why "" is Off and not "Recommended". -->
								<OnboxTaskSelect
									value={onboxModelOf(task)}
									recModel={onboxRecModel}
									options={onboxOptions(task)}
									disabled={taskBusy === task}
									onpick={(m) => setOnboxModel(task, m)}
								/>
								<!-- The health of THIS task's own member, directly under the picker that causes
								     it. `categorize`→labeler and `enrich`→enricher are independent members: this
								     is what makes "approved Labeling, declined Enrichment" visible rather than
								     dormant and silent. -->
								<ModelHealth health={healthOf(task)} />
							</div>
						</div>
					{/each}
					<!-- ⚠️ COUPLED TO THE APPROVAL MODEL — increment I MUST revisit this sentence.
					     "Each task is approved separately" is TRUE of THIS screen: it renders one
					     select per on-box task and drives the PER-TASK route, which writes exactly
					     one. It becomes FALSE the moment the Intelligence screen (§3.11) replaces
					     this block — that screen approves Understanding = {categorize, enrich} as ONE
					     choice via `PUT /providers/task-models {function}` (gate M8 in
					     verify-task-models.mjs).
					     WHY FIVE SWEEPS MISSED THE SENTENCE BELOW: it WRAPS A LINE, and grep is
					     line-oriented — it cannot match a phrase across a newline. Sweeping for
					     any claim like this one must be MULTILINE (perl -0777, whitespace
					     collapsed), or you will "verify" a completeness you do not have.
					     ⚠️ Note this paragraph quotes NOTHING from the LIVE sentence below (the
					     phrase in quotes further up is the OLD wording, kept as history). Two
					     earlier drafts quoted the live phrase to explain the trap — which made the
					     very grep they warned about return hits, on the warning itself. A caveat
					     that falsifies its own instruction is worse than none (review ×5, 2026-07-16).
					     -->
					<p class="muted-xs">
						Choosing a model is how you approve it: “Recommended” downloads {onboxRecModel}
						(~3.4GB, plus the local model runtime) the first time it’s needed, and you can watch
						it in the activity feed. “Off” means nothing downloads and nothing runs on your
						device for this task, which is a supported choice. Each task here is approved on its
						own.{#if !hwRec} Detect your hardware under “Local” above to also pick from models you already have.{/if}
					</p>
				{/if}

				{#if cloudTaskList.length}
					<div class="group-title">Provider-routed</div>
					{#each cloudTaskList as task}
						<div class="task-row">
							<span class="task-label">{TASK_LABELS[task] || task}</span>
							<select
								class="task-select"
								disabled={taskBusy === task || !providers.length}
								value={taskModels[task]?.providerId ?? ''}
								onchange={(e) => setTaskModel(task, (e.currentTarget as HTMLSelectElement).value ? Number((e.currentTarget as HTMLSelectElement).value) : null)}
							>
								<option value="">Use active provider{active ? ` (${providerLabel(active)})` : ''}</option>
								{#each providers as p}
									<option value={p.id}>{providerLabel(p)}{p.model_preference ? ` · ${p.model_preference}` : ''}</option>
								{/each}
							</select>
						</div>
					{/each}
					{#if !providers.length}<p class="muted-xs">Connect a provider above to route these — until then they fall back to your active / on-device model.</p>{/if}
				{/if}
			</div>
		{/if}

		<!-- ── Voice transcription (dedicated Whisper) ── -->
		<div class="lane">
			<div class="lane-head"><span class="lane-title">Voice transcription</span><span class="lane-tag j-green">private · on your device</span></div>
			{#if !trans}
				<div class="muted">Transcription status unavailable.</div>
			{:else}
				{#if transStarting && trans.health?.status !== 'downloading'}
						<div class="muted pulse">Starting {transStarting} download…</div>
					{:else if trans.health?.status === 'ok' && trans.model}
					<div class="trans-status">✓ Voice notes are transcribed on-device by <span class="mono">{trans.model}</span>.</div>
				{:else if trans.health?.status === 'downloading'}
					<div class="trans-progress">
						<span class="muted pulse">Downloading {trans.model}… {trans.health?.progress?.pct ?? 0}%</span>
						<div class="trans-bar"><div class="trans-fill" style={`width:${trans.health?.progress?.pct ?? 0}%`}></div></div>
					</div>
				{:else if trans.health?.status === 'loading' || trans.health?.status === 'starting' || trans.health?.status === 'installing_deps'}
					<div class="muted pulse">{trans.health?.message || 'Preparing transcription…'}</div>
				{:else if trans.health?.status === 'deps_missing'}
					<div class="note-amber">{trans.health?.message}</div>
				{:else if trans.health?.status === 'error' || trans.health?.status === 'down' || trans.health?.status === 'unavailable'}
					<!-- `down` was MISSING from this chain, so a crash-looping engine
					     (transcribe/supervisor.js: setHealth('down', 'The transcription engine keeps
					     stopping.')) fell through to the {:else} and told the owner to DOWNLOAD a
					     model they already have — discarding the honest message for marketing copy
					     (independent review, 2026-07-16). `message` first here: for `down` it is the
					     sentence written for the owner, while `detail` is the process tail. -->
					<div class="err-box">{trans.health?.message || trans.health?.detail || 'The transcription model failed.'}</div>
				{:else}
					<div class="muted">Voice notes currently lean on your chat model — slow and only when it understands audio. Download a dedicated Whisper model once for fast, accurate transcripts that never leave your device.</div>
				{/if}
				{#if trans.health?.status !== 'downloading'}
					<div class="trans-cards">
						{#each trans.catalog as c (c.model)}
							<div class="trans-card">
								<div class="trans-card-head">
									<span class="trans-name">{c.label}</span>
									{#if c.recommended}<span class="chip j-green">★ recommended</span>{/if}
								</div>
								<span class="muted-xs">{c.blurb} · ~{(c.sizeMB / 1000).toFixed(1)} GB</span>
								{#if trans.model === c.model && trans.health?.status === 'ok'}
									<span class="trans-inuse">✓ in use</span>
								{:else}
									<button class="ghost-btn" disabled={transBusy} onclick={() => downloadWhisper(c.model)}>
										{transStarting === c.model ? 'Starting…' : trans.health?.status === 'ok' ? 'Switch to this model' : 'Download & use'}
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if transErr}<div class="err-box">{transErr}</div>{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.ai-page { display: flex; flex-direction: column; gap: 0.65rem; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; }
	.muted-xs { color: var(--color-text-tertiary); font-size: 0.7rem; line-height: 1.4; }
	.pulse { animation: pulse 1.6s ease-in-out infinite; }
	.err-box { color: #f87171; font-size: 0.78rem; padding: 0.5rem 0.7rem; border-radius: 8px; background: rgba(248,113,113,0.1); }
	.note-amber { color: #d9a441; font-size: 0.7rem; }
	.mono { font-family: var(--font-mono, monospace); color: var(--color-text-primary); font-size: 0.76rem; flex-shrink: 0; }

	/* Hero */
	.hero {
		display: flex; align-items: center; gap: 0.85rem;
		padding: 1rem 1.1rem; border-radius: 14px;
		background: rgba(229,184,76,0.07); border: 1px solid rgba(229,184,76,0.3);
	}
	.hero.none { background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.1); }
	.hero-spark { display: flex; flex-shrink: 0; color: var(--color-accent-aurum, #e5b84c); }
	.hero-spark svg { width: 26px; height: 26px; }
	.hero.none .hero-spark { color: var(--color-text-tertiary); opacity: 0.7; }
	.hero-body { display: flex; align-items: center; flex-wrap: wrap; gap: 0.45rem 0.6rem; min-width: 0; }
	.hero-label { font-size: 0.95rem; color: var(--color-text-primary); font-weight: 500; }
	.hero-model { font-family: var(--font-mono, monospace); font-size: 0.82rem; color: var(--color-text-secondary); font-weight: 400; }
	.hero-sub { font-size: 0.74rem; color: var(--color-text-tertiary); flex-basis: 100%; }

	/* Lanes */
	.lane { padding: 0.8rem 0.9rem; border-radius: 13px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.07); }
	.lane-head { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.7rem; }
	.lane-title { font-size: 0.82rem; font-weight: 600; color: var(--color-text-primary); }
	.lane-tag { font-size: 0.66rem; color: var(--color-text-tertiary); }
	.lane-tag.j-green { color: #6ee7a8; }

	/* Chips */
	.chip { font-size: 0.62rem; padding: 2px 7px; border-radius: 9px; white-space: nowrap; flex-shrink: 0; }
	.j-green { background: rgba(74,222,128,0.14); color: #6ee7a8; }
	.j-amber { background: rgba(229,184,76,0.16); color: #e5b84c; }
	.fit-green { background: rgba(74,222,128,0.14); color: #6ee7a8; }
	.fit-blue { background: rgba(56,189,248,0.14); color: #7dd3fc; }
	.fit-amber { background: rgba(229,184,76,0.16); color: #e5b84c; }
	.fit-red { background: rgba(248,113,113,0.14); color: #f87171; }

	/* Rows */
	.model-search {
		width: 100%; margin-top: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 8px; font-size: 0.76rem; font-family: inherit;
		border: 1px solid var(--glass-input-border); background: var(--glass-input-bg); color: var(--color-text-primary);
	}
	.model-search::placeholder { color: var(--color-text-tertiary); }
	.model-search:focus { outline: none; border-color: var(--color-accent-aurum); }
	.rec-list { display: flex; flex-direction: column; gap: 5px; max-height: 18rem; overflow-y: auto; margin-top: 0.5rem; }
	.row { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem; border-radius: 9px; background: rgba(255,255,255,0.03); font-size: 0.78rem; }
	.row.dim { opacity: 0.5; }
	.row.rec-top { background: rgba(229,184,76,0.06); border: 1px solid rgba(229,184,76,0.3); }
	.chip.rec-pick { background: var(--color-accent-aurum); color: var(--color-bg); }
	/* role-aware "recommended for X" — gold-tinted, lighter than the solid companion badge */
	.chip.rec-role { background: rgba(229,184,76,0.14); color: var(--color-accent-aurum, #e5b84c); }
	.preset-chip.rec-desc { border-color: var(--color-accent-aurum, #e5b84c); color: var(--color-accent-aurum, #e5b84c); }
	.row-blurb { color: var(--color-text-tertiary); font-size: 0.68rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row-action { margin-left: auto; display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }
	.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-border); flex-shrink: 0; }
	.dot.on { background: #4ade80; }
	.conn-name { color: var(--color-text-primary); font-weight: 500; }

	/* Buttons */
	.ghost-btn { font-size: 0.76rem; padding: 0.5rem 0.9rem; border-radius: 9px; border: 1px solid var(--color-border); background: none; color: var(--color-text-secondary); cursor: pointer; }
	.ghost-btn:hover { border-color: var(--color-accent-aurum, #e5b84c); }
	.link-btn { background: none; border: none; font-size: 0.7rem; color: var(--color-accent-aurum, #e5b84c); cursor: pointer; font-family: inherit; padding: 0; }
	.dim-link { color: var(--color-text-secondary); }
	.x-red-link { color: #f87171; }
	.solid-btn { font-size: 0.76rem; padding: 0.45rem 1rem; border-radius: 8px; border: none; background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; font-weight: 500; cursor: pointer; font-family: inherit; }
	.solid-btn:disabled { opacity: 0.5; cursor: default; }
	.x-red { color: #f87171; font-size: 0.7rem; }
	.x-green { color: #4ade80; font-size: 0.7rem; }

	/* Cloud presets + connect form */
	.preset-group { margin-bottom: 0.6rem; }
	.group-title { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-tertiary); margin-bottom: 0.4rem; }
	.chips-row { display: flex; flex-wrap: wrap; gap: 0.45rem; }
	.preset-chip { font-size: 0.74rem; padding: 0.4rem 0.8rem; border-radius: 8px; border: 1px solid var(--color-border); background: none; color: var(--color-text-secondary); cursor: pointer; font-family: inherit; }
	.preset-chip:hover { border-color: var(--color-accent-aurum, #e5b84c); color: var(--color-text-primary); }
	.connect-form { display: flex; flex-direction: column; gap: 0.5rem; }
	.cf-head { display: flex; align-items: center; gap: 0.5rem; }
	.cf-name { font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); }
	.cf-actions { display: flex; align-items: center; gap: 0.7rem; }
	.inp { width: 100%; padding: 0.5rem 0.65rem; font-size: 0.76rem; font-family: var(--font-mono, monospace); background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: var(--color-text-primary); outline: none; }
	.inp:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	.identity-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
	.id-name { flex: 1; min-width: 0; font-family: inherit; }
	.id-persona { flex-shrink: 0; }
	.model-field { display: flex; align-items: center; gap: 0.5rem; }
	.model-field .inp { flex: 1; min-width: 0; }
	.load-models { flex-shrink: 0; white-space: nowrap; }
	.load-models:disabled { opacity: 0.5; cursor: default; }

	/* Smart routing */
	.toggle { margin-top: 2px; flex-shrink: 0; width: 36px; height: 20px; border-radius: 10px; background: var(--color-border); position: relative; transition: background 0.18s; }
	.toggle.on { background: var(--color-accent-aurum, #e5b84c); }
	.knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 0.18s; }
	.toggle.on .knob { left: 18px; }

	/* Voice transcription */
	.trans-status { font-size: 0.8rem; color: var(--color-text-primary); }
	.trans-progress { display: flex; flex-direction: column; gap: 0.4rem; }
	.trans-bar { height: 5px; border-radius: 3px; background: var(--glass-input-bg, rgba(255,255,255,0.06)); overflow: hidden; }
	.trans-fill { height: 100%; border-radius: 3px; background: var(--color-accent-aurum, #e5b84c); transition: width 0.5s ease; }
	.trans-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.6rem; }
	.trans-card { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.75rem 0.9rem; border-radius: 12px; border: 1px solid var(--glass-border, rgba(255,255,255,0.07)); background: var(--glass-card-bg, rgba(255,255,255,0.025)); }
	.trans-card-head { display: flex; align-items: center; gap: 0.5rem; justify-content: space-between; }
	.trans-name { font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); }
	.trans-inuse { font-size: 0.74rem; color: var(--color-accent-aurum, #e5b84c); }

	/* Per-task model selection */
	.task-intro { font-size: 0.72rem; color: var(--color-text-tertiary); line-height: 1.45; margin: 0 0 0.6rem; }
	.task-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; padding: 0.35rem 0; }
	.task-label { font-size: 0.8rem; color: var(--color-text-primary); padding-top: 0.3rem; }
	/* The control and the health it causes, stacked as one right-hand unit. `min-width` gives
	   a download's progress bar a track to run in — flex-end alone would collapse it to the
	   width of the text above it. */
	.task-ctl { display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; min-width: min(52%, 22ch); }
	.task-select { flex: 0 1 auto; max-width: 60%; font-size: 0.76rem; color: var(--color-text-primary); background: var(--color-surface-2, rgba(255,255,255,0.04)); border: 1px solid var(--color-border, rgba(255,255,255,0.12)); border-radius: 8px; padding: 0.3rem 0.5rem; }
	.task-select:disabled { opacity: 0.5; }

	@keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
	/* Claude subscription */
	.sub-group { margin-top: 0.2rem; padding-top: 0.7rem; border-top: 1px solid rgba(255,255,255,0.06); }
	.sub-chip { border-color: rgba(229,184,76,0.4); color: var(--color-accent-aurum); }
	.sub-chip:hover { background: rgba(229,184,76,0.08); color: var(--color-accent-aurum); }
	.sub-row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
	.sub-ok { font-size: 0.78rem; color: #6ee7a8; }
	/* Honest state: green ONLY when probe-verified usable. Amber = works-but-attention
	   (expiring / Keychain declined); red = not usable. The old card was green always. */
	.sub-ok.sub-warn { color: var(--color-accent-aurum, #e5b84c); }
	.sub-ok.sub-err { color: var(--color-accent-coral, #f87171); }
	.sub-meta { font-size: 0.68rem; color: var(--color-text-tertiary); margin-top: 0.15rem; text-transform: capitalize; }
	/* Diagnostics line (source / renewal) — lowercase, it carries identifiers not prose. */
	.sub-diag { text-transform: none; opacity: 0.8; }
	.sub-model-row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin-top: 0.55rem; }
	.sub-model-label { font-size: 0.74rem; color: var(--color-text-secondary); }
	.sub-model-ctl { display: flex; align-items: center; gap: 0.5rem; }
	.sub-toggle { display: flex; align-items: flex-start; gap: 0.6rem; margin-top: 0.55rem; padding: 0; background: none; border: none; cursor: pointer; text-align: left; font-family: inherit; }
	.sub-toggle:disabled { opacity: 0.6; }
	.toggle.sm { width: 30px; height: 17px; }
	.toggle.sm .knob { width: 13px; height: 13px; }
	.toggle.sm.on .knob { left: 15px; }
	.sub-toggle-title { display: block; font-size: 0.74rem; color: var(--color-text-secondary); }
	.sub-toggle-sub { display: block; font-size: 0.66rem; color: var(--color-text-tertiary); line-height: 1.4; margin-top: 1px; }
	.ack { display: flex; align-items: center; gap: 0.45rem; font-size: 0.74rem; color: var(--color-text-secondary); cursor: pointer; }
	.ack input { accent-color: var(--color-accent-aurum); }
</style>
