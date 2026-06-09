<script lang="ts">
	// MindscapeInvite — the empty-vault invitation AND the in-window onboarding.
	// Three ethereal actions (Data · Intelligence · Connect); clicking one
	// transforms THIS panel into a minimal inline step (with Back), so setup
	// happens right here over the living 3D map — never a page jump.
	import { api } from '$lib/api';

	let { displayName = null, onImported = () => {} }: { displayName?: string | null; onImported?: () => void } = $props();

	type Step = 'home' | 'data' | 'intelligence' | 'connect';
	let step = $state<Step>('home');

	// Per-action "done this session" flags → home cards show a check.
	let dataDone = $state(false);
	let aiDone = $state(false);
	let connectDone = $state(false);

	// ── Data ───────────────────────────────────────────────────────────────────
	let importing = $state(false);
	let importMsg = $state('');
	let importErr = $state('');
	async function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importing = true; importErr = ''; importMsg = '';
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await api('/portal/upload', { method: 'POST', body: fd });
			const d = await res.json().catch(() => ({}));
			if (!res.ok) { importErr = d.error || 'Could not read that file.'; return; }
			const n = d.stats?.messages ?? d.messages ?? null;
			importMsg = n ? `Imported ${Number(n).toLocaleString()} messages.` : 'Imported.';
			dataDone = true;
			onImported();
		} catch {
			importErr = 'Import failed.';
		} finally {
			importing = false;
		}
	}

	// ── Intelligence ─────────────────────────────────────────────────────────────
	// Mirrors the Settings AI page (the "cookbook"): a Local lane driven by the
	// hardware recommender (most-capable/most-suitable models per machine, one-tap
	// Pull&use) + a Cloud lane with every preset incl. the EU-sovereign options.
	type Rec = { name: string; installed: boolean; fitLevel: string; bestFor: string; estimatedGb: number; fitScore?: number };
	type Preset = { id: string; label: string; kind: string; baseUrl: string; jurisdiction: string; defaultModel: string };
	const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';
	const FIT: Record<string, { label: string; cls: string }> = {
		perfect: { label: 'great fit', cls: 'fit-green' },
		good: { label: 'good fit', cls: 'fit-blue' },
		marginal: { label: 'tight', cls: 'fit-amber' },
		too_tight: { label: "won't fit", cls: 'fit-red' },
	};
	const JURIS: Record<string, { label: string; cls: string }> = {
		'eu-zdr': { label: 'EU · zero-retention', cls: 'fit-green' },
		'us-standard': { label: 'US', cls: 'fit-amber' },
		local: { label: 'on your device', cls: 'fit-green' },
	};
	let hwRec = $state<any | null>(null);
	let hwLoading = $state(false);
	let hwErr = $state('');
	let pulling = $state<Record<string, { pct: number; status: string; err?: string }>>({});
	let presets = $state<Preset[]>([]);
	let providers = $state<any[]>([]);
	let chosen = $state<Preset | null>(null);
	let aiKey = $state('');
	let model = $state('');
	let aiBusy = $state(false);
	let aiErr = $state('');

	const cloudGroups = $derived([
		{ key: 'eu', title: 'EU-sovereign · recommended', items: presets.filter((p) => p.jurisdiction === 'eu-zdr') },
		{ key: 'us', title: 'US providers', items: presets.filter((p) => p.jurisdiction.startsWith('us')) },
	]);
	const needsKey = $derived(!!chosen && chosen.jurisdiction !== 'local');

	// Only surface fresh models (≤ 6 months old per the catalog's "updated"), and
	// keep the list CONTAINED — show the top few, expand for the rest — so the
	// Cloud options stay in view rather than being pushed down a long scroll.
	const MAX_AGE_MONTHS = 6;
	const COLLAPSED_COUNT = 3;
	let showAllLocal = $state(false);
	const recentRecs = $derived(((hwRec?.recommendations ?? []) as Rec[]).filter((m: any) => m.ageMonths == null || m.ageMonths <= MAX_AGE_MONTHS));
	const visibleRecs = $derived(showAllLocal ? recentRecs : recentRecs.slice(0, COLLAPSED_COUNT));

	$effect(() => {
		if (step === 'intelligence') {
			if (hwRec === null && !hwLoading) loadRecommend();
			if (presets.length === 0) loadPresets();
		}
	});

	async function loadProviders() {
		try { const r = await api('/portal/providers'); if (r.ok) { const d = await r.json(); providers = d.providers || []; } } catch { /* */ }
	}
	async function loadRecommend() {
		hwLoading = true; hwErr = '';
		try {
			const r = await api('/portal/hardware/recommend'); const d = await r.json();
			if (!d.ok) throw new Error(d.error || 'detection failed');
			hwRec = d;
		} catch (e: any) { hwErr = e?.message || 'Hardware detection failed'; }
		finally { hwLoading = false; }
	}
	async function loadPresets() {
		try { const r = await api('/portal/providers/presets'); if (r.ok) { const d = await r.json(); presets = d.presets || []; } } catch { /* */ }
		await loadProviders();
	}
	async function pullAndUse(m: Rec) {
		pulling = { ...pulling, [m.name]: { pct: m.installed ? 100 : 0, status: m.installed ? 'installed' : 'starting…' } };
		try {
			if (!m.installed) {
				const res = await api('/portal/hardware/pull', { method: 'POST', body: JSON.stringify({ name: m.name }) });
				if (!res.body) throw new Error('no progress stream');
				const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
				for (;;) {
					const { value, done } = await reader.read(); if (done) break;
					buf += dec.decode(value, { stream: true });
					let nl: number;
					while ((nl = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
						if (!line.startsWith('data: ')) continue;
						const payload = line.slice(6); if (payload === '[DONE]') continue;
						let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
						if (ev.done) { if (!ev.ok) throw new Error(ev.error || 'pull failed'); }
						else if (ev.total) { pulling = { ...pulling, [m.name]: { pct: Math.round((ev.completed / ev.total) * 100), status: ev.status } }; }
						else if (ev.status) { pulling = { ...pulling, [m.name]: { pct: 0, status: ev.status } }; }
					}
				}
			}
			const existing = providers.find((p) => p.base_url === OLLAMA_BASE && p.model_preference === m.name);
			if (existing) { await api(`/portal/providers/${existing.id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) }); }
			else {
				const cr = await api('/portal/providers', { method: 'POST', body: JSON.stringify({ provider: 'custom', label: `Local · ${m.name}`, base_url: OLLAMA_BASE, model_preference: m.name }) });
				const cd = await cr.json().catch(() => ({}));
				if (cr.ok && cd.id && !cd.activated) await api(`/portal/providers/${cd.id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
			}
			pulling = { ...pulling, [m.name]: { pct: 100, status: 'ready' } };
			aiDone = true; await loadProviders();
		} catch (e: any) { pulling = { ...pulling, [m.name]: { pct: 0, status: 'failed', err: e?.message } }; }
	}
	function choose(p: Preset) { chosen = p; aiKey = ''; model = p.defaultModel || ''; aiErr = ''; }
	async function connectCloud(e: Event) {
		e.preventDefault(); if (!chosen) return;
		aiBusy = true; aiErr = '';
		const body: Record<string, unknown> = {
			provider: chosen.kind === 'anthropic' ? 'anthropic' : 'custom',
			label: chosen.label,
			model_preference: model.trim() || chosen.defaultModel || undefined,
		};
		if (chosen.kind !== 'anthropic') body.base_url = chosen.baseUrl;
		if (aiKey.trim()) body.api_key = aiKey.trim();
		try {
			const res = await api('/portal/providers', { method: 'POST', body: JSON.stringify(body) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(d.error || 'Failed to connect');
			chosen = null; aiKey = ''; model = ''; aiDone = true; await loadProviders();
		} catch (e: any) { aiErr = e?.message || 'Failed to connect'; }
		finally { aiBusy = false; }
	}

	// ── Connect ──────────────────────────────────────────────────────────────────
	let tgToken = $state(''); let tgId = $state(''); let dcToken = $state('');
	let cBusy = $state(''); let cErr = $state('');
	async function saveTelegram() {
		if (!tgToken.trim() || !tgId.trim()) return;
		cBusy = 'tg'; cErr = '';
		try {
			await api('/portal/settings/secret', { method: 'PUT', body: JSON.stringify({ key: 'OWNER_TELEGRAM_ID', value: tgId.trim(), scope: 'personal' }) });
			await api('/portal/settings/secret', { method: 'PUT', body: JSON.stringify({ key: 'TELEGRAM_BOT_TOKEN', value: tgToken.trim(), scope: 'personal' }) });
			await api('/portal/channels', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
			connectDone = true; tgToken = ''; tgId = '';
		} catch { cErr = 'Could not save Telegram.'; }
		finally { cBusy = ''; }
	}
	async function saveDiscord() {
		if (!dcToken.trim()) return;
		cBusy = 'dc'; cErr = '';
		try {
			await api('/portal/settings/secret', { method: 'PUT', body: JSON.stringify({ key: 'DISCORD_BOT_TOKEN', value: dcToken.trim(), scope: 'org' }) });
			await api('/portal/channels', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
			connectDone = true; dcToken = '';
		} catch { cErr = 'Could not save Discord.'; }
		finally { cBusy = ''; }
	}
</script>

{#if step === 'home'}
	<p class="invite-eyebrow">{#if displayName}Welcome, {displayName}{:else}Welcome{/if}</p>
	<h2 class="welcome-title invite-title">Grow your mycelium</h2>
	<p class="welcome-subtitle invite-subtitle">Three steps to begin.</p>
	<div class="invite-actions">
		<button class="invite-card" class:done={dataDone} onclick={() => (step = 'data')}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
			<span class="invite-name">Data{#if dataDone} ✓{/if}</span>
			<span class="invite-hint">Bring your world in</span>
		</button>
		<button class="invite-card" class:done={aiDone} onclick={() => (step = 'intelligence')}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
			<span class="invite-name">Intelligence{#if aiDone} ✓{/if}</span>
			<span class="invite-hint">Connect an AI</span>
		</button>
		<button class="invite-card" class:done={connectDone} onclick={() => (step = 'connect')}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H5.2L4 17.2z"/></svg>
			<span class="invite-name">Connect{#if connectDone} ✓{/if}</span>
			<span class="invite-hint">Link a messenger</span>
		</button>
	</div>
{:else}
	<button class="invite-back" onclick={() => (step = 'home')}>← Back</button>

	{#if step === 'data'}
		<h2 class="welcome-title invite-title">Bring your world in</h2>
		<p class="welcome-subtitle">Your conversations, journals, transcripts — anything that holds your thinking. Encrypted on import.</p>
		<label class="invite-file">
			<input type="file" accept=".zip,.json" onchange={onFile} disabled={importing} />
			<span>{importing ? 'Reading…' : 'Choose an export — ChatGPT · Claude · LinkedIn'}</span>
		</label>
		{#if importMsg}<p class="invite-ok">{importMsg} Your map is forming.</p>{/if}
		{#if importErr}<p class="invite-err">{importErr}</p>{/if}
	{:else if step === 'intelligence'}
		<h2 class="welcome-title invite-title">Choose your intelligence</h2>
		<p class="welcome-subtitle">Local stays on your device. Cloud keys stay encrypted in your vault.</p>

		<!-- Local · the hardware recommender (the cookbook, in onboarding) -->
		<div class="lane">
			<div class="lane-head"><span class="lane-title">Local · private</span><span class="lane-pill fit-green">on your device</span></div>
			{#if hwLoading}
				<p class="invite-or">Detecting your hardware…</p>
			{:else if hwErr}
				<p class="invite-err">{hwErr}</p>
			{:else if hwRec}
				<p class="lane-hw">
					{hwRec.hardware?.hasGpu ? `${hwRec.hardware.gpuName} · ${hwRec.hardware.gpuVramGb}GB` : `${hwRec.hardware?.cpuCores ?? ''}-core CPU`} · {hwRec.hardware?.totalRamGb}GB RAM{#if !hwRec.ollamaInstalled} · Ollama auto-installs on first pick{/if}
				</p>
				<div class="rec-list">
					{#each visibleRecs as m (m.name)}
						<div class="rec-row" class:dim={m.fitScore === 0}>
							<span class="rec-name">{m.name}</span>
							<span class="lane-pill {FIT[m.fitLevel]?.cls ?? ''}">{FIT[m.fitLevel]?.label ?? m.fitLevel}</span>
							<span class="rec-blurb">{m.bestFor} · ~{m.estimatedGb}GB</span>
							<span class="rec-act">
								{#if pulling[m.name]}
									{#if pulling[m.name].err}<span class="invite-err sm">{pulling[m.name].err}</span>
									{:else if pulling[m.name].status === 'ready'}<span class="rec-ready">✓ ready</span>
									{:else}<span class="invite-or sm">{pulling[m.name].status}{pulling[m.name].pct ? ` ${pulling[m.name].pct}%` : ''}</span>{/if}
								{:else}
									<button class="rec-btn" onclick={() => pullAndUse(m)}>{m.installed ? 'Use' : 'Pull & use'}</button>
								{/if}
							</span>
						</div>
					{/each}
				</div>
				{#if recentRecs.length > COLLAPSED_COUNT}
					<button class="rec-more" onclick={() => (showAllLocal = !showAllLocal)}>
						{showAllLocal ? 'Show fewer' : `Show ${recentRecs.length - COLLAPSED_COUNT} more`}
					</button>
				{/if}
			{/if}
		</div>

		<!-- Cloud · every preset, EU-sovereign first -->
		<div class="lane">
			<div class="lane-head"><span class="lane-title">Cloud · your key</span></div>
			{#if !chosen}
				{#each cloudGroups as g (g.key)}
					{#if g.items.length}
						<div class="preset-group">
							<span class="group-title">{g.title}</span>
							<div class="chips-row">
								{#each g.items as p (p.id)}<button class="preset-chip" onclick={() => choose(p)}>{p.label}</button>{/each}
							</div>
						</div>
					{/if}
				{/each}
			{:else}
				<form class="cloud-form" onsubmit={connectCloud}>
					<div class="cf-head"><span class="cf-name">{chosen.label}</span>{#if JURIS[chosen.jurisdiction]}<span class="lane-pill {JURIS[chosen.jurisdiction].cls}">{JURIS[chosen.jurisdiction].label}</span>{/if}</div>
					{#if needsKey}<input type="password" bind:value={aiKey} placeholder="API key" autocomplete="off" data-1p-ignore />{/if}
					<input type="text" bind:value={model} placeholder={chosen.defaultModel || 'model (optional)'} autocomplete="off" />
					<div class="cf-actions">
						<button type="submit" class="invite-btn sm" disabled={aiBusy || (needsKey && !aiKey.trim())}>{aiBusy ? 'Connecting…' : 'Connect'}</button>
						<button type="button" class="invite-link" onclick={() => (chosen = null)}>Cancel</button>
					</div>
				</form>
			{/if}
		</div>
		{#if aiDone}<p class="invite-ok">Intelligence connected ✓</p>{/if}
		{#if aiErr}<p class="invite-err">{aiErr}</p>{/if}
	{:else if step === 'connect'}
		<h2 class="welcome-title invite-title">Link a messenger</h2>
		<p class="welcome-subtitle">Talk to your mind from Telegram or Discord. Optional — you can do this later.</p>
		<p class="invite-label">Telegram — token from <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>, your id from <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a></p>
		<div class="invite-row">
			<input type="text" bind:value={tgToken} placeholder="bot token" autocomplete="off" data-1p-ignore />
		</div>
		<div class="invite-row">
			<input type="text" bind:value={tgId} placeholder="your user id" autocomplete="off" data-1p-ignore />
			<button class="invite-btn sm" disabled={!tgToken || !tgId || cBusy === 'tg'} onclick={saveTelegram}>{cBusy === 'tg' ? '…' : 'Save'}</button>
		</div>
		<p class="invite-label">Discord — bot token from <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers</a></p>
		<div class="invite-row">
			<input type="text" bind:value={dcToken} placeholder="bot token" autocomplete="off" data-1p-ignore />
			<button class="invite-btn sm" disabled={!dcToken || cBusy === 'dc'} onclick={saveDiscord}>{cBusy === 'dc' ? '…' : 'Save'}</button>
		</div>
		{#if connectDone}<p class="invite-ok">Linked ✓</p>{/if}
		{#if cErr}<p class="invite-err">{cErr}</p>{/if}
	{/if}
{/if}

<style>
	.invite-eyebrow {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase;
		color: var(--color-accent-aurum, #e5b84c); margin-bottom: 0.7rem;
	}
	.invite-title { font-size: 1.5rem; font-weight: 400; letter-spacing: -0.01em; margin-bottom: 0.6rem; }
	/* Subtitle styled here (component-scoped) + a generous gap below so the cards
	   sit proportionally above the panel's bottom padding. */
	.invite-subtitle { font-size: 0.85rem; color: var(--color-text-secondary); line-height: 1.6; margin: 0 0 1.25rem; }
	.invite-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-top: 0; }
	.invite-card {
		display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
		padding: 1.1rem 0.75rem; background: var(--glass-card-bg);
		border: 1px solid var(--glass-border); border-radius: 12px;
		color: var(--color-text-primary); cursor: pointer; text-align: center;
		transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
	}
	.invite-card:hover { transform: translateY(-2px); border-color: rgba(229, 184, 76, 0.4); background: var(--glass-card-hover); }
	.invite-card.done { border-color: rgba(74, 222, 128, 0.4); }
	.invite-card svg { width: 22px; height: 22px; color: var(--color-accent-aurum, #e5b84c); opacity: 0.9; }
	.invite-name { font-size: 0.86rem; font-weight: 500; }
	.invite-hint { font-size: 0.7rem; color: var(--color-text-secondary); line-height: 1.35; }

	.invite-back {
		background: none; border: none; color: var(--color-text-secondary);
		font-size: 0.75rem; cursor: pointer; padding: 0; margin-bottom: 0.75rem;
	}
	.invite-back:hover { color: var(--color-text-primary); }
	.invite-file {
		display: block; margin-top: 0.5rem; padding: 0.9rem 1rem;
		border: 1px dashed var(--glass-input-border); border-radius: 10px;
		font-size: 0.8rem; color: var(--color-text-secondary); cursor: pointer; text-align: center;
	}
	.invite-file:hover { border-color: rgba(229, 184, 76, 0.5); }
	.invite-file input { display: none; }
	/* ── Intelligence lanes (the cookbook recommender, in onboarding) ───────── */
	.lane { margin-top: 0.85rem; }
	.lane-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.45rem; }
	.lane-title { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em; color: var(--color-text-primary); }
	.lane-pill {
		font-size: 0.56rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		padding: 2px 7px; border-radius: 999px; white-space: nowrap;
	}
	.fit-green { color: var(--color-accent-jade); background: rgba(74, 222, 128, 0.12); }
	.fit-blue { color: var(--color-accent); background: rgba(91, 159, 232, 0.12); }
	.fit-amber { color: var(--color-accent-aurum); background: rgba(229, 184, 76, 0.14); }
	.fit-red { color: var(--color-accent-coral); background: rgba(248, 113, 113, 0.12); }
	.lane-hw { font-size: 0.66rem; color: var(--color-text-tertiary); margin: 0 0 0.4rem; line-height: 1.4; }
	.rec-list { display: flex; flex-direction: column; gap: 4px; }
	.rec-row {
		display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 0.5rem;
		padding: 0.45rem 0.6rem; border: 1px solid var(--glass-border);
		background: var(--glass-card-bg); border-radius: 9px;
	}
	.rec-row.dim { opacity: 0.5; }
	.rec-name { font-family: var(--font-mono, monospace); font-size: 0.73rem; color: var(--color-text-primary); }
	.rec-blurb { font-size: 0.64rem; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rec-act { justify-self: end; }
	.rec-btn {
		background: none; border: 1px solid rgba(229, 184, 76, 0.35); color: var(--color-accent-aurum);
		font-size: 0.66rem; padding: 3px 10px; border-radius: 7px; cursor: pointer; font-family: inherit; white-space: nowrap;
	}
	.rec-btn:hover { background: var(--glass-card-hover); }
	.rec-ready { font-size: 0.66rem; color: var(--color-accent-jade); }
	.rec-more {
		margin-top: 5px; background: none; border: none; cursor: pointer; font-family: inherit;
		font-size: 0.66rem; color: var(--color-accent-aurum); padding: 2px 0;
	}
	.rec-more:hover { text-decoration: underline; }
	.preset-group { margin-bottom: 0.55rem; }
	.group-title { display: block; font-size: 0.62rem; color: var(--color-text-tertiary); margin-bottom: 0.3rem; }
	.chips-row { display: flex; flex-wrap: wrap; gap: 5px; }
	.preset-chip {
		padding: 5px 11px; border-radius: 999px; border: 1px solid var(--glass-border);
		background: var(--glass-card-bg); color: var(--color-text-primary);
		font-size: 0.72rem; cursor: pointer; font-family: inherit;
		transition: border-color 0.15s, background 0.15s;
	}
	.preset-chip:hover { border-color: rgba(229, 184, 76, 0.4); background: var(--glass-card-hover); }
	.cloud-form { display: flex; flex-direction: column; gap: 0.45rem; margin-top: 0.2rem; }
	.cf-head { display: flex; align-items: center; gap: 0.5rem; }
	.cf-name { font-size: 0.78rem; font-weight: 600; color: var(--color-text-primary); }
	.cloud-form input {
		padding: 0.5rem 0.65rem; border-radius: 7px; font-size: 0.78rem;
		border: 1px solid var(--glass-input-border); background: var(--glass-input-bg);
		color: var(--color-text-primary); font-family: var(--font-mono, monospace);
	}
	.cloud-form input::placeholder { color: var(--color-text-tertiary); }
	.cf-actions { display: flex; align-items: center; gap: 0.6rem; }
	.invite-link { background: none; border: none; color: var(--color-text-tertiary); font-size: 0.72rem; cursor: pointer; font-family: inherit; }
	.invite-link:hover { color: var(--color-text-primary); }
	.invite-or.sm, .invite-err.sm { font-size: 0.62rem; margin: 0; }
	.invite-row { display: flex; gap: 0.5rem; margin-top: 0.4rem; }
	.invite-row input {
		flex: 1; padding: 0.5rem 0.65rem; border-radius: 7px; font-size: 0.78rem;
		border: 1px solid var(--glass-input-border); background: var(--glass-input-bg);
		color: var(--color-text-primary); font-family: var(--font-mono, monospace);
	}
	.invite-row input::placeholder { color: var(--color-text-tertiary); }
	.invite-btn {
		margin-top: 0.5rem; padding: 0.5rem 1.1rem; border-radius: 8px; border: none;
		background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c;
		font-size: 0.8rem; font-weight: 500; cursor: pointer; font-family: inherit;
	}
	.invite-btn.sm { margin-top: 0; padding: 0.5rem 0.9rem; font-size: 0.75rem; white-space: nowrap; }
	.invite-btn:disabled { opacity: 0.5; cursor: default; }
	.invite-or { font-size: 0.68rem; color: var(--color-text-tertiary); margin: 0.6rem 0 0.2rem; }
	.invite-label { font-size: 0.7rem; color: var(--color-text-tertiary); margin: 0.8rem 0 0.2rem; line-height: 1.4; }
	.invite-label a { color: var(--color-accent-aurum, #e5b84c); }
	.invite-ok { font-size: 0.74rem; color: #4ade80; margin-top: 0.5rem; }
	.invite-err { font-size: 0.74rem; color: #f87171; margin-top: 0.5rem; }
	@media (max-width: 520px) { .invite-actions { grid-template-columns: 1fr; } }
</style>
