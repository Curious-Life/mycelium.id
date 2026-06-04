<!--
	Connect Your AI — the one-stop "how do I plug a client into Mycelium" panel.
	Shows the local MCP + model-gateway endpoints (copy-paste), the static-bearer
	how-to, and (when a remote handle is claimed) the public URLs. Links to the
	full per-client guide in docs/CONNECT-YOUR-AI.md. Read-only: it reuses the
	existing /api/v1/remote/status for the public base URL — no new backend.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	let publicBaseUrl = $state<string | null>(null);
	let copied = $state<string | null>(null);

	const LOCAL = 'http://127.0.0.1:4711';
	const MODEL = 'mycelium-auto';
	const EMBED = 'nomic-embed-text-v1.5';

	const remoteBase = $derived(publicBaseUrl ? publicBaseUrl.replace(/\/$/, '') : null);

	async function loadRemote() {
		try {
			const res = await api('/api/v1/remote/status');
			if (res.ok) { const s = await res.json(); publicBaseUrl = s?.publicBaseUrl || null; }
		} catch { /* remote not configured — local-only is fine */ }
	}
	onMount(loadRemote);

	async function copy(label: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = label;
			setTimeout(() => { if (copied === label) copied = null; }, 1200);
		} catch { /* clipboard blocked */ }
	}

	type Row = { label: string; value: string };
	const localRows = $derived<Row[]>([
		{ label: 'Memory (MCP)', value: `${LOCAL}/mcp` },
		{ label: 'Model gateway (base URL)', value: `${LOCAL}/v1` },
		{ label: 'Model id', value: MODEL },
		{ label: 'Embeddings model', value: EMBED }
	]);
	const remoteRows = $derived<Row[]>(remoteBase ? [
		{ label: 'Memory (MCP)', value: `${remoteBase}/mcp` },
		{ label: 'Model gateway (base URL)', value: `${remoteBase}/v1` }
	] : []);

	const rowCls = 'flex items-center gap-2 text-xs p-2 rounded bg-[var(--color-elevated)]';
	const copyBtn = 'ml-auto text-[10px] text-aurum cursor-pointer shrink-0';
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Connect your AI</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		Point any AI client at Mycelium — <span class="text-[var(--color-text-secondary)]">memory</span> over MCP and <span class="text-[var(--color-text-secondary)]">model</span> over the OpenAI-compatible gateway. Full per-client setup lives in <span class="font-mono">docs/CONNECT-YOUR-AI.md</span>.
	</p>

	<div class="mb-4 space-y-2">
		<div class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]">On this machine</div>
		{#each localRows as r (r.label)}
			<div class={rowCls}>
				<span class="text-[var(--color-text-tertiary)] w-40 shrink-0">{r.label}</span>
				<span class="font-mono text-[var(--color-text-primary)] truncate">{r.value}</span>
				<button class={copyBtn} onclick={() => copy(r.label, r.value)}>{copied === r.label ? '✓ copied' : 'Copy'}</button>
			</div>
		{/each}
	</div>

	{#if remoteRows.length}
		<div class="mb-4 space-y-2">
			<div class="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Over the internet (your relay handle)</div>
			{#each remoteRows as r (r.label)}
				<div class={rowCls}>
					<span class="text-[var(--color-text-tertiary)] w-40 shrink-0">{r.label}</span>
					<span class="font-mono text-[var(--color-text-primary)] truncate">{r.value}</span>
					<button class={copyBtn} onclick={() => copy(r.label, r.value)}>{copied === r.label ? '✓ copied' : 'Copy'}</button>
				</div>
			{/each}
		</div>
	{/if}

	<div class="text-[11px] text-[var(--color-text-tertiary)] space-y-1.5 p-3 rounded border border-[var(--color-border)]">
		<p>Any harness needs three things: the <span class="text-[var(--color-text-secondary)]">base URL</span> above, the model <span class="font-mono text-[var(--color-text-primary)]">{MODEL}</span> (routes to your active provider in <span class="text-aurum">Intelligence</span>), and an API key.</p>
		<p>For a local tool, set a copy-paste token, then restart the gateway:</p>
		<pre class="font-mono text-[10px] bg-[var(--color-bg)] p-2 rounded overflow-x-auto">export MYCELIUM_MCP_BEARER="$(openssl rand -hex 32)"
npm run start:http</pre>
		<p>Use that token as the API key / Bearer. Browser-based MCP clients can use OAuth instead — no token needed.</p>
	</div>
</section>
