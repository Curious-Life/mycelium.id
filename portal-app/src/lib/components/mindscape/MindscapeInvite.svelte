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
	let ollamaModel = $state<string | null>(null);
	let aiBusy = $state(false);
	let aiErr = $state('');
	let aiSub = $state<'anthropic' | 'openai'>('anthropic');
	let aiKey = $state('');
	$effect(() => {
		if (step === 'intelligence' && ollamaModel === null) {
			api('/portal/hardware/recommend').then(async (r) => {
				if (!r.ok) return;
				const d = await r.json();
				const installed = (d.recommendations || []).filter((m: any) => m.installed).map((m: any) => m.name);
				if (d.ollamaUp && installed.length) ollamaModel = installed[0];
				else ollamaModel = '';
			}).catch(() => { ollamaModel = ''; });
		}
	});
	async function useLocal() {
		if (!ollamaModel) return;
		aiBusy = true; aiErr = '';
		try {
			const res = await api('/portal/providers', { method: 'POST', body: JSON.stringify({ provider: 'custom', label: `Local · ${ollamaModel}`, base_url: 'http://127.0.0.1:11434/v1', model_preference: ollamaModel }) });
			if (!res.ok) throw new Error();
			aiDone = true;
		} catch { aiErr = 'Could not connect local AI.'; }
		finally { aiBusy = false; }
	}
	async function saveKey() {
		if (!aiKey.trim()) return;
		aiBusy = true; aiErr = '';
		try {
			const res = await api('/portal/providers', { method: 'POST', body: JSON.stringify({ provider: aiSub, api_key: aiKey.trim() }) });
			if (!res.ok) throw new Error();
			aiDone = true; aiKey = '';
		} catch { aiErr = 'Could not save that key.'; }
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
	<p class="welcome-subtitle">Three small steps to begin.</p>
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
		{#if ollamaModel}
			<p class="welcome-subtitle">Local AI detected — private, on your device.</p>
			<button class="invite-btn" disabled={aiBusy || aiDone} onclick={useLocal}>
				{aiDone ? 'Connected ✓' : aiBusy ? 'Connecting…' : `Use local AI · ${ollamaModel}`}
			</button>
			<p class="invite-or">or add a cloud key</p>
		{:else}
			<p class="welcome-subtitle">Add a cloud API key — it stays encrypted in your vault.</p>
		{/if}
		<div class="invite-seg">
			<button class:active={aiSub === 'anthropic'} onclick={() => (aiSub = 'anthropic')}>Anthropic</button>
			<button class:active={aiSub === 'openai'} onclick={() => (aiSub = 'openai')}>OpenAI</button>
		</div>
		<div class="invite-row">
			<input type="text" bind:value={aiKey} placeholder={aiSub === 'anthropic' ? 'sk-ant-…' : 'sk-…'} autocomplete="off" data-1p-ignore />
			<button class="invite-btn sm" disabled={!aiKey || aiBusy} onclick={saveKey}>{aiDone ? '✓' : aiBusy ? '…' : 'Save'}</button>
		</div>
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
	.invite-title { font-size: 1.5rem; font-weight: 400; letter-spacing: -0.01em; }
	.invite-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-top: 0.5rem; }
	.invite-card {
		display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
		padding: 1.1rem 0.75rem; background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px;
		color: var(--color-text-primary); cursor: pointer; text-align: center;
		transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
	}
	.invite-card:hover { transform: translateY(-2px); border-color: rgba(229, 184, 76, 0.4); background: rgba(229, 184, 76, 0.06); }
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
		border: 1px dashed rgba(255, 255, 255, 0.18); border-radius: 10px;
		font-size: 0.8rem; color: var(--color-text-secondary); cursor: pointer; text-align: center;
	}
	.invite-file:hover { border-color: rgba(229, 184, 76, 0.5); }
	.invite-file input { display: none; }
	.invite-seg { display: flex; gap: 4px; margin: 0.6rem 0 0.4rem; }
	.invite-seg button {
		padding: 4px 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
		background: none; font-size: 0.72rem; color: var(--color-text-secondary); cursor: pointer; font-family: inherit;
	}
	.invite-seg button.active { background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; border-color: transparent; }
	.invite-row { display: flex; gap: 0.5rem; margin-top: 0.4rem; }
	.invite-row input {
		flex: 1; padding: 0.5rem 0.65rem; border-radius: 7px; font-size: 0.78rem;
		border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25);
		color: var(--color-text-primary); font-family: var(--font-mono, monospace);
	}
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
