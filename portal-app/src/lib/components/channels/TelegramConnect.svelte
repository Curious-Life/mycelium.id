<!--
  TelegramConnect — the ONE primitive for connecting Telegram, used by every
  surface (Settings → Channels, onboarding guide, connections checklist, the
  mindscape invite). Design D1: every surface writes through PUT /portal/channels
  ONLY (never /portal/settings/secret), so the daemon is enabled + reloaded in the
  same call. Design D2: token-first, then pairing — the user pastes the bot token,
  messages the bot, and approves the code here; no "find your numeric Telegram id".

  Props:
    compact       dense styling for tight containers (checklist / invite)
    onconnected   called once the bot is linked (token saved + owner bound), so
                  the parent can mark its step complete
-->
<script lang="ts">
	import { api } from '$lib/api';
	import { onMount } from 'svelte';

	let { compact = false, onconnected }: { compact?: boolean; onconnected?: () => void } = $props();

	// live status (GET /portal/channels)
	let hasToken = $state(false);
	let ownerBound = $state(false);
	let daemonStatus = $state('');
	let loading = $state(true);

	// form
	let token = $state('');
	let manualId = $state('');
	let showManual = $state(false);
	let saving = $state(false);
	let err = $state('');

	// pairing (design D2 / P5)
	type Pending = { code: string; platform: string; senderName: string | null; createdAt: number };
	let pending = $state<Pending[]>([]);
	let approving = $state('');
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function loadStatus() {
		try {
			const res = await api('/portal/channels');
			if (res.ok) {
				const cs = await res.json();
				hasToken = !!cs?.telegram?.hasToken;
				ownerBound = !!cs?.telegram?.ownerId;
				daemonStatus = cs?.daemon?.status || '';
			}
		} catch { /* keep last-known */ }
		finally { loading = false; }
	}

	async function loadPending() {
		try {
			const res = await api('/portal/channels/pairing');
			if (res.ok) { const d = await res.json(); pending = d.pending || []; }
		} catch { /* transient */ }
	}
	function startPolling() {
		stopPolling();
		void loadPending();
		pollTimer = setInterval(() => { void loadPending(); void loadStatus(); }, 3000);
	}
	function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

	async function save() {
		if (!token.trim() && !hasToken) return;
		saving = true; err = '';
		try {
			const telegram: Record<string, string> = {};
			if (token.trim()) telegram.token = token.trim();
			if (showManual && manualId.trim()) telegram.ownerId = manualId.trim();
			// ONE call: sets the token (+ optional owner id), flips CHANNEL_ENABLED,
			// and reloads the daemon over loopback (portal-channels → channelSup).
			const body: Record<string, unknown> = { enabled: true };
			if (Object.keys(telegram).length) body.telegram = telegram;
			const res = await api('/portal/channels', {
				method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(`save failed (${res.status})`);
			token = '';
			await loadStatus();
			if (ownerBound) { onconnected?.(); }        // manual id path → linked immediately
			else { startPolling(); }                    // pairing path → wait for the DM + approval
		} catch { err = 'Could not save — check the token from @BotFather and try again.'; }
		finally { saving = false; }
	}

	async function approve(code: string) {
		approving = code; err = '';
		try {
			const res = await api('/portal/channels/pairing/approve', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
			});
			if (res.status === 404) { err = 'That code expired — message your bot again for a fresh one.'; await loadPending(); return; }
			if (!res.ok) throw new Error(`approve failed (${res.status})`);
			stopPolling();
			await loadStatus();
			onconnected?.();
		} catch { err = 'Could not approve that code.'; }
		finally { approving = ''; }
	}

	onMount(() => {
		(async () => {
			await loadStatus();
			// already tokened but not yet linked → we're mid-pairing; resume polling.
			if (hasToken && !ownerBound) startPolling();
		})();
		return () => stopPolling();
	});
</script>

<div class="tg-connect" class:compact>
	{#if loading}
		<p class="tg-muted">Checking…</p>
	{:else if ownerBound}
		<p class="tg-ok">✓ Telegram connected{#if daemonStatus === 'ok'} — bridge running{:else if daemonStatus === 'down'} — bridge stopped (check the token){/if}.</p>
		<button type="button" class="tg-link" onclick={() => { ownerBound = false; hasToken = false; }}>Reconnect a different bot</button>
	{:else if hasToken}
		<!-- token saved, awaiting pairing -->
		<p class="tg-step">Bot token saved. Now open Telegram, message your bot (send <code>/start</code>), and approve the code it replies with:</p>
		{#if pending.length}
			<ul class="tg-pending">
				{#each pending as p (p.code)}
					<li>
						<code class="tg-code">{p.code}</code>
						{#if p.senderName}<span class="tg-from">from {p.senderName}</span>{/if}
						<button type="button" class="tg-approve" disabled={approving === p.code} onclick={() => approve(p.code)}>
							{approving === p.code ? '…' : 'Approve'}
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="tg-muted">Waiting for you to message the bot… <span class="tg-spin" aria-hidden="true"></span></p>
		{/if}
	{:else}
		<!-- no token yet -->
		<div class="tg-field">
			<input type="text" bind:value={token} placeholder="bot token: 123456:ABC-DEF… from @BotFather"
				autocomplete="off" data-1p-ignore spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') save(); }} />
			<button type="button" class="tg-save" disabled={!token.trim() || saving} onclick={save}>
				{saving ? 'Saving…' : 'Connect'}
			</button>
		</div>
		{#if showManual}
			<div class="tg-field tg-manual">
				<input type="text" bind:value={manualId} placeholder="your Telegram id (optional): 123456789"
					autocomplete="off" data-1p-ignore spellcheck="false" />
			</div>
			<p class="tg-hint">You'll skip the message-to-pair step. Find your id via <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a>.</p>
		{:else}
			<button type="button" class="tg-link" onclick={() => (showManual = true)}>Enter my Telegram id manually instead</button>
		{/if}
	{/if}
	{#if err}<p class="tg-err">{err}</p>{/if}
</div>

<style>
	.tg-connect { display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.8rem; color: var(--color-text-primary); }
	.tg-connect.compact { gap: 0.4rem; font-size: 0.75rem; }
	.tg-field { display: flex; gap: 0.4rem; align-items: center; }
	.tg-field input {
		flex: 1; min-width: 0; padding: 0.4rem 0.55rem; border-radius: 0.4rem;
		border: 1px solid var(--color-border, rgba(128,128,128,0.3));
		background: var(--color-bg-secondary, transparent); color: var(--color-text-primary);
		font-size: inherit;
	}
	.tg-field input:focus { outline: none; border-color: var(--color-accent); }
	.tg-save, .tg-approve {
		padding: 0.4rem 0.7rem; border-radius: 0.4rem; border: none; cursor: pointer;
		background: var(--color-accent); color: var(--color-accent-contrast, #fff); font-size: inherit; white-space: nowrap;
	}
	.tg-save:disabled, .tg-approve:disabled { opacity: 0.5; cursor: default; }
	.tg-link {
		align-self: flex-start; background: none; border: none; padding: 0; cursor: pointer;
		color: var(--color-accent); font-size: 0.72rem; text-decoration: underline;
	}
	.tg-step { margin: 0; line-height: 1.4; }
	.tg-step code, .tg-code { font-family: ui-monospace, monospace; background: var(--color-bg-secondary, rgba(128,128,128,0.12)); padding: 0.05rem 0.3rem; border-radius: 0.25rem; }
	.tg-code { font-size: 0.95em; letter-spacing: 0.04em; }
	.tg-pending { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
	.tg-pending li { display: flex; align-items: center; gap: 0.5rem; }
	.tg-from { color: var(--color-text-secondary); font-size: 0.72rem; }
	.tg-muted { margin: 0; color: var(--color-text-secondary); }
	.tg-ok { margin: 0; color: var(--color-accent); }
	.tg-hint { margin: 0; color: var(--color-text-secondary); font-size: 0.7rem; line-height: 1.4; }
	.tg-hint a { color: var(--color-accent); }
	.tg-err { margin: 0; color: #ef4444; font-size: 0.72rem; }
	.tg-manual { margin-top: 0.1rem; }
	.tg-spin {
		display: inline-block; width: 0.7em; height: 0.7em; border-radius: 50%;
		border: 2px solid var(--color-text-tertiary, rgba(128,128,128,0.4)); border-top-color: var(--color-accent);
		animation: tg-spin 0.8s linear infinite; vertical-align: middle;
	}
	@keyframes tg-spin { to { transform: rotate(360deg); } }
</style>
