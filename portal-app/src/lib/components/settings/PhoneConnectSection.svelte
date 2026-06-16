<!--
	Connect a phone — the one-stop panel for setting up the native Mycelium app.
	Shows the two values the app asks for (Server address + Access token) with copy
	buttons, and guides the secure-transport setup. The app authenticates with the
	static Bearer (NOT the operator password). Reuses GET /api/v1/portal/phone-connect
	(bearer + best server address; Tailscale-HTTPS preferred, relay fallback).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type PhoneConnect = {
		bearer: string;
		tlsConfigured: boolean;
		tlsPort: number;
		tailscaleHost: string | null;
		tailscaleUrl: string | null;
		relayUrl: string | null;
		recommended: string | null;
	};

	let data = $state<PhoneConnect | null>(null);
	let loading = $state(true);
	let copied = $state<string | null>(null);
	let revealed = $state(false);

	async function load() {
		loading = true;
		try {
			const res = await api('/api/v1/portal/phone-connect');
			if (res.ok) data = await res.json();
		} catch { /* vault not ready — panel shows guidance */ }
		loading = false;
	}
	onMount(load);

	async function copy(label: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = label;
			setTimeout(() => { if (copied === label) copied = null; }, 1200);
		} catch { /* clipboard blocked */ }
	}

	const masked = $derived(data?.bearer ? `${data.bearer.slice(0, 6)}…${data.bearer.slice(-4)}` : '');
	// Secure direct path is live only when TLS is on AND the tailnet name resolves.
	const secureLive = $derived(Boolean(data?.tlsConfigured && data?.tailscaleUrl));

	const rowCls = 'flex items-center gap-2 text-xs p-2 rounded bg-[var(--color-elevated)]';
	const copyBtn = 'ml-auto text-[10px] text-aurum cursor-pointer shrink-0';
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Connect your phone</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		Open the <span class="text-[var(--color-text-secondary)]">Mycelium</span> app on your iPhone and enter the two values below.
		The app signs in with the <span class="text-[var(--color-text-secondary)]">access token</span> — not your remote-access password.
	</p>

	{#if loading}
		<div class="text-xs text-[var(--color-text-tertiary)]">Loading…</div>
	{:else}
		<div class="mb-4 space-y-2">
			<!-- Server address -->
			<div class={rowCls}>
				<span class="text-[var(--color-text-tertiary)] w-32 shrink-0">Server address</span>
				{#if data?.recommended}
					<span class="font-mono text-[var(--color-text-primary)] truncate">{data.recommended}</span>
					<button class={copyBtn} onclick={() => copy('addr', data!.recommended!)}>{copied === 'addr' ? '✓ copied' : 'Copy'}</button>
				{:else}
					<span class="text-[var(--color-text-tertiary)] italic">not reachable yet — see below</span>
				{/if}
			</div>
			<!-- Access token (masked; reveal to verify) -->
			<div class={rowCls}>
				<span class="text-[var(--color-text-tertiary)] w-32 shrink-0">Access token</span>
				<span class="font-mono text-[var(--color-text-primary)] truncate">{revealed ? data?.bearer : masked}</span>
				<button class="text-[10px] text-[var(--color-text-tertiary)] cursor-pointer shrink-0" onclick={() => (revealed = !revealed)}>{revealed ? 'Hide' : 'Reveal'}</button>
				<button class={copyBtn} onclick={() => copy('tok', data?.bearer ?? '')}>{copied === 'tok' ? '✓ copied' : 'Copy'}</button>
			</div>
		</div>

		<!-- Transport status + guidance -->
		{#if secureLive}
			<div class="text-[11px] text-[var(--color-text-tertiary)] p-3 rounded border border-[var(--color-border)] space-y-1">
				<p><span class="text-aurum">✓ Secure connection ready.</span> Your phone reaches this Mac directly over Tailscale with end-to-end TLS — nothing leaves your private network.</p>
			</div>
		{:else}
			<div class="text-[11px] text-[var(--color-text-tertiary)] p-3 rounded border border-[var(--color-border)] space-y-1.5">
				<p class="text-[var(--color-text-secondary)]">To enable a secure phone connection over Tailscale:</p>
				<ol class="list-decimal ml-4 space-y-1">
					<li>Install the <span class="font-mono">Tailscale</span> app on this Mac and your phone (same account).</li>
					<li>In the Tailscale admin, enable <span class="text-[var(--color-text-secondary)]">MagicDNS</span> + <span class="text-[var(--color-text-secondary)]">HTTPS Certificates</span>.</li>
					<li>Restart Mycelium with a TLS certificate for this machine{#if data?.tailscaleHost}&nbsp;(<span class="font-mono">{data.tailscaleHost}</span>){/if}.</li>
				</ol>
				{#if data?.tailscaleHost && !data?.tlsConfigured}
					<p>Detected this machine as <span class="font-mono text-[var(--color-text-primary)]">{data.tailscaleHost}</span> — once TLS is on, your phone address will be <span class="font-mono">https://{data.tailscaleHost}:{data.tlsPort}</span>.</p>
				{/if}
				{#if data?.relayUrl}
					<p>Or use your relay address: <span class="font-mono text-[var(--color-text-primary)]">{data.relayUrl}</span> <button class={copyBtn + ' ml-0'} onclick={() => copy('relay', data!.relayUrl!)}>{copied === 'relay' ? '✓ copied' : 'Copy'}</button></p>
				{/if}
			</div>
		{/if}

		<p class="text-[10px] text-[var(--color-text-tertiary)] mt-3">
			Keep the access token private — it grants full access to your vault. It never reaches the recovery key or account settings (those stay on this Mac only).
		</p>
	{/if}
</section>
