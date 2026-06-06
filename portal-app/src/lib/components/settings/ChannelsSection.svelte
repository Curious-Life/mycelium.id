<!--
	Channels settings section — manage the Telegram channel-daemon from the portal.

	Fetches GET /portal/channels, saves to PUT /portal/channels, revokes groups via
	DELETE /portal/channels/groups/:id. All secrets are stored encrypted in the
	vault; the channel-daemon reads them over loopback (/api/v1/internal/channel-
	config) at startup — so editing here is authoritative. Mirrors VoiceSection's
	card style + write-only key handling (paste to set, blank to keep).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Group = { id: string; title: string | null };
	type ChannelsState = {
		enabled: boolean;
		telegram: { hasToken: boolean; ownerId: string | null };
		discord: { hasToken: boolean; ownerId: string | null };
		agent: { hasKey: boolean; model: string | null };
		groups: Group[];
	};

	let state = $state<ChannelsState | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	// form (separate from canonical state; keys are write-only)
	let formEnabled = $state(false);
	let formToken = $state('');
	let formOwnerId = $state('');
	let formDiscordToken = $state('');
	let formDiscordOwnerId = $state('');
	let formAgentKey = $state('');
	let formModel = $state('');

	async function load() {
		loading = true; error = null;
		try {
			const res = await api('/portal/channels');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			state = (await res.json()) as ChannelsState;
			formEnabled = state.enabled;
			formOwnerId = state.telegram.ownerId ?? '';
			formDiscordOwnerId = state.discord.ownerId ?? '';
			formModel = state.agent.model ?? '';
		} catch (e: any) {
			error = e?.message || 'Failed to load channel settings';
		} finally { loading = false; }
	}
	onMount(load);

	async function save() {
		if (!state) return;
		saving = true; error = null;
		try {
			const body: Record<string, unknown> = { enabled: formEnabled };
			const telegram: Record<string, string> = {};
			if (formToken.trim()) telegram.token = formToken.trim();
			if (formOwnerId.trim() !== (state.telegram.ownerId ?? '')) telegram.ownerId = formOwnerId.trim();
			if (Object.keys(telegram).length) body.telegram = telegram;
			const discord: Record<string, string> = {};
			if (formDiscordToken.trim()) discord.token = formDiscordToken.trim();
			if (formDiscordOwnerId.trim() !== (state.discord.ownerId ?? '')) discord.ownerId = formDiscordOwnerId.trim();
			if (Object.keys(discord).length) body.discord = discord;
			const agent: Record<string, string> = {};
			if (formAgentKey.trim()) agent.apiKey = formAgentKey.trim();
			if (formModel.trim() !== (state.agent.model ?? '')) agent.model = formModel.trim();
			if (Object.keys(agent).length) body.agent = agent;

			const res = await api('/portal/channels', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json?.error || 'Save failed');
			formToken = ''; formDiscordToken = ''; formAgentKey = ''; // wipe pasted secrets
			await load();
		} catch (e: any) {
			error = e?.message || 'Save failed';
		} finally { saving = false; }
	}

	async function revokeGroup(id: string) {
		try {
			const res = await api(`/portal/channels/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			await load();
		} catch (e: any) { error = e?.message || 'Failed to revoke group'; }
	}
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Channels</h2>

	{#if loading}
		<div class="text-[0.7rem] text-[var(--color-text-tertiary)]">Loading…</div>
	{:else if !state}
		<div class="text-[0.7rem] text-red-400">{error || 'Failed to load'}</div>
	{:else}
		<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-4">
			Talk to your vault over Telegram. Messages are captured + searchable; replies are reasoned over your
			vault. Paste your bot token (from @BotFather) — it stays encrypted on this machine, never leaves it. The
			channel-daemon picks up changes on its next start.
		</p>

		{#if error}<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>{/if}

		<!-- enable -->
		<label class="flex items-center gap-2 mb-5 cursor-pointer">
			<input type="checkbox" bind:checked={formEnabled} class="accent-[var(--color-accent)]" />
			<span class="text-sm text-[var(--color-text-primary)]">Enable Telegram channel</span>
		</label>

		<!-- telegram token -->
		<div class="mb-4">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
				Telegram bot token
				{#if state.telegram.hasToken}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}
			</label>
			<input type="password" bind:value={formToken} autocomplete="off" data-1p-ignore
				placeholder={state.telegram.hasToken ? '••••••••• (leave blank to keep)' : '123456:ABC-DEF… from @BotFather'}
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- owner id -->
		<div class="mb-4">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
				Your Telegram chat id
				<a href="https://t.me/userinfobot" target="_blank" rel="noopener" class="ml-2 text-[0.62rem] text-[var(--color-accent)] hover:underline">find yours →</a>
			</label>
			<input type="text" bind:value={formOwnerId} autocomplete="off" data-1p-ignore placeholder="e.g. 123456789"
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- discord token -->
		<div class="mb-4">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
				Discord bot token
				{#if state.discord.hasToken}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}
			</label>
			<input type="password" bind:value={formDiscordToken} autocomplete="off" data-1p-ignore
				placeholder={state.discord.hasToken ? '••••••••• (leave blank to keep)' : 'from the Discord developer portal (enable MESSAGE CONTENT intent)'}
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- discord owner id -->
		<div class="mb-4">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Your Discord user id</label>
			<input type="text" bind:value={formDiscordOwnerId} autocomplete="off" data-1p-ignore placeholder="e.g. 209384756019384756"
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- assistant model key -->
		<div class="mb-4">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
				Assistant key (Anthropic) — enables two-way replies
				{#if state.agent.hasKey}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}
			</label>
			<input type="password" bind:value={formAgentKey} autocomplete="off" data-1p-ignore
				placeholder={state.agent.hasKey ? '••••••••• (leave blank to keep)' : 'sk-ant-… (blank = capture only, no replies)'}
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
			<input type="text" bind:value={formModel} autocomplete="off" placeholder="model (default claude-sonnet-4-6)"
				class="w-full mt-2 px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- authorized groups -->
		<div class="mb-5">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Authorized groups</label>
			{#if state.groups.length === 0}
				<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">None yet. Add the bot to a group and send <code>/allow</code> there.</div>
			{:else}
				<div class="space-y-1.5">
					{#each state.groups as g (g.id)}
						<div class="flex items-center justify-between gap-3 p-2 rounded-lg border border-[var(--color-border)]">
							<span class="text-sm text-[var(--color-text-primary)] truncate">{g.title || g.id}</span>
							<button type="button" onclick={() => revokeGroup(g.id)}
								class="text-[0.65rem] px-2 py-1 text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer">revoke</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="flex items-center gap-3">
			<button onclick={save} disabled={saving}
				class="px-4 py-1.5 text-sm font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer">
				{saving ? 'Saving…' : 'Save'}
			</button>
			<span class="text-[0.62rem] text-[var(--color-text-tertiary)]">
				{#if state.enabled && state.telegram.hasToken}
					Channel configured{state.agent.hasKey ? ' — two-way replies on' : ' — capture only (add an assistant key for replies)'}
				{:else}
					Add a bot token + enable to start
				{/if}
			</span>
		</div>
	{/if}
</section>
