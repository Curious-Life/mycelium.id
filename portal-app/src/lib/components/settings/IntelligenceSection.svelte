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
	onMount(load);

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
