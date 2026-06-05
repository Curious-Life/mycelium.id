<!--
	Managed connect — claim a free <handle>.mycelium.id and connect Claude over the
	internet in one step. Calls the loopback control surface (src/remote/router.js):
	GET /api/v1/remote/managed/available, POST /api/v1/remote/connect-managed,
	POST /api/v1/remote/disconnect. The control plane provisions the relay route +
	cert delegation; the desktop shell starts the tunnel + Caddy on the NEXT launch.
	Data stays encrypted on this Mac — the relay only ever forwards ciphertext, and
	the cert key never leaves this machine.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type RemoteStatus = {
		remoteEnabled: boolean;
		publicBaseUrl: string;
		remoteMode?: string;
		publicHost?: string;
		passwordSet: boolean;
		httpListening: boolean;
	};

	let status = $state<RemoteStatus | null>(null);
	let loading = $state(true);
	let handle = $state('');
	let availability = $state<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
	let connecting = $state(false);
	let result = $state<{ host: string; connectorUrl: string } | null>(null);
	let error = $state<string | null>(null);
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let reqSeq = 0;

	const connected = $derived(status?.remoteMode === 'managed' && !!status?.publicHost);
	const connectorUrl = $derived(status?.publicBaseUrl ? status.publicBaseUrl.replace(/\/$/, '') + '/mcp' : '');

	// Turnstile bot-gate (O2). When the control plane runs Turnstile, it returns a
	// public sitekey; we embed its /turnstile page in a CROSS-ORIGIN iframe so
	// Cloudflare's script runs in the control-plane origin, never here. The widget
	// postMessages a token up; we accept it ONLY from `tsOrigin`. No sitekey ⇒ no
	// gate ⇒ no widget (Connect works as before, e.g. self-hosted / dev).
	let tsSitekey = $state<string | null>(null);
	let tsOrigin = $state<string | null>(null);
	let tsToken = $state<string | null>(null);
	let tsFrame = $state(0); // bump to remount the iframe for a fresh (single-use) token
	const tsRequired = $derived(!!tsSitekey);
	const tsSrc = $derived(
		tsSitekey && tsOrigin
			? `${tsOrigin}/turnstile?o=${encodeURIComponent(location.origin)}&_=${tsFrame}`
			: ''
	);

	function onTsMessage(e: MessageEvent) {
		if (!tsOrigin || e.origin !== tsOrigin) return; // accept only from the control-plane origin
		const d = e.data;
		if (!d || d.source !== 'mycelium-turnstile') return;
		if (typeof d.token === 'string' && d.token) {
			tsToken = d.token;
		} else if (d.error) {
			tsToken = null;
			if (d.error === 'expired') tsFrame++; // re-render for a fresh token
		}
	}
	function resetTurnstile() {
		tsToken = null;
		if (tsRequired) tsFrame++; // tokens are single-use — remount after each attempt
	}

	async function load() {
		loading = true;
		try {
			const res = await api('/api/v1/remote/status');
			status = res.ok ? ((await res.json()) as RemoteStatus) : null;
		} catch {
			status = null;
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		load();
		// Best-effort: discover whether the control plane gates on Turnstile.
		(async () => {
			try {
				const res = await api('/api/v1/remote/managed/turnstile');
				const d = await res.json().catch(() => ({}));
				if (res.ok && typeof d.sitekey === 'string' && d.sitekey && typeof d.origin === 'string') {
					tsSitekey = d.sitekey;
					tsOrigin = d.origin;
				}
			} catch {
				/* no widget — Connect stays enabled (gate off / unreachable) */
			}
		})();
		window.addEventListener('message', onTsMessage);
		return () => window.removeEventListener('message', onTsMessage);
	});

	function onHandleInput() {
		availability = 'idle';
		result = null;
		error = null;
		if (debounce) clearTimeout(debounce);
		const h = handle.trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(h)) {
			if (h) availability = 'invalid';
			return;
		}
		availability = 'checking';
		const seq = ++reqSeq;
		debounce = setTimeout(async () => {
			try {
				const res = await api(`/api/v1/remote/managed/available?handle=${encodeURIComponent(h)}`);
				const data = await res.json().catch(() => ({}));
				if (seq !== reqSeq) return; // a newer keystroke superseded this response
				availability = res.ok && data.available ? 'available' : 'taken';
			} catch {
				if (seq === reqSeq) availability = 'idle';
			}
		}, 400);
	}

	async function connect() {
		connecting = true;
		error = null;
		result = null;
		try {
			const body: { handle: string; turnstileToken?: string } = { handle: handle.trim().toLowerCase() };
			if (tsRequired && tsToken) body.turnstileToken = tsToken;
			const res = await api('/api/v1/remote/connect-managed', {
				method: 'POST',
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data.ok) throw new Error(data.error || 'Could not connect');
			result = { host: data.host, connectorUrl: data.connectorUrl };
			await load();
		} catch (e: any) {
			error = e?.message || 'Could not connect';
		} finally {
			connecting = false;
			resetTurnstile(); // the token is single-use whether we succeeded or failed
		}
	}

	async function disconnect() {
		connecting = true;
		error = null;
		try {
			await api('/api/v1/remote/disconnect', { method: 'POST' });
			result = null;
			await load();
		} catch (e: any) {
			error = e?.message || 'Could not disconnect';
		} finally {
			connecting = false;
		}
	}

	const inputCls =
		'flex-1 px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none';
	const btnCls =
		'text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer disabled:opacity-50';
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Get your address (mycelium.id)</h2>

	{#if loading}
		<div class="text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
	{:else}
		<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
			Claim a free <span class="font-mono">handle.mycelium.id</span> and connect Claude (mobile/web) in one step. Your data stays encrypted on this Mac — the relay only forwards ciphertext, and we never hold your keys or your cert.
		</p>

		{#if connected}
			<div class="text-xs text-green-400 mb-3 p-2 rounded bg-green-500/10">Connected as <span class="font-mono">{status?.publicHost}</span></div>
			{#if connectorUrl}
				<p class="text-[10px] text-[var(--color-text-tertiary)]">Add this in Claude → Connectors: <span class="font-mono text-[var(--color-text-secondary)]">{connectorUrl}</span></p>
			{/if}
			{#if status && !status.httpListening}
				<div class="text-xs text-amber-400 mt-2 p-2 rounded bg-amber-500/10">Restart the app to start the tunnel.</div>
			{/if}
			<button onclick={disconnect} disabled={connecting} class="mt-3 text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] cursor-pointer disabled:opacity-50">Disconnect</button>
		{:else}
			{#if !status?.passwordSet}
				<div class="text-xs text-amber-400 mb-3 p-2 rounded bg-amber-500/10">Set an operator password (below) first — it's the gate Claude authenticates against.</div>
			{/if}
			<div class="flex gap-2 items-center">
				<input bind:value={handle} oninput={onHandleInput} placeholder="your-handle" autocomplete="off" spellcheck="false" class={inputCls} />
				<span class="text-xs text-[var(--color-text-tertiary)] font-mono">.mycelium.id</span>
				<button onclick={connect} disabled={connecting || availability !== 'available' || !status?.passwordSet || (tsRequired && !tsToken)} class={btnCls}>{connecting ? 'Connecting…' : 'Connect'}</button>
			</div>
			<div class="text-[10px] mt-1 h-4">
				{#if availability === 'checking'}<span class="text-[var(--color-text-tertiary)]">checking…</span>
				{:else if availability === 'available'}<span class="text-green-400">✓ available</span>
				{:else if availability === 'taken'}<span class="text-red-400">taken</span>
				{:else if availability === 'invalid'}<span class="text-amber-400">2–32 chars: a–z, 0–9, dashes</span>{/if}
			</div>
			{#if tsRequired && tsSrc}
				<!-- Cross-origin: Cloudflare's script runs in the control-plane origin, not in this vault portal. -->
				<div class="mt-2">
					<iframe src={tsSrc} title="Bot check" class="w-[300px] h-[72px] border-0 block" referrerpolicy="no-referrer"></iframe>
					{#if !tsToken}<p class="text-[10px] text-[var(--color-text-tertiary)] mt-1">Complete the bot check to enable Connect.</p>{/if}
				</div>
			{/if}
		{/if}

		{#if result}
			<div class="text-xs text-green-400 mt-3 p-2 rounded bg-green-500/10">Address ready: <span class="font-mono">{result.connectorUrl}</span> — restart the app to go live.</div>
		{/if}
		{#if error}<div class="text-xs text-red-400 mt-2">{error}</div>{/if}
	{/if}
</section>
