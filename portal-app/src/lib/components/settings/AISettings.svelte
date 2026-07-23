<!--
	Connect & manage providers — DEMOTED to a pure connection surface by the Intelligence
	redesign (docs/INTELLIGENCE-SCREEN-REDESIGN-2026-07-17.md Part I, P3/§9). It keeps the
	Local/Cloud connect lanes, the #133 Claude ladder, the subscription card (+ the §4g
	sensitive-work opt-in), web access, and the connected-providers list. It has LOST the
	active-model hero, every per-task/per-function assignment control, the assistant
	name/personality editor, and the whisper rail (moved under the Transcription function
	row in IntelligenceScreen — see TranscriptionSetup.svelte). ASSIGNMENT lives in exactly
	one place now: IntelligenceScreen (P2). This component never writes settings.taskModels
	— gate A3 (verify-intelligence-flow.mjs) mounts it and fails if a task-model control
	grows back.
-->
<script lang="ts">
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
	// QA6-P1 #2: "Open Claude sign-in" was a bare <a target="_blank">. Inside the Tauri
	// webview a _blank navigation is swallowed — the click launched NOTHING and the user
	// was left hand-copying the URL out of the DOM. It now goes through openSignIn(),
	// which reports failure, and the URL is ALWAYS rendered next to it as selectable
	// text with a Copy button. There is no state in which the user cannot reach the link.
	let subOpenFailed = $state(false);
	let subUrlCopied = $state(false);
	function openSignIn() {
		if (!subWebUrl) return;
		subOpenFailed = false;
		try {
			const w = window.open(subWebUrl, '_blank', 'noopener,noreferrer');
			// A null handle means the browser/webview refused (popup blocker, Tauri's
			// _blank policy). Fail VISIBLY — never a silent no-op.
			if (!w) subOpenFailed = true;
		} catch { subOpenFailed = true; }
	}
	async function copySignInUrl() {
		if (!subWebUrl) return;
		try {
			await navigator.clipboard.writeText(subWebUrl);
			subUrlCopied = true;
			setTimeout(() => { subUrlCopied = false; }, 1600);
		} catch { /* the URL is selectable text right there — copy is a convenience */ }
	}

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
		{ id: 'claude-opus-4-8', label: 'Opus 4.8 · recommended · most capable' },
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
			// R4-6: eagerly widen the model list — pull the fuller Claude set the account can use so
			// the picker shows it WITHOUT a manual "Refresh" click. Best-effort: a token lacking the
			// models:list scope just leaves the curated CLAUDE_SUB_MODELS (the reliable baseline).
			if (subStatus?.authenticated && subStatus.providerId) void pullSubModels();
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

	// Role-aware recommendations (curated operator picks, from /providers/presets) — the
	// cloud lane's ★ badge only. Every ASSIGNMENT control (per-task selects, on-box pickers)
	// left this component with the redesign (P2/P3): IntelligenceScreen owns assignment.
	let roleRecs = $state<{ labeling?: { model?: string }; descriptions?: { presetId?: string } } | null>(null);

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
	// (ON_DEVICE — the hero's green on-device chip — left with the hero, §9.)

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

	// The RESOLVED active provider — mirror the backend getActive(): among the
	// is_active rows (there's one per provider TYPE), the most-recently-used wins.
	// (find(is_active) was wrong — it returned whichever sorted first.) Used by the
	// Connected list's dot + "Use" buttons; the HERO that displayed it collapsed into
	// the pane's summary card (Part I §9 — one home for "what's running").
	const active = $derived(
		[...providers].filter((p) => p.is_active)
			.sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''))[0] ?? null,
	);

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
	// The subscription connect panel, anchored so a sibling component can bring the
	// user here instead of telling them to go hunting ("Connect your subscription below"
	// is not an action — this is).
	let subAnchor = $state<HTMLElement | null>(null);
	onMount(() => {
		load(); loadSub();
		// EngineSelector's blocked-engine panel dispatches this when the missing piece
		// is the subscription. Open the panel + scroll it into view, so the click there
		// lands somewhere visible rather than doing nothing.
		const onConnectSub = () => {
			subOpen = true; subErr = null;
			queueMicrotask(() => subAnchor?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
		};
		window.addEventListener('mycelium:connect-claude-sub', onConnectSub);
		return () => window.removeEventListener('mycelium:connect-claude-sub', onConnectSub);
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
	<!-- The active-model hero and the assistant name/personality editor were REMOVED here
	     (Part I §9): the summary card owns "what's running"; identity moves to the per-agent
	     character page. This surface connects and manages providers — nothing else. -->
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
							<!-- The ★ is CURATED (2026-07-19): only an endorsed model we actually use is
							     `recommended`. When that model is also the labeling pick, say so in one chip
							     rather than stacking two ★s. A stray labeling tag without endorsement (legacy)
							     still renders its own chip. -->
							{#if m.recommended}<span class="chip rec-pick" title="A model we use and endorse">★ recommended{#if m.recommendedFor?.includes('labeling')} · for labeling{/if}</span>
							{:else if m.recommendedFor?.includes('labeling')}<span class="chip rec-role" title="Recommended for the on-box labeling model (Context Engine L1)">★ for labeling</span>{/if}
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

		<div class="lane" bind:this={subAnchor}>
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
							<button type="button" class="solid-btn" onclick={openSignIn}>Open Claude sign-in ↗</button>
							<button type="button" class="link-btn" onclick={copySignInUrl}>{subUrlCopied ? '✓ Link copied' : 'Copy link'}</button>
						</div>
						{#if subOpenFailed}
							<p class="x-red">Couldn’t open a browser window from here. Copy the link below and paste it into your browser.</p>
						{/if}
						<!-- ALWAYS rendered, not only on failure: a webview can refuse a _blank
						     navigation WITHOUT reporting it, so the copyable link is the
						     guaranteed path — never a fallback we might fail to trigger. -->
						<div class="signin-url"><code>{subWebUrl}</code></div>
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
					<!-- IM-1 (operator-confirmed 2026-07-20): the dense two-group preset-chip grid
					     ("EU-sovereign" / "US providers" as wrapping chip clouds) was the readability
					     eyesore the operator named. Retired for a single calm list — one provider per
					     line, its jurisdiction stated plainly, the Narration recommendation marked. Still
					     a pure CONNECT surface (P3/A3): tapping a row opens the connect form; model→function
					     ASSIGNMENT lives only in the Functions tab (IntelligenceScreen), never here — so
					     this simplification removes no connect or assignment capability. -->
					<div class="preset-group">
						<div class="group-title">Connect a cloud provider</div>
						<div class="connect-list">
							{#each cloudGroups as g (g.key)}
								{#each g.items as p (p.id)}
									{@const rec = roleRecs?.descriptions?.presetId === p.id}
									<button class="connect-row" class:rec-desc={rec} onclick={() => choose(p)}
										title={rec ? 'Recommended for Narration — mindscape descriptions (the narrate task), on modest hardware' : undefined}>
										<span class="cr-name">{#if rec}<span class="cr-star">★</span> {/if}{p.label}</span>
										{#if JURIS[p.jurisdiction]}<span class="chip {JURIS[p.jurisdiction].cls}">{JURIS[p.jurisdiction].label}</span>{/if}
										<span class="cr-go">Connect →</span>
									</button>
								{/each}
							{/each}
						</div>
					</div>
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
								<span class="sub-toggle-body"><span class="sub-toggle-title">Also use it for sensitive work</span><span class="sub-toggle-sub">Let your subscription process persona &amp; claim analysis — otherwise kept on-device/EU. Off by default.</span></span>
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

		<!-- The "Models per task" lane and the whisper rail are GONE from this surface
		     (Part I §9): assignment lives in IntelligenceScreen (one surface, by function);
		     the whisper rail renders under the Transcription function row there
		     (TranscriptionSetup.svelte). This component keeps only connect + manage. -->
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
	/* IM-1: the calm connect list that replaced the dense preset-chip grid — one provider per
	   row (name · jurisdiction · Connect). Theme-aware via the shared tokens: text/borders come
	   from CSS vars that flip per theme; the glass overlay matches the pane's other rows. */
	.connect-list { display: flex; flex-direction: column; gap: 0.3rem; }
	.connect-row { display: flex; align-items: center; gap: 0.55rem; width: 100%; text-align: left; font: inherit; font-size: 0.78rem; padding: 0.5rem 0.65rem; border-radius: 9px; border: 1px solid var(--color-border); background: rgba(255,255,255,0.02); color: var(--color-text-primary); cursor: pointer; }
	.connect-row:hover { border-color: var(--color-accent-aurum, #e5b84c); background: rgba(255,255,255,0.045); }
	.connect-row.rec-desc { border-color: rgba(229,184,76,0.4); }
	.cr-name { font-weight: 500; color: var(--color-text-primary); }
	.cr-star { color: var(--color-accent-aurum, #e5b84c); }
	.cr-go { margin-left: auto; font-size: 0.72rem; color: var(--color-accent-aurum, #e5b84c); flex-shrink: 0; white-space: nowrap; }
	.connect-form { display: flex; flex-direction: column; gap: 0.5rem; }
	.cf-head { display: flex; align-items: center; gap: 0.5rem; }
	.cf-name { font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); }
	.cf-actions { display: flex; align-items: center; gap: 0.7rem; }
	.inp { width: 100%; padding: 0.5rem 0.65rem; font-size: 0.76rem; font-family: var(--font-mono, monospace); background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: var(--color-text-primary); outline: none; }
	.inp:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	.model-field { display: flex; align-items: center; gap: 0.5rem; }
	.model-field .inp { flex: 1; min-width: 0; }
	.load-models { flex-shrink: 0; white-space: nowrap; }
	.load-models:disabled { opacity: 0.5; cursor: default; }

	/* Smart routing */
	.toggle { margin-top: 2px; flex-shrink: 0; width: 36px; height: 20px; border-radius: 10px; background: var(--color-border); position: relative; transition: background 0.18s; }
	.toggle.on { background: var(--color-accent-aurum, #e5b84c); }
	.knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 0.18s; }
	.toggle.on .knob { left: 18px; }


	/* The control and the health it causes, stacked as one right-hand unit. `min-width` gives
	   a download's progress bar a track to run in — flex-end alone would collapse it to the
	   width of the text above it. */
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
	/* The sign-in URL, always visible + selectable, so "Open" failing is never a wall. */
	.signin-url {
		margin: 0.35rem 0 0.5rem; padding: 0.35rem 0.5rem; border-radius: 7px;
		background: rgba(0,0,0,0.25); overflow-x: auto;
	}
	.signin-url code {
		font-family: var(--font-mono); font-size: 0.62rem; white-space: nowrap;
		color: var(--color-text-secondary); user-select: all;
	}
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
