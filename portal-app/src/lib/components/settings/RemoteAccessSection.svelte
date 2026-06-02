<!--
	Remote Access settings section (remote-connect Phase 2).

	Lets the operator connect Claude (mobile/web) — or any MCP client — to this
	vault over the internet. Pure HTTP to the loopback control surface
	(src/remote/router.js): GET /api/v1/remote/status, POST /api/v1/remote/password,
	POST /api/v1/remote/config. No Tauri IPC — the desktop shell reads remoteEnabled
	from remote.json at startup and owns the OAuth (--http) child (see
	src-tauri/src/main.rs); a toggle therefore takes effect on the NEXT app launch.

	Visual style mirrors VoiceSection / the Linear card: same `card p-5` wrapper,
	heading, input/button utilities. State is local to this component.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type RemoteStatus = {
		remoteEnabled: boolean;
		publicBaseUrl: string;
		operatorEmail: string;
		passwordSet: boolean;
		httpListening: boolean;
	};

	let status = $state<RemoteStatus | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Password form (the OAuth gate). Plaintext leaves the browser once; the
	// server hands it to better-auth, which stores only a hash.
	let newPassword = $state('');
	let pwSaving = $state(false);
	let pwMsg = $state<string | null>(null);
	let pwErr = $state<string | null>(null);

	// Config form (non-secret): the public HTTPS URL of your tunnel + the toggle.
	let baseUrl = $state('');
	let cfgSaving = $state(false);
	let cfgErr = $state<string | null>(null);

	const connectorUrl = $derived(status?.publicBaseUrl ? status.publicBaseUrl.replace(/\/$/, '') + '/mcp' : '');

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await api('/api/v1/remote/status');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			status = (await res.json()) as RemoteStatus;
			baseUrl = status.publicBaseUrl ?? '';
		} catch (e: any) {
			error = e?.message || 'Failed to load remote-access status';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function savePassword(e: Event) {
		e.preventDefault();
		pwSaving = true; pwMsg = null; pwErr = null;
		try {
			const res = await api('/api/v1/remote/password', {
				method: 'POST',
				body: JSON.stringify({ password: newPassword }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to set password');
			newPassword = '';
			pwMsg = 'Password set. This is what Claude asks for when you connect.';
			await load();
		} catch (e: any) {
			pwErr = e?.message || 'Failed to set password';
		} finally {
			pwSaving = false;
		}
	}

	async function saveConfig(patch: Record<string, unknown>) {
		cfgSaving = true; cfgErr = null;
		try {
			const res = await api('/api/v1/remote/config', { method: 'POST', body: JSON.stringify(patch) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to save');
			await load();
		} catch (e: any) {
			cfgErr = e?.message || 'Failed to save config';
		} finally {
			cfgSaving = false;
		}
	}

	const saveBaseUrl = () => saveConfig({ publicBaseUrl: baseUrl.trim() });
	const toggleEnabled = (on: boolean) => saveConfig({ remoteEnabled: on });

	const inputCls =
		'w-full px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none';
	const btnCls =
		'text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer disabled:opacity-50';
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Remote Access</h2>

	{#if loading}
		<div class="text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
	{:else if error}
		<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>
	{:else if status}
		<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
			Connect Claude (or any MCP client) to this vault over the internet. Your data stays encrypted on this Mac — the client reaches in through a password-gated, TLS tunnel. The app must be running and awake.
		</p>

		<!-- Live state -->
		<div class="flex flex-wrap gap-2 mb-4 text-[10px] uppercase tracking-wider">
			<span class="px-2 py-1 rounded {status.remoteEnabled ? 'bg-green-500/15 text-green-400' : 'bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]'}">{status.remoteEnabled ? 'Enabled' : 'Disabled'}</span>
			<span class="px-2 py-1 rounded {status.httpListening ? 'bg-green-500/15 text-green-400' : 'bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]'}">{status.httpListening ? 'Running :4711' : 'Not running'}</span>
			<span class="px-2 py-1 rounded {status.passwordSet ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}">{status.passwordSet ? 'Password set' : 'No password yet'}</span>
		</div>

		{#if status.remoteEnabled && !status.httpListening}
			<div class="text-xs text-amber-400 mb-4 p-2 rounded bg-amber-500/10">Enabled — restart the app to start the remote server.</div>
		{/if}

		<!-- 1. Password (the gate) -->
		<form onsubmit={savePassword} class="mb-5 space-y-2">
			<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]" for="remote-pw">{status.passwordSet ? 'Operator password (set)' : 'Set operator password'}</label>
			<input id="remote-pw" type="password" bind:value={newPassword} placeholder="at least 12 characters" autocomplete="new-password" class={inputCls} />
			<div class="flex items-center gap-3">
				<button type="submit" disabled={pwSaving || newPassword.length < 12} class={btnCls}>{pwSaving ? 'Saving…' : 'Save password'}</button>
				<span class="text-[10px] text-[var(--color-text-tertiary)]">Sign-in email: <span class="font-mono">{status.operatorEmail}</span></span>
			</div>
			{#if pwMsg}<div class="text-xs text-green-400">{pwMsg}</div>{/if}
			{#if pwErr}<div class="text-xs text-red-400">{pwErr}</div>{/if}
		</form>

		<!-- 2. Public URL (your tunnel) -->
		<div class="mb-5 space-y-2">
			<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]" for="remote-url">Public URL (your tunnel's HTTPS address)</label>
			<div class="flex gap-2">
				<input id="remote-url" type="url" bind:value={baseUrl} placeholder="https://mycelium.yourdomain.com" class={inputCls} />
				<button onclick={saveBaseUrl} disabled={cfgSaving} class={btnCls}>Save</button>
			</div>
			{#if connectorUrl}
				<p class="text-[10px] text-[var(--color-text-tertiary)]">Add this in Claude → Connectors: <span class="font-mono text-[var(--color-text-secondary)]">{connectorUrl}</span></p>
			{/if}
		</div>

		<!-- 3. Toggle -->
		<label class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
			<input type="checkbox" checked={status.remoteEnabled} disabled={cfgSaving || !status.passwordSet || !status.publicBaseUrl}
				onchange={(e) => toggleEnabled((e.target as HTMLInputElement).checked)} class="accent-[var(--color-accent)]" />
			Enable remote access (starts the OAuth server on next launch)
		</label>
		{#if !status.passwordSet || !status.publicBaseUrl}
			<p class="text-[10px] text-[var(--color-text-tertiary)] mt-1">Set a password and a public URL first.</p>
		{/if}
		{#if cfgErr}<div class="text-xs text-red-400 mt-2">{cfgErr}</div>{/if}
	{/if}
</section>
