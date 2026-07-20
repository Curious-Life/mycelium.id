<script lang="ts">
	// Wizard Step 3 — Connect your intelligence (U1.4). Stands up the private
	// on-device pipeline AND the conversational engine, then names the AI — the
	// State-A bundle from IntelligenceFlow relocated + re-skinned into the wizard.
	// It is NOT net-new model plumbing: same endpoints, same serialized-download
	// path (#279 runDownloadsSerially).
	//
	// ⚠️ Field-name shape (design reconciliation #5): per-row size is `downloadGb`
	// (0 when installed), total is `totalDownloadGb`. The on-device CORE rows are
	// runs==='on-device' (Search included · Understanding · Transcription); Voice is
	// `adjacent.voice` (a download, not a row); `descriptions` is EU-cloud, not core.
	//
	// ⚠️ NO hardcoded loopback URL in this file (P6 deny-by-default): the on-device
	// connect reads the Ollama preset's base_url from the SERVER (/providers/presets)
	// at runtime — the locality fact is the server's, never the frontend's.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { LOGO_ONDEVICE, LOGO_CLAUDE, LOGO_OPENROUTER, LOGO_APIKEY } from './logos.ts';

	let { onNext }: { onNext: () => void } = $props();

	type BundleRow = {
		key: string; model?: string; runs: string; included?: boolean; installed?: boolean;
		assigned?: boolean; downloadGb?: number; needsRuntime?: boolean;
	};
	type Bundle = {
		hardware: { platform: string | null; totalRamGb: number | null };
		rows: BundleRow[]; totalDownloadGb: number;
		disk: { freeGb: number | null; ok: boolean; shortfallGb: number };
		adjacent: { conversation: { subscriptionConnected: boolean }; voice?: { runnable?: boolean; installed?: boolean; sizeGb?: number } };
	};

	let bundle = $state<Bundle | null>(null);
	let loadErr = $state(false);
	// Per-downloadable-row checkbox, default ON (operator: all recommended on).
	let checked = $state<Record<string, boolean>>({});
	let downloading = $state(false);
	let dlLabel = $state('');
	let applyErr = $state('');

	// Which conversational engine is connected (drives the card ✓ + the name beat reveal).
	let hasEngine = $state(false);
	let engineLabel = $state<string | null>(null);

	const OUTCOME: Record<string, { label: string; sub: string }> = {
		search: { label: 'Search', sub: 'builds your mind-map' },
		understanding: { label: 'Understanding', sub: 'labels + categorizes, privately' },
		transcription: { label: 'Transcription', sub: 'turns voice notes into text' },
		voice: { label: 'Voice', sub: 'speaks replies in a voice' },
	};
	const machineNoun = $derived(bundle?.hardware?.platform === 'darwin' ? 'Mac' : 'computer');
	// Downloadable = a real download this row still needs (downloadGb > 0, not included).
	const isDownloadable = (r: BundleRow) => !r.included && (r.downloadGb ?? 0) > 0;

	// The on-device CORE presented as ONE list of four items (operator: "all four
	// models in the one-click bundle"): Search (included) · Understanding ·
	// Transcription — from the on-device bundle ROWS — plus **Voice**, which the
	// bundle carries as `adjacent.voice` (NOT a row, because a downloaded Qwen3-TTS
	// still needs a reference sample to SPEAK). Per the operator's locked Step-3
	// decision it is nonetheless a 4th DOWNLOADABLE here — default-on, trimmable like
	// Whisper — so its bytes are surfaced, totalled, and pulled via the TTS route.
	type CoreItem = { key: string; label: string; sub: string; included: boolean; installed: boolean; downloadable: boolean; sizeGb: number };
	const coreItems = $derived.by<CoreItem[]>(() => {
		const rows = (bundle?.rows || []).filter((r) => r.runs === 'on-device');
		const order = ['search', 'understanding', 'transcription'];
		const items: CoreItem[] = rows
			.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
			.map((r) => ({
				key: r.key, label: OUTCOME[r.key]?.label || r.key, sub: OUTCOME[r.key]?.sub || '',
				included: !!r.included, installed: !!r.installed,
				downloadable: isDownloadable(r), sizeGb: r.downloadGb || 0,
			}));
		const av = bundle?.adjacent?.voice;
		if (av) items.push({
			key: 'voice', label: OUTCOME.voice.label, sub: OUTCOME.voice.sub,
			included: false, installed: !!av.installed,
			downloadable: !av.installed && (av.sizeGb ?? 0) > 0, sizeGb: av.sizeGb || 0,
		});
		return items;
	});
	// A downloadable item is queued unless the user unchecked it (default ON).
	const isChecked = (it: CoreItem) => it.downloadable && checked[it.key] !== false;
	// Running total from the CHECKED downloadable items — recomputes live as each
	// checkbox (incl. Voice) toggles.
	const selectedGb = $derived(
		Math.round(coreItems.filter(isChecked).reduce((s, it) => s + (it.sizeGb || 0), 0) * 10) / 10,
	);
	const anyToDownload = $derived(coreItems.some(isChecked));
	// The understanding model id — reused by the on-device engine connect below.
	const understandingModel = $derived(
		(bundle?.rows || []).find((r) => r.key === 'understanding')?.model || null,
	);
	const ramFit = $derived.by(() => {
		const gb = bundle?.hardware?.totalRamGb;
		if (!gb) return '';
		return `fits your ${gb} GB ${machineNoun} ✓`;
	});

	async function getJSON(path: string): Promise<any | null> {
		try { const r = await api(path); return r.ok ? await r.json() : null; } catch { return null; }
	}

	async function loadBundle() {
		const b = await getJSON('/portal/intelligence/bundle');
		if (b?.ok) {
			bundle = b;
			if (b.adjacent?.conversation?.subscriptionConnected && !hasEngine) markEngine('Claude subscription', 'sub');
		} else loadErr = true;
	}

	// ── One-click serialized download (reuse the #279 path) ─────────────────────
	async function downloadCore() {
		if (downloading || !bundle) return;
		downloading = true; applyErr = '';
		// Understanding + Transcription are bundle ROWS → the apply orchestrator.
		// Voice is `adjacent.voice` → its OWN TTS route, appended to the same
		// serialized queue (never through apply, whose voice branch gates on a voice
		// SAMPLE the fresh vault does not have yet).
		const rowScope = coreItems.filter((it) => isChecked(it) && it.key !== 'voice').map((it) => it.key);
		const wantVoice = coreItems.some((it) => it.key === 'voice' && isChecked(it));
		try {
			const downloads: { key: string; model: string; route: string }[] = [];
			// ⚠️ Only call apply with a NON-EMPTY scope — apply treats an empty
			// `functions` array as "apply everything" (the STATE-A default), which would
			// pull cloud narrate too. A voice-only download must skip apply entirely.
			if (rowScope.length) {
				const res = await api('/portal/intelligence/bundle/apply', { method: 'POST', body: JSON.stringify({ functions: rowScope }) });
				const j = await res.json().catch(() => ({}));
				if (!res.ok) {
					applyErr = j?.error === 'disk_low'
						? `Not enough free space — free up ${j.shortfallGb ?? '?'} GB, then try again.`
						: 'Could not start the downloads. Try again in a moment.';
					return;
				}
				downloads.push(...(j.downloads || []));
			}
			if (wantVoice) downloads.push({ key: 'voice', model: 'qwen3-tts', route: '/portal/settings/tts/qwen/download' });
			// ⚠️ SERIALIZE (IM-2 / #279): fire the pulls ONE AT A TIME so a multi-GB Qwen pull
			// doesn't race Whisper/Voice and stall. Each download still goes through its OWN route.
			await runDownloadsSerially(downloads);
			await loadBundle();
		} catch {
			applyErr = 'Could not start the downloads. Try again in a moment.';
		} finally { downloading = false; dlLabel = ''; }
	}

	async function runDownloadsSerially(downloads: { key: string; model: string; route: string }[]) {
		for (const d of downloads) {
			dlLabel = `Downloading ${OUTCOME[d.key]?.label || d.key}…`;
			try {
				if (d.route === '/portal/hardware/pull') await startLabelPull(d.model);
				else if (d.route === '/portal/transcription/download') await api('/portal/transcription/download', { method: 'POST', body: JSON.stringify({ model: d.model }) });
				else if (d.route === '/portal/settings/tts/qwen/download') await api('/portal/settings/tts/qwen/download', { method: 'POST', body: JSON.stringify({}) });
			} catch { /* each row reports its own health; keep the queue moving */ }
		}
	}

	// The labeling-model SSE pull (installs the Ollama runtime first). Drains the
	// stream so the download is truly serialized before the next one starts.
	async function startLabelPull(name: string) {
		const res = await api('/portal/hardware/pull', { method: 'POST', body: JSON.stringify({ name }) });
		if (!res.body) return;
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = '';
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
				if (ev.done) { if (!ev.ok) throw new Error(ev.error || 'pull failed'); }
				else if (ev.total) dlLabel = `Downloading Understanding… ${Math.min(100, Math.round((ev.completed / ev.total) * 100))}%`;
			}
		}
	}

	// ── Section 2 — connect a conversational engine ─────────────────────────────
	let connecting = $state('');
	let connectErr = $state('');
	// Claude subscription — automated Pro/Max use may be subject to Anthropic's Terms;
	// require an explicit acknowledgment before importing the existing Claude login.
	let subAck = $state(false);
	let subOpen = $state(false);
	// OpenRouter / cloud-API-key — one inline key panel, prefilled per card.
	let keyOpen = $state(false);
	let keyProvider = $state<'openrouter' | 'openai' | 'anthropic'>('openrouter');
	let keyValue = $state('');
	// Preset base_urls from the SERVER (never hardcoded in the frontend — P6).
	let presets = $state<{ id: string; label: string; baseUrl: string; kind: string }[]>([]);

	// WHICH card is connected — drives every card's selected/✓ state uniformly (so the
	// cloud-API-key card lights up like the other three, not just OpenRouter).
	type EngineVia = 'ondevice' | 'sub' | 'openrouter' | 'apikey';
	let connectedVia = $state<EngineVia | null>(null);
	function markEngine(label: string, via: EngineVia) { hasEngine = true; engineLabel = label; connectedVia = via; }

	async function connectOnDevice() {
		if (connecting) return;
		connecting = 'ondevice'; connectErr = '';
		try {
			const model = understandingModel;
			const ollama = presets.find((p) => p.id === 'ollama');
			if (!model || !ollama?.baseUrl) { connectErr = 'Download the on-device models first, then connect.'; return; }
			const res = await api('/portal/providers', { method: 'POST', body: JSON.stringify({
				provider: 'custom', label: `On your device · ${model}`, base_url: ollama.baseUrl, model_preference: model,
			}) });
			const j = await res.json().catch(() => ({}));
			if (!res.ok || j?.ok === false) { connectErr = 'Could not connect the on-device engine — download the models first.'; return; }
			markEngine('On your device', 'ondevice');
		} catch { connectErr = 'Could not connect the on-device engine.'; }
		finally { connecting = ''; }
	}

	async function connectSubscription() {
		if (!subAck || connecting) return;
		connecting = 'sub'; connectErr = '';
		try {
			const res = await api('/portal/auth/claude/import', { method: 'POST', body: JSON.stringify({ acknowledgeToS: true }) });
			const j = await res.json().catch(() => ({}));
			if (!res.ok || !j.ok) { connectErr = j.error || 'Could not connect — make sure you are logged in to Claude Code.'; return; }
			markEngine('Claude subscription', 'sub'); subOpen = false;
		} catch { connectErr = 'Could not connect your Claude subscription.'; }
		finally { connecting = ''; }
	}

	function openKey(provider: 'openrouter' | 'openai' | 'anthropic') {
		keyProvider = provider; keyOpen = true; connectErr = ''; subOpen = false;
	}
	async function connectKey() {
		if (!keyValue.trim() || connecting) return;
		connecting = 'key'; connectErr = '';
		try {
			const preset = presets.find((p) => p.id === keyProvider);
			const body: any = { provider: preset?.kind || 'openai', label: preset?.label || keyProvider, api_key: keyValue.trim() };
			if (preset?.baseUrl) body.base_url = preset.baseUrl;
			const res = await api('/portal/providers', { method: 'POST', body: JSON.stringify(body) });
			const j = await res.json().catch(() => ({}));
			if (!res.ok || j?.ok === false) { connectErr = j?.error || 'Could not connect — check the key and try again.'; return; }
			markEngine(preset?.label || 'Cloud API', keyProvider === 'openrouter' ? 'openrouter' : 'apikey'); keyOpen = false; keyValue = '';
		} catch { connectErr = 'Could not connect the cloud key.'; }
		finally { connecting = ''; }
	}

	// ── Name beat (name-only; personality deferred to the character page) ────────
	let agentName = $state('');
	let advancing = $state(false);
	async function continueOn() {
		if (advancing) return;
		advancing = true;
		const name = agentName.trim();
		try { if (name) await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify({ name }) }); }
		catch { /* best-effort — nameable later on the character page */ }
		onNext();
	}

	onMount(async () => {
		const [pr] = await Promise.all([getJSON('/portal/providers/presets'), loadBundle()]);
		if (pr?.presets) presets = pr.presets;
	});
