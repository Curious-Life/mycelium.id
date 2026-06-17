<script lang="ts">
	// The unified Streams river: messages + documents + health + tasks interleaved
	// by time, fed by GET /portal/streams. Replaces the messages-only TimelineView
	// in the Stream facet. Owns date-grouping, the image lightbox, cursor "load
	// older", and the spectrum source filter (client-side; server push-down is a
	// follow-up). MessageRow preserves the rich legacy rendering.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { formatDateHeader, type AgentInfo, type OwnerIdentity } from '$lib/timeline/utils';
	import { canonicalClientSource } from '$lib/streams/sources';
	import MessageRow from './stream-rows/MessageRow.svelte';
	import DocumentRow from './stream-rows/DocumentRow.svelte';
	import HealthRow from './stream-rows/HealthRow.svelte';
	import TaskRow from './stream-rows/TaskRow.svelte';

	interface StreamItem {
		type: 'message' | 'document' | 'health' | 'task';
		id: string; source: string; createdAt: string;
		message?: any; title?: string; preview?: string; path?: string;
		date?: string; status?: string; priority?: string; dueDate?: string; completedAt?: string;
	}

	// externalSource = a canonical source key from the spectrum (null = all).
	let { externalSource = null }: { externalSource?: string | null } = $props();

	let items = $state<StreamItem[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let expandedImage = $state<string | null>(null);
	let agentMap = $state<Map<string, AgentInfo>>(new Map());
	let owner = $state<OwnerIdentity>({ ownerName: null, ownerTelegramId: null, ownerDiscordId: null });

	onMount(async () => {
		await Promise.all([loadFeed(), loadAgents(), loadIdentity()]);
		loading = false;
	});

	async function loadFeed(before?: string) {
		const params = new URLSearchParams({ limit: '40' });
		if (before) params.set('before', before);
		try {
			const res = await api(`/portal/streams?${params}`);
			if (!res.ok) return;
			const data = await res.json();
			const batch: StreamItem[] = data.items || [];
			items = before ? [...items, ...batch] : batch;
			nextCursor = data.nextCursor ?? null;
		} catch { /* non-fatal */ }
	}
	async function loadAgents() {
		try {
			const res = await api('/portal/agents');
			if (!res.ok) return;
			const data = await res.json();
			const next = new Map<string, AgentInfo>();
			for (const a of (data.agents || [])) {
				next.set(a.id, { id: a.id, name: a.name || a.defaultName || a.id, color: a.color || null, avatarEmoji: a.avatarEmoji || null });
			}
			agentMap = next;
		} catch { /* non-fatal */ }
	}
	async function loadIdentity() {
		try {
			const res = await api('/portal/identity');
			if (!res.ok) return;
			const data = await res.json();
			owner = { ownerName: data.ownerName ?? null, ownerTelegramId: data.ownerTelegramId ?? null, ownerDiscordId: data.ownerDiscordId ?? null };
		} catch { /* non-fatal */ }
	}
	async function loadMore() {
		if (loadingMore || !nextCursor) return;
		loadingMore = true;
		await loadFeed(nextCursor);
		loadingMore = false;
	}

	const filtered = $derived(
		externalSource ? items.filter((it) => canonicalClientSource(it.source) === externalSource) : items,
	);

	// Group by calendar day (same scheme as the legacy timeline).
	const grouped = $derived.by(() => {
		const groups: Array<{ date: string; label: string; items: StreamItem[] }> = [];
		let cur = '';
		for (const it of filtered) {
			const d = new Date(it.createdAt);
			const key = d.toDateString();
			if (key !== cur) { cur = key; groups.push({ date: key, label: formatDateHeader(d), items: [] }); }
			groups[groups.length - 1].items.push(it);
		}
		return groups;
	});
</script>

{#if expandedImage}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 cursor-pointer"
		onclick={() => expandedImage = null}
		onkeydown={(e) => { if (e.key === 'Escape') expandedImage = null; }}
		role="dialog"
		tabindex="-1"
	>
		<img src={expandedImage} alt="" class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
	</div>
{/if}

<div class="flex flex-col h-full">
	{#if filtered.length > 0}
		<div class="border-b border-[var(--color-border)] px-4 sm:px-6 py-2.5 flex-shrink-0">
			<span class="text-xs text-[var(--color-text-tertiary)]">
				{filtered.length} {filtered.length === 1 ? 'item' : 'items'}{#if externalSource}{' '}in {externalSource}{/if}
			</span>
		</div>
	{/if}

	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		{#if loading}
			<div class="flex items-center justify-center min-h-[200px]" role="status" aria-live="polite">
				<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Reading your streams…</div>
			</div>
		{:else if filtered.length === 0}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-center">
					<p class="text-[var(--color-text-tertiary)] text-sm">{externalSource ? `Nothing from ${externalSource} in view` : 'Nothing flowing in yet'}</p>
					<p class="text-[var(--color-text-tertiary)] text-xs mt-1">Everything entering your vault appears here</p>
				</div>
			</div>
		{:else}
			<div class="max-w-3xl mx-auto">
				{#each grouped as group (group.date)}
					<div class="section-marker text-xs my-4"><span>{group.label}</span></div>
					<div class="space-y-1">
						{#each group.items as item (item.id)}
							{#if item.type === 'message'}
								<MessageRow msg={item.message} {agentMap} {owner} onImage={(url) => expandedImage = url} />
							{:else if item.type === 'document'}
								<DocumentRow {item} />
							{:else if item.type === 'health'}
								<HealthRow {item} />
							{:else if item.type === 'task'}
								<TaskRow {item} />
							{/if}
						{/each}
					</div>
				{/each}

				{#if nextCursor}
					<div class="flex justify-center py-6">
						<button
							onclick={loadMore}
							disabled={loadingMore}
							class="btn-ghost text-xs px-4 py-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors"
						>
							{loadingMore ? 'Loading…' : 'Load older'}
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
