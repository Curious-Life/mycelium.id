<!--
	The whisper download rail — MOVED out of AISettings under the Intelligence redesign
	(Part I §9: "its download rail belongs to Transcription; the assignment is the function
	row"). Mounted by IntelligenceScreen's `whisper` branch, so the rail renders under the
	Transcription function row — one home for the fact, in both hosts (Settings + onboarding).

	Own catalog + route preserved verbatim (§3.10d "no third catalog"): GET
	/portal/transcription/status for health + catalog, POST /portal/transcription/download to
	choose — the download route itself persists the choice (transcribeModel), which is why
	choosing here IS the approval (§3.10c) and no other surface writes it.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type WhisperCat = { model: string; label: string; sizeMB: number; blurb: string; recommended?: boolean };
	let trans = $state<{ health: any; model: string | null; catalog: WhisperCat[] } | null>(null);
	let transErr = $state<string | null>(null);
	let transBusy = $state(false);
	let transStarting = $state<string | null>(null); // model whose download we just kicked off (instant feedback)
	let transPoll: ReturnType<typeof setInterval> | null = null;
	let transRetrying = $state(false);

	// Retry connection — a crash-looping / unreachable transcription engine (down/error/
	// unavailable/deps_missing) is a fault the owner could not previously act on. Poke the
	// supervisor's own retry route and re-read; never claim it recovered — loadTranscription()
	// below re-renders whatever the re-read health actually is (QA6 P1 §1).
	async function retryTranscription() {
		if (transRetrying) return;
		transRetrying = true; transErr = null;
		try { await api('/portal/transcription/retry', { method: 'POST', body: JSON.stringify({}) }); }
		catch { /* best-effort — the re-read is the answer */ }
		await loadTranscription();
		transRetrying = false;
	}

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
		loadTranscription();
		return () => { if (transPoll) clearInterval(transPoll); };
	});
</script>

<div class="trans-rail">
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
			<button class="ghost-btn" data-testid="trans-retry" disabled={transRetrying} onclick={retryTranscription}>{transRetrying ? 'Checking…' : 'Retry connection'}</button>
		{:else if trans.health?.status === 'error' || trans.health?.status === 'down' || trans.health?.status === 'unavailable'}
			<!-- `down` was MISSING from this chain once, so a crash-looping engine fell through to
			     the {:else} and told the owner to DOWNLOAD a model they already have — discarding
			     the honest message for marketing copy (independent review, 2026-07-16). `message`
			     first here: for `down` it is the sentence written for the owner. -->
			<div class="err-box">{trans.health?.message || trans.health?.detail || 'The transcription model failed.'}</div>
			<button class="ghost-btn" data-testid="trans-retry" disabled={transRetrying} onclick={retryTranscription}>{transRetrying ? 'Checking…' : 'Retry connection'}</button>
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

<style>
	.trans-rail { display: flex; flex-direction: column; gap: 0.5rem; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; }
	.muted-xs { color: var(--color-text-tertiary); font-size: 0.7rem; line-height: 1.4; }
	.pulse { animation: pulse 1.6s ease-in-out infinite; }
	@keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
	.err-box { color: #f87171; font-size: 0.78rem; padding: 0.5rem 0.7rem; border-radius: 8px; background: rgba(248,113,113,0.1); }
	.note-amber { color: #d9a441; font-size: 0.7rem; }
	.mono { font-family: var(--font-mono, monospace); color: var(--color-text-primary); font-size: 0.76rem; }
	.chip { font-size: 0.62rem; padding: 2px 7px; border-radius: 9px; white-space: nowrap; flex-shrink: 0; }
	.j-green { background: rgba(74,222,128,0.14); color: #6ee7a8; }
	.ghost-btn { font-size: 0.76rem; padding: 0.5rem 0.9rem; border-radius: 9px; border: 1px solid var(--color-border); background: none; color: var(--color-text-secondary); cursor: pointer; align-self: flex-start; }
	.ghost-btn:hover { border-color: var(--color-accent-aurum, #e5b84c); }
	.ghost-btn:disabled { opacity: 0.5; cursor: default; }
	.trans-status { font-size: 0.8rem; color: var(--color-text-primary); }
	.trans-progress { display: flex; flex-direction: column; gap: 0.4rem; }
	.trans-bar { height: 5px; border-radius: 3px; background: var(--glass-input-bg, rgba(255,255,255,0.06)); overflow: hidden; }
	.trans-fill { height: 100%; border-radius: 3px; background: var(--color-accent-aurum, #e5b84c); transition: width 0.5s ease; }
	.trans-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.6rem; }
	.trans-card { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.75rem 0.9rem; border-radius: 12px; border: 1px solid var(--glass-border, rgba(255,255,255,0.07)); background: var(--glass-card-bg, rgba(255,255,255,0.025)); }
	.trans-card-head { display: flex; align-items: center; gap: 0.5rem; justify-content: space-between; }
	.trans-name { font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); }
	.trans-inuse { font-size: 0.74rem; color: var(--color-accent-aurum, #e5b84c); }
</style>