</script>

<div class="step-body">
	<h1 class="title">Connect your intelligence</h1>
	<p class="lede">Set up the private core that reads your mind-map — and the AI you'll talk to.</p>

	{#if loadErr}
		<p class="err">Could not load your intelligence options. You can set this up later in Settings.</p>
	{:else if !bundle}
		<p class="muted">Looking at your {machineNoun}…</p>
	{:else}
		<!-- ── Section 1 — your private core (on your device) ── -->
		<section class="sec">
			<div class="sec-head">
				<span class="sec-title">Your private core</span>
				<span class="sec-badge">on your {machineNoun} · recommended</span>
			</div>
			<div class="rows">
				{#each coreItems as it (it.key)}
					<label class="mrow" class:disabled={!it.downloadable}>
						{#if it.downloadable}
							<input type="checkbox" checked={checked[it.key] !== false} onchange={(e) => (checked = { ...checked, [it.key]: (e.currentTarget as HTMLInputElement).checked })} />
						{:else}
							<span class="incl" aria-hidden="true">✓</span>
						{/if}
						<span class="m-meta">
							<span class="m-label">{it.label}</span>
							<span class="m-sub">{it.sub}</span>
						</span>
						<span class="m-size">{it.included ? 'included' : it.installed ? 'installed' : `~${it.sizeGb} GB`}</span>
					</label>
				{/each}
			</div>
			<div class="dl-row">
				<button class="primary" disabled={downloading || !anyToDownload} onclick={downloadCore}>
					{downloading ? (dlLabel || 'Downloading…') : anyToDownload ? `Download all · ${selectedGb} GB` : 'Nothing to download'}
				</button>
				{#if ramFit && anyToDownload}<span class="fit">{ramFit}</span>{/if}
			</div>
			{#if bundle.disk && !bundle.disk.ok}
				<p class="err">Not enough free space — free up {bundle.disk.shortfallGb} GB first.</p>
			{:else if bundle.disk?.freeGb != null && anyToDownload}
				<p class="fine">{bundle.disk.freeGb} GB free · downloads run in the background.</p>
			{/if}
			{#if applyErr}<p class="err">{applyErr}</p>{/if}
		</section>

		<!-- ── Section 2 — how your assistant thinks (connect a conversational AI) ── -->
		<section class="sec">
			<div class="sec-head"><span class="sec-title">How your assistant thinks</span></div>
			<div class="cards">
				<button class="card" class:on={connectedVia === 'ondevice'} disabled={!!connecting} onclick={connectOnDevice}>
					<span class="logo">{@html LOGO_ONDEVICE}</span>
					<span class="c-name">On your device</span>
					<span class="c-sub">Uses the models above · fully private</span>
					{#if connectedVia === 'ondevice'}<span class="c-check">✓</span>{/if}
				</button>
				<button class="card" class:on={connectedVia === 'sub'} onclick={() => { subOpen = true; keyOpen = false; connectErr = ''; }}>
					<span class="logo">{@html LOGO_CLAUDE}</span>
					<span class="c-name">Your Claude subscription</span>
					<span class="c-sub">Use your existing Pro/Max login</span>
					{#if connectedVia === 'sub'}<span class="c-check">✓</span>{/if}
				</button>
				<button class="card" class:on={connectedVia === 'openrouter'} onclick={() => openKey('openrouter')}>
					<span class="logo">{@html LOGO_OPENROUTER}</span>
					<span class="c-name">OpenRouter</span>
					<span class="c-sub">One key, many models</span>
					{#if connectedVia === 'openrouter'}<span class="c-check">✓</span>{/if}
				</button>
				<button class="card" class:on={connectedVia === 'apikey'} onclick={() => openKey('openai')}>
					<span class="logo">{@html LOGO_APIKEY}</span>
					<span class="c-name">A cloud API key</span>
					<span class="c-sub">OpenAI, Anthropic or custom</span>
					{#if connectedVia === 'apikey'}<span class="c-check">✓</span>{/if}
				</button>
			</div>

			{#if subOpen}
				<div class="connect-panel">
					<label class="ack">
						<input type="checkbox" bind:checked={subAck} />
						<span>Use my existing Claude login. Automated use of a Pro/Max plan may be subject to Anthropic's Terms.</span>
					</label>
					<button class="primary sm" disabled={!subAck || connecting === 'sub'} onclick={connectSubscription}>
						{connecting === 'sub' ? 'Connecting…' : 'Connect'}
					</button>
				</div>
			{/if}
			{#if keyOpen}
				<div class="connect-panel">
					{#if keyProvider !== 'openrouter'}
						<div class="prov-seg" role="group" aria-label="Provider">
							<button class="seg" class:on={keyProvider === 'openai'} onclick={() => (keyProvider = 'openai')}>OpenAI</button>
							<button class="seg" class:on={keyProvider === 'anthropic'} onclick={() => (keyProvider = 'anthropic')}>Anthropic</button>
						</div>
					{/if}
					<input class="key-input" type="password" bind:value={keyValue} placeholder="Paste your API key" aria-label="API key" autocomplete="off" spellcheck="false" />
					<button class="primary sm" disabled={!keyValue.trim() || connecting === 'key'} onclick={connectKey}>
						{connecting === 'key' ? 'Connecting…' : 'Connect'}
					</button>
				</div>
			{/if}
			{#if connectErr}<p class="err">{connectErr}</p>{/if}

			<!-- Privacy invariant — even with a cloud engine, labeling + the mind-map stay on-device. -->
			<p class="privacy">Your assistant talks via your chosen engine; your labeling and mind-map are always built privately on your {machineNoun}.</p>
		</section>

		<!-- ── Name beat (name-only; personality lives on the character page) ── -->
		{#if hasEngine}
			<section class="sec name-beat">
				<label class="name-label" for="wiz-agent-name">What should we call it?</label>
				<input id="wiz-agent-name" class="name-input" type="text" maxlength="40" bind:value={agentName} placeholder="e.g. Aria" />
			</section>
		{/if}

		<div class="footer">
			<button class="primary" disabled={advancing} onclick={continueOn}>{advancing ? 'Saving…' : 'Continue'}</button>
		</div>
	{/if}
</div>

<style>
	.step-body { display: flex; flex-direction: column; }
	.title { font-family: var(--font-serif, 'Geist', system-ui, sans-serif); font-size: 1.5rem; font-weight: 400; line-height: 1.15; letter-spacing: -0.015em; color: var(--color-text-primary); margin: 0 0 0.5rem; }
	.lede { font-size: 0.9rem; line-height: 1.5; color: var(--color-text-secondary); margin: 0 0 1.2rem; }
	.muted { color: var(--color-text-tertiary); font-size: 0.85rem; }
	.err { font-size: 0.76rem; color: var(--color-coral, #e5736b); margin: 0.5rem 0 0; }
	.fine { font-size: 0.72rem; color: var(--color-text-tertiary); margin: 0.4rem 0 0; }
	.sec { margin-bottom: 1.3rem; }
	.sec-head { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.6rem; }
	.sec-title { font-size: 0.9rem; font-weight: 500; color: var(--color-text-primary); }
	.sec-badge { font-size: 0.68rem; color: var(--color-accent-aurum, #e5b84c); }
	.rows { display: flex; flex-direction: column; gap: 0.3rem; }
	.mrow { display: grid; grid-template-columns: auto 1fr auto; gap: 0.7rem; align-items: center; padding: 0.45rem 0.6rem; border-radius: 9px; background: var(--glass-card-bg, rgba(255,255,255,0.025)); border: 1px solid var(--glass-border, rgba(255,255,255,0.08)); cursor: pointer; }
	.mrow.disabled { cursor: default; opacity: 0.9; }
	.mrow input[type=checkbox] { accent-color: var(--color-accent-aurum, #e5b84c); }
	.incl { color: var(--color-accent-jade, #4ade80); font-size: 0.85rem; width: 1rem; text-align: center; }
	.m-meta { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
	.m-label { font-size: 0.82rem; color: var(--color-text-primary); }
	.m-sub { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.m-size { font-size: 0.74rem; font-family: var(--font-mono, monospace); color: var(--color-text-secondary); white-space: nowrap; }
	.dl-row { display: flex; align-items: center; gap: 0.9rem; margin-top: 0.7rem; flex-wrap: wrap; }
	.fit { font-size: 0.72rem; color: var(--color-text-tertiary); }
	.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem; }
	.card { position: relative; display: flex; flex-direction: column; gap: 0.2rem; text-align: left; padding: 0.7rem 0.8rem; border-radius: 11px; background: var(--glass-card-bg, rgba(255,255,255,0.025)); border: 1px solid var(--glass-border, rgba(255,255,255,0.1)); cursor: pointer; font-family: inherit; transition: border-color 0.15s ease, background 0.15s ease; }
	.card:hover:not(:disabled) { border-color: rgba(229,184,76,0.5); }
	.card:disabled { opacity: 0.55; cursor: default; }
	.card.on { border-color: var(--color-accent-aurum, #e5b84c); background: rgba(229,184,76,0.08); }
	.logo { display: inline-flex; width: 22px; height: 22px; color: var(--color-accent-aurum, #e5b84c); margin-bottom: 0.15rem; }
	.logo :global(svg) { width: 100%; height: 100%; }
	.c-name { font-size: 0.82rem; font-weight: 500; color: var(--color-text-primary); }
	.c-sub { font-size: 0.68rem; color: var(--color-text-tertiary); line-height: 1.3; }
	.c-check { position: absolute; top: 0.5rem; right: 0.6rem; color: var(--color-accent-aurum, #e5b84c); font-size: 0.85rem; }
	.connect-panel { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.6rem; padding: 0.7rem 0.8rem; border-radius: 10px; background: rgba(255,255,255,0.03); border: 1px solid var(--glass-border, rgba(255,255,255,0.08)); }
	.ack { display: flex; align-items: flex-start; gap: 0.45rem; font-size: 0.72rem; line-height: 1.4; color: var(--color-text-secondary); cursor: pointer; }
	.ack input { margin-top: 0.15rem; accent-color: var(--color-accent-aurum, #e5b84c); flex-shrink: 0; }
	.prov-seg { display: flex; gap: 0.35rem; }
	.seg { font-size: 0.7rem; padding: 3px 12px; border-radius: 7px; cursor: pointer; font-family: inherit; background: transparent; border: 1px solid var(--glass-border, rgba(255,255,255,0.14)); color: var(--color-text-secondary); }
	.seg.on { border-color: rgba(229,184,76,0.5); background: rgba(229,184,76,0.08); color: var(--color-accent-aurum, #e5b84c); }
	.key-input { padding: 0.5rem 0.7rem; border-radius: 9px; border: 1px solid var(--glass-input-border, rgba(255,255,255,0.14)); background: var(--glass-input-bg, rgba(0,0,0,0.2)); color: var(--color-text-primary); font-family: inherit; font-size: 0.82rem; outline: none; }
	.key-input:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	.privacy { font-size: 0.72rem; line-height: 1.45; color: var(--color-text-tertiary); margin: 0.8rem 0 0; padding-left: 0.7rem; border-left: 2px solid var(--glass-border, rgba(255,255,255,0.12)); }
	.name-beat { display: flex; flex-direction: column; gap: 0.4rem; }
	.name-label { font-size: 0.85rem; color: var(--color-text-primary); }
	.name-input { padding: 0.55rem 0.75rem; border-radius: 9px; border: 1px solid var(--glass-input-border, rgba(255,255,255,0.14)); background: var(--glass-input-bg, rgba(0,0,0,0.2)); color: var(--color-text-primary); font-family: inherit; font-size: 0.9rem; outline: none; max-width: 20rem; }
	.name-input:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	.footer { margin-top: 0.6rem; }
	.primary { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.55rem 1.2rem; border-radius: 9px; border: none; background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; font-family: inherit; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.15s ease; }
	.primary.sm { padding: 0.4rem 0.9rem; font-size: 0.78rem; align-self: flex-start; }
	.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(229,184,76,0.25); }
	.primary:disabled { opacity: 0.5; cursor: default; transform: none; box-shadow: none; }
	@media (max-width: 520px) { .cards { grid-template-columns: 1fr; } }
</style>
