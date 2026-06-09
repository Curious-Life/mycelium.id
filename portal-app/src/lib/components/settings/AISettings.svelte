<!--
	AI & Intelligence — the model that powers Mycelium's thinking (enrichment,
	narration, chat). Redesigned glassy surface: an active-model hero, then two
	clean lanes (Local · private / Cloud · your key), the connected set, and smart
	routing. Reuses the proven /portal/providers + /portal/hardware logic; only the
	presentation is new. This is the target of "Spawn intelligence" / "Connect AI".
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Preset = { id: string; label: string; kind: 'openai' | 'anthropic'; baseUrl: string; jurisdiction: string; defaultModel: string };
	type Provider = { id: number; provider: string; label: string | null; base_url: string | null; model_preference: string | null; is_active: number; status: string };

	let presets = $state<Preset[]>([]);
	let providers = $state<Provider[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let chosen = $state<Preset | null>(null);
	let apiKey = $state('');
	let model = $state('');
	let saving = $state(false);
	let saveErr = $state<string | null>(null);
	let testMsg = $state<Record<number, string>>({});

	type Rec = { name: string; bestFor: string; estimatedGb: number; fitScore: number; fitLevel: string; blurb: string; installed: boolean; recommended?: boolean; ageMonths?: number | null };
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

	let cascade = $state(false);
	let cascadeBusy = $state(false);

	const FIT: Record<string, { label: string; cls: string }> = {
		perfect: { label: 'great fit', cls: 'fit-green' },
		good: { label: 'good fit', cls: 'fit-blue' },
		marginal: { label: 'tight', cls: 'fit-amber' },
		too_tight: { label: "won't fit", cls: 'fit-red' },
	};
	const JURIS: Record<string, { label: string; cls: string }> = {
		'eu-zdr': { label: 'EU · zero-retention', cls: 'j-green' },
		'us-standard': { label: 'US · Cloud-Act', cls: 'j-amber' },
		'us-zdr': { label: 'US · zero-retention', cls: 'j-amber' },
		local: { label: 'on your device', cls: 'j-green' },
	};

	const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';
	const isLocalUrl = (u: string | null) => !!u && /127\.0\.0\.1|localhost|11434|:1234/.test(u);

	// Cloud presets only here (local lane is the hardware recommender below).
	const cloudGroups = $derived([
		{ key: 'eu-zdr', title: 'EU-sovereign · recommended', items: presets.filter((p) => p.jurisdiction === 'eu-zdr') },
		{ key: 'us', title: 'US providers', items: presets.filter((p) => p.jurisdiction.startsWith('us')) },
	]);

	// ── Active model (hero) ──
	const active = $derived(providers.find((p) => p.is_active));
	const activeInfo = $derived.by(() => {
		if (!active) return null;
		const local = isLocalUrl(active.base_url) || active.provider === 'custom' && isLocalUrl(active.base_url);
		const preset = presets.find((p) => p.baseUrl && p.baseUrl === active.base_url);
		const jur = local ? 'local' : active.provider === 'anthropic' ? 'us-standard' : (preset?.jurisdiction ?? '');
		return {
			label: active.label || active.provider,
			model: active.model_preference || '',
			local: !!local || jur === 'local',
			juris: jur,
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
			providers = cu.providers || [];
		} catch (e: any) {
			error = e?.message || 'Failed to load providers';
		} finally {
			loading = false;
		}
	}
	async function loadRouting() {
		try { const r = await api('/portal/providers/routing'); if (r.ok) cascade = (await r.json()).cascade === true; } catch { /* default off */ }
	}
	async function setCascade(v: boolean) {
		cascadeBusy = true;
		try { const r = await api('/portal/providers/routing', { method: 'PUT', body: JSON.stringify({ cascade: v }) }); if (r.ok) cascade = (await r.json()).cascade === true; }
		catch { /* leave */ } finally { cascadeBusy = false; }
	}
	onMount(() => { load(); loadRouting(); });

	function choose(p: Preset) { chosen = p; apiKey = ''; model = p.defaultModel || ''; saveErr = null; }
	const needsKey = $derived(chosen ? chosen.jurisdiction !== 'local' : false);

	async function connect(e: Event) {
		e.preventDefault();
		if (!chosen) return;
		saving = true; saveErr = null;
		const body: Record<string, unknown> = {
			provider: chosen.kind === 'anthropic' ? 'anthropic' : 'custom',
			label: chosen.label,
			model_preference: model.trim() || chosen.defaultModel || undefined,
		};
		if (chosen.kind !== 'anthropic') body.base_url = chosen.baseUrl;
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
	async function remove(id: number) { await api(`/portal/providers/${id}`, { method: 'DELETE' }); await load(); }
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
				<span class="hero-label">Using {activeInfo.label}{#if activeInfo.model} · <span class="hero-model">{activeInfo.model}</span>{/if}</span>
				{#if JURIS[activeInfo.juris]}<span class="chip {JURIS[activeInfo.juris].cls}">{JURIS[activeInfo.juris].label}</span>{/if}
			{:else}
				<span class="hero-label">No intelligence connected yet</span>
				<span class="hero-sub">Connect one below — local &amp; private, or a cloud key.</span>
			{/if}
		</div>
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
					{#if needsKey}<input type="password" bind:value={apiKey} placeholder="API key" autocomplete="off" class="inp" />{/if}
					<input type="text" bind:value={model} placeholder={chosen.defaultModel || 'model (optional)'} class="inp" />
					<div class="cf-actions">
						<button type="submit" disabled={saving || (needsKey && !apiKey.trim())} class="solid-btn">{saving ? 'Connecting…' : 'Connect'}</button>
						<button type="button" class="link-btn dim-link" onclick={() => (chosen = null)}>Cancel</button>
					</div>
					{#if saveErr}<div class="x-red">{saveErr}</div>{/if}
				</form>
			{:else}
				{#each cloudGroups as g (g.key)}
					{#if g.items.length}
						<div class="preset-group">
							<div class="group-title">{g.title}</div>
							<div class="chips-row">
								{#each g.items as p (p.id)}<button class="preset-chip" onclick={() => choose(p)}>{p.label}</button>{/each}
							</div>
						</div>
					{/if}
				{/each}
			{/if}
		</div>

		<!-- ── Connected ── -->
		{#if providers.length}
			<div class="lane">
				<div class="lane-head"><span class="lane-title">Connected</span></div>
				{#each providers as p (p.id)}
					<div class="row">
						<span class="dot" class:on={p.is_active}></span>
						<span class="conn-name">{p.label || p.provider}</span>
						{#if p.is_active}<span class="chip j-green">active</span>{/if}
						<span class="row-action">
							{#if testMsg[p.id]}<span class="muted-xs">{testMsg[p.id]}</span>{/if}
							{#if !p.is_active}<button class="link-btn" onclick={() => setActive(p.id)}>Use</button>{/if}
							<button class="link-btn dim-link" onclick={() => test(p.id)}>Test</button>
							<button class="link-btn x-red-link" onclick={() => remove(p.id)}>Remove</button>
						</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- ── Smart routing ── -->
		<button class="routing" role="switch" aria-checked={cascade} aria-label="Smart routing" disabled={cascadeBusy} onclick={() => setCascade(!cascade)}>
			<span class="toggle" class:on={cascade}><span class="knob"></span></span>
			<span class="routing-body">
				<span class="routing-title">Smart routing</span>
				<span class="routing-sub">Try providers in order — EU-sovereign → frontier → on-device — falling back if one is down. Sensitive requests always skip US.</span>
			</span>
		</button>
	{/if}
</div>

<style>
	.ai-page { display: flex; flex-direction: column; gap: 1rem; }
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
	.lane { padding: 0.9rem 1rem; border-radius: 13px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.07); }
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

	/* Smart routing */
	.routing { display: flex; align-items: flex-start; gap: 0.7rem; padding: 0.8rem 1rem; border-radius: 13px; border: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.025); cursor: pointer; text-align: left; font-family: inherit; }
	.routing:disabled { opacity: 0.6; }
	.toggle { margin-top: 2px; flex-shrink: 0; width: 36px; height: 20px; border-radius: 10px; background: var(--color-border); position: relative; transition: background 0.18s; }
	.toggle.on { background: var(--color-accent-aurum, #e5b84c); }
	.knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 0.18s; }
	.toggle.on .knob { left: 18px; }
	.routing-title { display: block; font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); }
	.routing-sub { display: block; font-size: 0.68rem; color: var(--color-text-tertiary); line-height: 1.45; margin-top: 2px; }

	@keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
</style>
