<script lang="ts">
	// Agents → Overview: the personal agent at a glance — identity, last activity, its
	// capability scopes, the channel-write toggle (vault writes from DMs, ON by default),
	// and its channels + connections. Populates the previously-empty overview.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { goto } from '$app/navigation';

	let { name = 'Mycelium', color = 'var(--color-accent-amethyst)' }: { name?: string; color?: string } = $props();

	let identity = $state<{ name: string; channelWrite: boolean; scopes: string[]; allScopes: string[] } | null>(null);
	let lastActivity = $state<{ who: string; where: string; ts: string; status: string } | null>(null);
	let cyclesCount = $state(0);
	let channels = $state<{ telegram: boolean; discord: boolean }>({ telegram: false, discord: false });
	let saving = $state(false);
	let loading = $state(true);

	const SCOPE_LABELS: Record<string, string> = { personal: 'Personal', org: 'Work', wealth: 'Finances', health: 'Health' };

	onMount(async () => {
		const [idRes, actRes, chRes] = await Promise.all([
			api('/portal/agent-identity').catch(() => null),
			api('/portal/agent-activity').catch(() => null),
			api('/portal/channels').catch(() => null),
		]);
		if (idRes?.ok) identity = await idRes.json();
		if (actRes?.ok) {
			const d = await actRes.json();
			const e = (d.events || [])[0];
			if (e) lastActivity = { who: e.who, where: e.where, ts: e.ts, status: e.status };
			cyclesCount = (d.cycles || []).length;
		}
		if (chRes?.ok) {
			const d = await chRes.json();
			channels = { telegram: !!(d.telegram?.enabled ?? d.telegram?.connected ?? d.telegram), discord: !!(d.discord?.enabled ?? d.discord?.connected ?? d.discord) };
		}
		loading = false;
	});

	async function toggleChannelWrite() {
		if (!identity || saving) return;
		saving = true;
		const next = !identity.channelWrite;
		try {
			const res = await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify({ channelWrite: next }) });
			if (res?.ok) identity = { ...identity, ...(await res.json()) };
		} finally { saving = false; }
	}

	async function toggleScope(scope: string) {
		if (!identity || saving) return;
		const has = identity.scopes.includes(scope);
		const next = has ? identity.scopes.filter((s) => s !== scope) : [...identity.scopes, scope];
		if (next.length === 0) return; // never empty — full access is the floor
		saving = true;
		try {
			const res = await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify({ scopes: next }) });
			if (res?.ok) identity = { ...identity, ...(await res.json()) };
		} finally { saving = false; }
	}

	function rel(ts: string): string {
		const diff = Date.now() - new Date(ts).getTime();
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
		return `${Math.round(diff / 86400000)}d ago`;
	}
</script>

<div class="max-w-3xl mx-auto">
	{#if loading}
		<div class="py-12 text-center text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
	{:else}
		<!-- Identity + last activity -->
		<section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-4">
			<div class="flex items-center gap-3">
				<div class="w-3 h-3 rounded-full" style="background: {color}"></div>
				<div>
					<div class="text-base font-medium text-[var(--color-text-primary)]">{identity?.name || name}</div>
					<div class="text-[0.7rem] text-[var(--color-text-tertiary)]">Your personal agent</div>
				</div>
				<div class="ml-auto text-right">
					<div class="text-[0.65rem] uppercase tracking-wide text-[var(--color-text-tertiary)]">Last activity</div>
					<div class="text-sm text-[var(--color-text-primary)]">
						{#if lastActivity}{lastActivity.who} · {rel(lastActivity.ts)}{:else}—{/if}
					</div>
				</div>
			</div>
		</section>

		<!-- Channel writes toggle -->
		<section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-4">
			<div class="flex items-start gap-3">
				<div class="flex-1">
					<div class="text-sm font-medium text-[var(--color-text-primary)]">Vault writes from channels</div>
					<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mt-0.5">
						Let this agent save notes, remember facts, and capture from your 1:1 DMs (Telegram/Discord).
						On by default for your personal agent. Group messages and other people can never write.
					</p>
				</div>
				<button
					onclick={toggleChannelWrite}
					disabled={saving}
					class="relative w-10 h-6 rounded-full transition-colors flex-shrink-0 cursor-pointer {identity?.channelWrite ? 'bg-[var(--color-accent-jade)]' : 'bg-[var(--color-border)]'}"
					aria-label="Toggle channel writes"
				>
					<span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform {identity?.channelWrite ? 'translate-x-4' : ''}"></span>
				</button>
			</div>
		</section>

		<!-- Scopes -->
		<section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 mb-4">
			<div class="text-sm font-medium text-[var(--color-text-primary)] mb-1">Scopes</div>
			<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-3">Which areas of your vault this agent may access.</p>
			<div class="flex flex-wrap gap-2">
				{#each (identity?.allScopes || []) as scope}
					{@const on = identity?.scopes.includes(scope)}
					<button
						onclick={() => toggleScope(scope)}
						disabled={saving}
						class="px-3 py-1.5 rounded-lg border text-sm transition-colors cursor-pointer {on ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : 'border-[var(--color-border)] text-[var(--color-text-tertiary)]'}"
					>{SCOPE_LABELS[scope] || scope}</button>
				{/each}
			</div>
		</section>

		<!-- Channels + connections -->
		<section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
			<div class="text-sm font-medium text-[var(--color-text-primary)] mb-3">Channels & connections</div>
			<div class="flex flex-col gap-2 text-sm">
				<button onclick={() => goto('/import')} class="flex items-center gap-2 text-left hover:opacity-80 cursor-pointer">
					<span class="w-1.5 h-1.5 rounded-full {channels.telegram ? 'bg-[var(--color-accent-jade)]' : 'bg-[var(--color-border)]'}"></span>
					<span class="text-[var(--color-text-primary)]">Telegram</span>
					<span class="text-[0.7rem] text-[var(--color-text-tertiary)]">{channels.telegram ? 'connected' : 'not connected'}</span>
				</button>
				<button onclick={() => goto('/import')} class="flex items-center gap-2 text-left hover:opacity-80 cursor-pointer">
					<span class="w-1.5 h-1.5 rounded-full {channels.discord ? 'bg-[var(--color-accent-jade)]' : 'bg-[var(--color-border)]'}"></span>
					<span class="text-[var(--color-text-primary)]">Discord</span>
					<span class="text-[0.7rem] text-[var(--color-text-tertiary)]">{channels.discord ? 'connected' : 'not connected'}</span>
				</button>
				<button onclick={() => goto('/people')} class="flex items-center gap-2 text-left hover:opacity-80 cursor-pointer">
					<span class="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-amethyst)]"></span>
					<span class="text-[var(--color-text-primary)]">Connections</span>
					<span class="text-[0.7rem] text-[var(--color-text-tertiary)]">manage in People →</span>
				</button>
				{#if cyclesCount > 0}
					<div class="flex items-center gap-2">
						<span class="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-aurum)]"></span>
						<span class="text-[var(--color-text-primary)]">{cyclesCount} scheduled cycle{cyclesCount === 1 ? '' : 's'}</span>
					</div>
				{/if}
			</div>
		</section>
	{/if}
</div>
