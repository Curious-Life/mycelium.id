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

	// Search (Phase 2.1): a keyword filter pushed to the server (?q). Single bounded
	// pass — no "load older" while searching; `truncated` flags more than the cap.
	let query = $state('');
	let truncated = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	const searching = $derived(query.trim().length > 0);

	onMount(() => {
		// Block first paint ONLY on the feed. agents + identity are label side-data
		// (speaker names/avatars) that populate agentMap/owner reactively as they
		// arrive, so a slow /agents or /identity must never delay the river render.
		loadFeed().finally(() => { loading = false; });
		loadAgents();
		loadIdentity();
	});

	function onSearchInput(v: string) {
		query = v;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(async () => { loading = true; await loadFeed(); loading = false; }, 250);
	}
	function clearSearch() {
		query = '';
		if (searchTimer) clearTimeout(searchTimer);
		loading = true;
		loadFeed().then(() => (loading = false));
	}

	async function loadFeed(before?: string) {
		const params = new URLSearchParams({ limit: '40' });
		if (before) params.set('before', before);
		const q = query.trim();
		if (q) params.set('q', q);
		try {
			const res = await api(`/portal/streams?${params}`);
			if (!res.ok) return;
			const data = await res.json();
			const batch: StreamItem[] = data.items || [];
			items = before ? [...items, ...batch] : batch;
			nextCursor = data.nextCursor ?? null;
			truncated = Boolean(data.truncated);
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
	<div class="border-b border-[var(--color-border)] px-4 sm:px-6 py-2.5 flex-shrink-0 flex items-center gap-3">
		<div class="flex items-center gap-2 flex-1 min-w-0 max-w-md bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-3 py-1.5 focus-within:border-[var(--color-text-tertiary)] transition-colors">
			<svg class="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-text-tertiary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
			<input
				type="search"
				value={query}
				oninput={(e) => onSearchInput((e.target as HTMLInputElement).value)}
				placeholder="Search your streams…"
				aria-label="Search streams"
				class="flex-1 min-w-0 bg-transparent border-0 outline-none text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]"
			/>
			{#if searching}
				<button class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] flex-shrink-0" aria-label="Clear search" onclick={clearSearch}>✕</button>
			{/if}
		</div>
		<span class="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
			{#if searching}
				{filtered.length}{truncated ? '+' : ''} {filtered.length === 1 ? 'result' : 'results'} · recent
			{:else}
				{filtered.length} {filtered.length === 1 ? 'item' : 'items'}{#if externalSource}{' '}in {externalSource}{/if}
			{/if}
		</span>
	</div>

	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		{#if loading}
			<!-- Skeleton: render the river's shape immediately so a Streams click feels
			     instant, instead of a blank panel while the feed fetch is in flight. -->
			<div class="max-w-3xl mx-auto" role="status" aria-live="polite" aria-label="Loading your streams">
				<div class="section-marker text-xs my-4"><span class="inline-block h-3 w-24 rounded bg-[var(--color-border)] animate-pulse align-middle"></span></div>
				<div class="space-y-3">
					{#each Array.from({ length: 6 }) as _, i (i)}
						<div class="flex gap-3 animate-pulse" style="animation-delay: {i * 70}ms">
							<div class="h-8 w-8 rounded-full bg-[var(--color-border)] shrink-0"></div>
							<div class="flex-1 space-y-2 py-1">
								<div class="h-3 rounded bg-[var(--color-border)]" style="width: {[55, 80, 42, 68, 50, 73][i]}%"></div>
								<div class="h-3 rounded bg-[var(--color-border)]" style="width: {[88, 46, 72, 38, 84, 60][i]}%"></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else if filtered.length === 0}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-center">
					<p class="text-[var(--color-text-tertiary)] text-sm">{searching ? `No recent matches for “${query.trim()}”` : externalSource ? `Nothing from ${externalSource} in view` : 'Nothing flowing in yet'}</p>
					<p class="text-[var(--color-text-tertiary)] text-xs mt-1">{searching ? 'Search covers your recent streams' : 'Everything entering your vault appears here'}</p>
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
