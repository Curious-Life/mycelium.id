<!--
	AI Access settings section.

	Controls which "areas" (tool domains) the in-app chat agent may use — "full
	access to the areas you define". Fetches GET /portal/ai-access on mount, saves
	to PUT /portal/ai-access. Backed by src/portal-chat.js + src/agent/tool-domains.js.

	Note (V1): the grant is enforced at the TOOL-DOMAIN level — an unchecked area's
	tools are never exposed to the agent. Data-scope restriction (e.g. hide wealth
	rows specifically) is a later refinement; today getContext already withholds
	items you've marked sensitive.

	Local-only per-component state, mirrors VoiceSection's `card p-5` pattern.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type DomainMeta = { key: string; label: string; description: string };
	type Policy = { scopes: string[]; domains: string[]; includeSensitiveOnCloud: boolean };

	let domains = $state<DomainMeta[]>([]);
	let granted = $state<Set<string>>(new Set());
	let loading = $state(true);
	let saving = $state(false);
	let savedAt = $state(0);
	let error = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await api('/portal/ai-access');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			const data = (await res.json()) as { policy: Policy; domains: DomainMeta[] };
			domains = data.domains || [];
			granted = new Set(data.policy?.domains || []);
		} catch (e: any) {
			error = e?.message || 'Failed to load AI access settings';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function toggle(key: string) {
		const next = new Set(granted);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		granted = next;
	}

	function allOn() { granted = new Set(domains.map((d) => d.key)); }
	function allOff() { granted = new Set(); }

	async function save() {
		saving = true;
		error = null;
		try {
			const res = await api('/portal/ai-access', { method: 'PUT', body: JSON.stringify({ domains: [...granted] }) });
			if (!res.ok) throw new Error(`Failed to save (${res.status})`);
			savedAt = Date.now();
		} catch (e: any) {
			error = e?.message || 'Failed to save';
		} finally {
			saving = false;
		}
	}
</script>

<div class="card p-5">
	<div class="flex items-start justify-between gap-3">
		<div>
			<h3 class="text-base font-semibold text-[var(--color-text-primary)]">AI Access</h3>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
				Choose which areas of your vault the in-app chat agent can use. It gets full
				access within the areas you enable — and none of the tools in the areas you don't.
			</p>
		</div>
		{#if savedAt}
			<span class="text-xs text-[var(--color-accent)] whitespace-nowrap">Saved ✓</span>
		{/if}
	</div>

	{#if loading}
		<p class="mt-4 text-sm text-[var(--color-text-secondary)]">Loading…</p>
	{:else if error}
		<p class="mt-4 text-sm text-red-500">{error}</p>
	{:else}
		<div class="mt-3 flex gap-2">
			<button onclick={allOn} class="text-xs px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]">Enable all</button>
			<button onclick={allOff} class="text-xs px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]">Disable all</button>
		</div>

		<ul class="mt-4 space-y-2">
			{#each domains as d (d.key)}
				<li>
					<label class="flex items-start gap-3 cursor-pointer rounded-lg border border-[var(--color-border)] p-3 hover:border-[var(--color-accent)] transition-colors">
						<input type="checkbox" class="mt-0.5" checked={granted.has(d.key)} onchange={() => toggle(d.key)} />
						<span>
							<span class="block text-sm font-medium text-[var(--color-text-primary)]">{d.label}</span>
							<span class="block text-xs text-[var(--color-text-secondary)]">{d.description}</span>
						</span>
					</label>
				</li>
			{/each}
		</ul>

		<div class="mt-4">
			<button
				onclick={save}
				disabled={saving}
				class="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
			>
				{saving ? 'Saving…' : 'Save access'}
			</button>
		</div>
	{/if}
</div>
