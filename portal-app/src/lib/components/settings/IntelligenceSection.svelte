<!--
	Intelligence settings section — connect Mycelium's OUTBOUND AI to any provider.

	Lists the curated provider catalog (GET /portal/providers/presets) grouped by
	jurisdiction (EU-sovereign · Local · US), lets you connect one with your own key
	(or no key for a local runtime), and manages the connected set against the
	/portal/providers CRUD. Mirrors RemoteAccessSection: same `card p-5` wrapper,
	`api()` client, Tailwind + CSS-var styling, component-local $state.

	This is what Mycelium uses to THINK (enrichment / narration / the future
	gateway) — distinct from Remote Access (which connects external AIs INTO the
	vault). Privacy: local stays on this Mac; EU-sovereign is zero-retention; US
	providers carry US Cloud-Act exposure (shown as a badge).
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

	// S6 — hardware-aware local model recommender ("Cookbook").
	// `quality` = companion-suitability (warmth/EQ for personal growth), NOT generic
	// capability; `bestFor` = what it's good for. Ranked descending by compat×quality.
	type Rec = { name: string; paramsB: number; quality: number; bestFor: string; estimatedGb: number; fitScore: number; fitLevel: string; rankScore?: number; blurb: string; installed: boolean };
	let hwRec = $state<{ hardware: any; available: number; backend: string; recommendations: Rec[]; note: string | null; ollamaUp: boolean; ollamaInstalled: boolean } | null>(null);
	let hwLoading = $state(false);
	let hwErr = $state<string | null>(null);
	let pulling = $state<Record<string, { pct: number; status: string; err?: string }>>({});

	const FIT: Record<string, { label: string; cls: string }> = {
		perfect: { label: 'great fit', cls: 'bg-green-500/15 text-green-400' },
		good: { label: 'good fit', cls: 'bg-sky-500/15 text-sky-400' },
		marginal: { label: 'tight', cls: 'bg-amber-500/15 text-amber-400' },
		too_tight: { label: "won't fit", cls: 'bg-red-500/15 text-red-400' }
	};

	// §4g smart routing (multi-provider cascade) preference.
	let cascade = $state(false);
	let cascadeBusy = $state(false);
	async function loadRouting() {
		try { const r = await api('/portal/providers/routing'); if (r.ok) cascade = (await r.json()).cascade === true; } catch { /* default off */ }
	}
	async function setCascade(v: boolean) {
		cascadeBusy = true;
		try { const r = await api('/portal/providers/routing', { method: 'PUT', body: JSON.stringify({ cascade: v }) }); if (r.ok) cascade = (await r.json()).cascade === true; }
		catch { /* leave as-is */ } finally { cascadeBusy = false; }
	}

	const JURISDICTION: Record<string, { label: string; cls: string }> = {
		'eu-zdr': { label: 'EU · zero-retention', cls: 'bg-green-500/15 text-green-400' },
		'us-standard': { label: 'US · Cloud-Act', cls: 'bg-amber-500/15 text-amber-400' },
		'us-zdr': { label: 'US · zero-retention', cls: 'bg-amber-500/15 text-amber-400' },
		'local': { label: 'Local · on this Mac', cls: 'bg-sky-500/15 text-sky-400' }
	};

	const groups = $derived([
		{ key: 'eu-zdr', title: 'EU-sovereign · recommended', items: presets.filter((p) => p.jurisdiction === 'eu-zdr') },
		{ key: 'local', title: 'Local · private', items: presets.filter((p) => p.jurisdiction === 'local') },
		{ key: 'us', title: 'US providers', items: presets.filter((p) => p.jurisdiction.startsWith('us')) }
	]);

	async function load() {
		loading = true; error = null;
		try {
			const [pr, cu] = await Promise.all([
				api('/portal/providers/presets').then((r) => r.json()),
				api('/portal/providers').then((r) => r.json())
			]);
			presets = pr.presets || [];
			providers = cu.providers || [];
		} catch (e: any) {
			error = e?.message || 'Failed to load providers';
		} finally {
			loading = false;
		}
	}
	onMount(() => { load(); loadRouting(); });

	function choose(p: Preset) {
		chosen = p; apiKey = ''; model = p.defaultModel || ''; saveErr = null;
	}

	const needsKey = $derived(chosen ? chosen.jurisdiction !== 'local' : false);

	async function connect(e: Event) {
		e.preventDefault();
		if (!chosen) return;
		saving = true; saveErr = null;
		// Anthropic is native (no base_url); everything else is OpenAI-compatible
		// via base_url (OpenAI / OpenRouter / EU-sovereign / Ollama / LM Studio).
		const body: Record<string, unknown> = {
			provider: chosen.kind === 'anthropic' ? 'anthropic' : 'custom',
			label: chosen.label,
			model_preference: model.trim() || chosen.defaultModel || undefined
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

	async function setActive(id: number) {
		await api(`/portal/providers/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
		await load();
	}
	async function remove(id: number) {
		await api(`/portal/providers/${id}`, { method: 'DELETE' });
		await load();
	}
	async function test(id: number) {
		testMsg = { ...testMsg, [id]: '…' };
		try {
			const res = await api(`/portal/providers/${id}/test`, { method: 'POST', body: '{}' });
			const data = await res.json().catch(() => ({}));
			testMsg = { ...testMsg, [id]: data?.result?.ok ? '✓ reachable' : `✗ ${data?.result?.error || 'failed'}` };
		} catch {
			testMsg = { ...testMsg, [id]: '✗ failed' };
		}
		await load();
	}

	async function loadRecommend() {
		hwLoading = true; hwErr = null;
		try {
			const data = await api('/portal/hardware/recommend').then((r) => r.json());
			if (!data.ok) throw new Error(data.error || 'detection failed');
			hwRec = data;
		} catch (e: any) {
			hwErr = e?.message || 'Hardware detection failed';
		} finally {
			hwLoading = false;
		}
	}

	// Friendly text for the daemon-start error reasons the pull stream can return.
	const PULL_ERR: Record<string, string> = {
		not_installed: 'Ollama isn’t installed',
		checksum_mismatch: 'Ollama download failed verification',
		download_failed: 'Ollama download failed — check your connection',
		unsupported_platform: 'auto-install unavailable on this OS — install Ollama manually',
		start_timeout: "Ollama didn’t start — try again",
		spawn_failed: "couldn’t start Ollama",
		ollama_unavailable: 'Ollama unavailable'
	};

	// The local Ollama base URL we register providers against (dedup key).
	const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';

	// Pull (if needed) the chosen local model with streaming progress, then register
	// it as a local Ollama provider via the existing /portal/providers route + activate.
	// The pull route AUTO-STARTS the Ollama daemon first (adopt-or-spawn) — no need
	// to ask the user to run `ollama serve`.
	async function pullAndUse(m: Rec) {
		pulling = { ...pulling, [m.name]: { pct: m.installed ? 100 : 0, status: m.installed ? 'installed' : 'starting…' } };
		try {
			if (!m.installed) {
				const res = await api('/portal/hardware/pull', { method: 'POST', body: JSON.stringify({ name: m.name }) });
				if (!res.body) throw new Error('no progress stream');
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let buf = '';
				let ok = false;
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
						else if (ev.total) {
							const pct = Math.min(100, Math.round((ev.completed / ev.total) * 100));
							pulling = { ...pulling, [m.name]: { pct, status: ev.status || 'downloading…' } };
						} else if (ev.status) {
							pulling = { ...pulling, [m.name]: { pct: pulling[m.name]?.pct ?? 0, status: ev.status } };
						}
					}
				}
				if (!ok) throw new Error('pull did not complete');
			}
			// Dedup: reuse an existing Ollama provider row for this model instead of
			// piling up identical `custom` rows on every click (no server-side dedup).
			const existing = providers.find((p) => p.base_url === OLLAMA_BASE && p.model_preference === m.name);
			if (existing) {
				await setActive(existing.id);
			} else {
				const body = { provider: 'custom', label: `Ollama — ${m.name}`, base_url: OLLAMA_BASE, model_preference: m.name };
				const cr = await api('/portal/providers', { method: 'POST', body: JSON.stringify(body) });
				const cd = await cr.json().catch(() => ({}));
				if (cr.ok && cd.id) await setActive(cd.id);
			}
			pulling = { ...pulling, [m.name]: { pct: 100, status: 'ready' } };
			await load();
			await loadRecommend();
		} catch (e: any) {
			pulling = { ...pulling, [m.name]: { pct: 0, status: 'failed', err: e?.message || 'failed' } };
		}
	}

	const inputCls = 'w-full px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none';
	const btnCls = 'text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer disabled:opacity-50';
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Intelligence</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		The AI that powers Mycelium's own thinking (enrichment, narration). Connect a provider with your own key — or run one locally. Local stays on this Mac; EU-sovereign is zero-retention; US providers carry US Cloud-Act exposure.
	</p>

	{#if loading}
		<div class="text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
	{:else if error}
		<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>
	{:else}
		{#if providers.length}
			<div class="mb-5 space-y-2">
				<div class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Connected</div>
				{#each providers as p (p.id)}
					<div class="flex items-center gap-2 text-xs p-2 rounded bg-[var(--color-elevated)]">
						<span class="font-medium text-[var(--color-text-primary)]">{p.label || p.provider}</span>
						{#if p.is_active}<span class="px-1.5 py-0.5 rounded text-[10px] bg-green-500/15 text-green-400">active</span>{/if}
						<span class="text-[10px] text-[var(--color-text-tertiary)] font-mono truncate">{p.base_url || p.provider}</span>
						<span class="ml-auto flex items-center gap-2">
							{#if testMsg[p.id]}<span class="text-[10px] text-[var(--color-text-tertiary)]">{testMsg[p.id]}</span>{/if}
							{#if !p.is_active}<button onclick={() => setActive(p.id)} class="text-[10px] text-aurum cursor-pointer">Use</button>{/if}
							<button onclick={() => test(p.id)} class="text-[10px] text-[var(--color-text-secondary)] cursor-pointer">Test</button>
							<button onclick={() => remove(p.id)} class="text-[10px] text-red-400 cursor-pointer">Remove</button>
						</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- §4g smart routing (multi-provider cascade) -->
		<div class="mb-5 flex items-start gap-3 p-3 rounded border border-[var(--color-border)]">
			<button
				onclick={() => setCascade(!cascade)}
				disabled={cascadeBusy}
				role="switch"
				aria-checked={cascade}
				aria-label="Smart routing"
				class="mt-0.5 shrink-0 w-9 h-5 rounded-full relative cursor-pointer disabled:opacity-50 transition-colors {cascade ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}"
			>
				<span class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all {cascade ? 'left-4' : 'left-0.5'}"></span>
			</button>
			<div class="text-xs">
				<div class="text-[var(--color-text-primary)] font-medium">Smart routing</div>
				<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Try your providers in priority order — EU-sovereign → frontier → on-box local — falling back automatically if one is unreachable. Off: use only the active provider. Sensitive requests always skip US providers.</div>
			</div>
		</div>

		<!-- S6 — hardware-aware local model recommender ("Cookbook") -->
		<div class="mb-5">
			{#if !hwRec && !hwLoading}
				<button onclick={loadRecommend} class="text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-aurum cursor-pointer">✨ Recommend a local model for my hardware</button>
			{:else if hwLoading}
				<div class="text-xs text-[var(--color-text-tertiary)] animate-pulse">Detecting hardware…</div>
			{:else if hwErr}
				<div class="text-xs text-red-400 p-2 rounded bg-red-500/10">{hwErr}</div>
			{:else if hwRec}
				<div class="p-3 rounded border border-[var(--color-border)] space-y-2">
					<div class="flex items-center gap-2 text-xs">
						<span class="font-medium text-[var(--color-text-primary)]">Recommended for your hardware</span>
						<span class="text-[10px] text-[var(--color-text-tertiary)]">
							{hwRec.hardware.hasGpu ? `${hwRec.hardware.gpuName} · ${hwRec.hardware.gpuVramGb}GB` : `${hwRec.hardware.cpuCores}-core CPU`} · {hwRec.hardware.totalRamGb}GB RAM · ~{hwRec.available}GB usable
						</span>
						<button onclick={loadRecommend} title="Re-detect" class="ml-auto text-[10px] text-[var(--color-text-tertiary)] cursor-pointer">↻</button>
					</div>
					{#if !hwRec.ollamaInstalled}
						<p class="text-[10px] text-[var(--color-text-tertiary)]">Ollama will be downloaded &amp; started automatically when you pick a model (or <a href="https://ollama.com/download" target="_blank" rel="noreferrer" class="text-aurum underline">install it yourself</a>).</p>
					{:else if !hwRec.ollamaUp}
						<p class="text-[10px] text-[var(--color-text-tertiary)]">Ollama will start automatically when you pick a model.</p>
					{/if}
					{#if hwRec.note}<p class="text-[10px] text-amber-400">{hwRec.note}</p>{/if}
					<p class="text-[10px] text-[var(--color-text-tertiary)]">Ranked for a warm personal companion &amp; self-development — best for your Mac on top.</p>
					<div class="max-h-72 overflow-y-auto space-y-1.5 pr-1">
						{#each hwRec.recommendations as m (m.name)}
							<div class="flex items-center gap-2 text-xs p-2 rounded bg-[var(--color-elevated)] {m.fitScore === 0 ? 'opacity-50' : ''}">
								<span class="font-mono text-[var(--color-text-primary)] shrink-0">{m.name}</span>
								<span class="px-1.5 py-0.5 rounded text-[10px] shrink-0 {FIT[m.fitLevel]?.cls ?? ''}">{FIT[m.fitLevel]?.label ?? m.fitLevel}</span>
								<span class="px-1.5 py-0.5 rounded text-[10px] shrink-0 bg-[var(--color-border)] text-[var(--color-text-secondary)]">{m.bestFor}</span>
								<span class="text-[10px] text-[var(--color-text-tertiary)] truncate">~{m.estimatedGb}GB · {m.blurb}</span>
								<span class="ml-auto shrink-0">
									{#if pulling[m.name]}
										{#if pulling[m.name].err}
											<span class="text-[10px] text-red-400">{pulling[m.name].err}</span>
										{:else if pulling[m.name].status === 'ready'}
											<span class="text-[10px] text-green-400">✓ ready</span>
										{:else}
											<span class="text-[10px] text-[var(--color-text-tertiary)]">{pulling[m.name].status}{pulling[m.name].pct ? ` ${pulling[m.name].pct}%` : ''}</span>
										{/if}
									{:else if m.installed}
										<button onclick={() => pullAndUse(m)} class="text-[10px] text-aurum cursor-pointer">Use</button>
									{:else}
										<button onclick={() => pullAndUse(m)} title={hwRec.ollamaInstalled ? '' : 'Downloads Ollama first, then the model'} class="text-[10px] text-aurum cursor-pointer">Pull &amp; use</button>
									{/if}
								</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		{#if chosen}
			<form onsubmit={connect} class="mb-5 space-y-2 p-3 rounded border border-[var(--color-border)]">
				<div class="flex items-center gap-2 text-xs">
					<span class="font-medium text-[var(--color-text-primary)]">Connect {chosen.label}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] {JURISDICTION[chosen.jurisdiction]?.cls ?? ''}">{JURISDICTION[chosen.jurisdiction]?.label ?? chosen.jurisdiction}</span>
				</div>
				{#if needsKey}
					<input type="password" bind:value={apiKey} placeholder="API key" autocomplete="off" class={inputCls} />
				{:else}
					<p class="text-[10px] text-[var(--color-text-tertiary)]">No key needed — make sure the local server is running at <span class="font-mono">{chosen.baseUrl}</span>.</p>
				{/if}
				<input type="text" bind:value={model} placeholder={chosen.defaultModel || 'model (optional)'} class={inputCls} />
				<div class="flex items-center gap-2">
					<button type="submit" disabled={saving || (needsKey && !apiKey.trim())} class={btnCls}>{saving ? 'Connecting…' : 'Connect'}</button>
					<button type="button" onclick={() => (chosen = null)} class="text-xs text-[var(--color-text-tertiary)] cursor-pointer">Cancel</button>
				</div>
				{#if saveErr}<div class="text-xs text-red-400">{saveErr}</div>{/if}
			</form>
		{/if}

		{#each groups as g (g.key)}
			{#if g.items.length}
				<div class="mb-4">
					<div class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">{g.title}</div>
					<div class="flex flex-wrap gap-2">
						{#each g.items as p (p.id)}
							<button onclick={() => choose(p)} class="text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-aurum cursor-pointer">{p.label}</button>
						{/each}
					</div>
				</div>
			{/if}
		{/each}
	{/if}
</section>
