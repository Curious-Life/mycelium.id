<!--
	Channels settings section — manage the Telegram + Discord channel-daemon.

	GET/PUT /portal/channels (tokens, owner ids, assistant key/model, routing knobs);
	PUT /portal/channels/access (per-channel access policy: owner|allowlist|open);
	DELETE /portal/channels/{groups,discord}/:id (revoke). All secrets encrypted in
	the vault; the daemon hydrates over loopback (/api/v1/internal/channel-config)
	at startup, so editing here is authoritative.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Access = { mode: 'owner' | 'allowlist' | 'open'; allowedSenders: string[] };
	type Group = { id: string; title: string | null; access: Access };
	type DChan = { id: string; name: string | null; access: Access };
	type Routing = { router: string; ollamaModel: string; ollamaUrl: string; coalesceMs: string; rateLimitMax: string; rateLimitWindowMs: string; sensitivePatterns: string };
	type ChannelsState = {
		enabled: boolean;
		telegram: { hasToken: boolean; ownerId: string | null };
		discord: { hasToken: boolean; ownerId: string | null };
		agent: { hasKey: boolean; model: string | null };
		routing: Routing;
		groups: Group[];
		discordChannels: DChan[];
		daemon?: { status: string; message: string | null; detail: string | null; replies?: string | null; backend?: string | null };
	};

	let cs: ChannelsState | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let error: string | null = $state(null);

	// write-only secret form fields
	let formEnabled = $state(false);
	let formToken = $state(''); let formOwnerId = $state('');
	let formDiscordToken = $state(''); let formDiscordOwnerId = $state('');
	let formAgentKey = $state(''); let formModel = $state('');
	// routing & tuning
	let r: Routing = $state({ router: '', ollamaModel: '', ollamaUrl: '', coalesceMs: '', rateLimitMax: '', rateLimitWindowMs: '', sensitivePatterns: '' });
	// per-channel access edits, keyed by `${kind}:${id}`
	let accessForm: Record<string, { mode: string; senders: string }> = $state({});

	function seedAccess(kind: string, id: string, a: Access) {
		accessForm[`${kind}:${id}`] = { mode: a?.mode || 'open', senders: (a?.allowedSenders || []).join(', ') };
	}

	async function load() {
		loading = true; error = null;
		try {
			const res = await api('/portal/channels');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			cs = (await res.json()) as ChannelsState;
			formEnabled = cs.enabled;
			formOwnerId = cs.telegram.ownerId ?? '';
			formDiscordOwnerId = cs.discord.ownerId ?? '';
			formModel = cs.agent.model ?? '';
			r = { ...r, ...cs.routing };
			accessForm = {};
			cs.groups.forEach((g: Group) => seedAccess('telegram-group', g.id, g.access));
			cs.discordChannels.forEach((c: DChan) => seedAccess('discord', c.id, c.access));
		} catch (e: any) {
			error = e?.message || 'Failed to load channel settings';
		} finally { loading = false; }
	}
	onMount(load);

	async function save() {
		if (!cs) return;
		saving = true; error = null;
		try {
			const body: Record<string, unknown> = { enabled: formEnabled, routing: r };
			const telegram: Record<string, string> = {};
			if (formToken.trim()) telegram.token = formToken.trim();
			if (formOwnerId.trim() !== (cs.telegram.ownerId ?? '')) telegram.ownerId = formOwnerId.trim();
			if (Object.keys(telegram).length) body.telegram = telegram;
			const discord: Record<string, string> = {};
			if (formDiscordToken.trim()) discord.token = formDiscordToken.trim();
			if (formDiscordOwnerId.trim() !== (cs.discord.ownerId ?? '')) discord.ownerId = formDiscordOwnerId.trim();
			if (Object.keys(discord).length) body.discord = discord;
			const agent: Record<string, string> = {};
			if (formAgentKey.trim()) agent.apiKey = formAgentKey.trim();
			if (formModel.trim() !== (cs.agent.model ?? '')) agent.model = formModel.trim();
			if (Object.keys(agent).length) body.agent = agent;

			const res = await api('/portal/channels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json?.error || 'Save failed');
			formToken = ''; formDiscordToken = ''; formAgentKey = '';
			await load();
		} catch (e: any) { error = e?.message || 'Save failed'; } finally { saving = false; }
	}

	async function setAccess(kind: string, id: string) {
		const f = accessForm[`${kind}:${id}`];
		if (!f) return;
		try {
			const allowedSenders = f.senders.split(',').map((s: string) => s.trim()).filter(Boolean);
			const res = await api('/portal/channels/access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, mode: f.mode, allowedSenders }) });
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			await load();
		} catch (e: any) { error = e?.message || 'Failed to set access'; }
	}

	async function revoke(path: string) {
		try {
			const res = await api(path, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			await load();
		} catch (e: any) { error = e?.message || 'Failed to revoke'; }
	}
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Channels</h2>

	{#if loading}
		<div class="text-[0.7rem] text-[var(--color-text-tertiary)]">Loading…</div>
	{:else if !cs}
		<div class="text-[0.7rem] text-red-400">{error || 'Failed to load'}</div>
	{:else}
		<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-4">
			Talk to your vault over Telegram + Discord. Messages are captured + searchable; replies are reasoned over
			your vault. Tokens stay encrypted on this machine. Changes apply immediately — the app starts + restarts the
			bridge for you.
		</p>
		{#if cs.daemon && cs.daemon.status && cs.daemon.status !== 'unknown'}
			{@const st = cs.daemon.status}
			{@const captureOnly = st === 'ok' && cs.daemon.replies === 'capture-only'}
			<div class="text-[0.7rem] mb-3 flex items-center gap-2">
				<span class="inline-block w-2 h-2 rounded-full {st === 'ok' && !captureOnly ? 'bg-green-500' : st === 'down' ? 'bg-red-500' : st === 'disabled' ? 'bg-[var(--color-text-tertiary)]' : 'bg-amber-400'}"></span>
				<span class="text-[var(--color-text-secondary)]">
					{#if st === 'ok'}{captureOnly ? 'Receiving — but not replying' : 'Bridge running — replying'}{:else if st === 'down'}Bridge stopped — check the bot token{:else if st === 'disabled'}Bridge off{:else}Bridge starting…{/if}
				</span>
				{#if captureOnly}
					<span class="text-[var(--color-text-tertiary)]">· no AI model connected — pick one in Settings → AI, or add a key below</span>
				{:else if st === 'ok' && cs.daemon.backend}
					<span class="text-[var(--color-text-tertiary)]">· via {cs.daemon.backend}</span>
				{/if}
			</div>
		{/if}

		{#if error}<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>{/if}

		<label class="flex items-center gap-2 mb-5 cursor-pointer">
			<input type="checkbox" bind:checked={formEnabled} class="accent-[var(--color-accent)]" />
			<span class="text-sm text-[var(--color-text-primary)]">Enable channels</span>
		</label>

		<!-- telegram -->
		<div class="mb-4">
			<label for="ch-tg-token" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Telegram bot token {#if cs.telegram.hasToken}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}</label>
			<input id="ch-tg-token" type="password" bind:value={formToken} autocomplete="off" data-1p-ignore placeholder={cs.telegram.hasToken ? '••••••••• (leave blank to keep)' : '123456:ABC… from @BotFather'}
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>
		<div class="mb-4">
			<label for="ch-tg-owner" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Your Telegram chat id <a href="https://t.me/userinfobot" target="_blank" rel="noopener" class="ml-2 text-[0.62rem] text-[var(--color-accent)] hover:underline">find yours →</a></label>
			<input id="ch-tg-owner" type="text" bind:value={formOwnerId} autocomplete="off" data-1p-ignore placeholder="e.g. 123456789"
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- discord -->
		<div class="mb-4">
			<label for="ch-dc-token" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Discord bot token {#if cs.discord.hasToken}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}</label>
			<input id="ch-dc-token" type="password" bind:value={formDiscordToken} autocomplete="off" data-1p-ignore placeholder={cs.discord.hasToken ? '••••••••• (leave blank to keep)' : 'Discord dev portal (enable MESSAGE CONTENT intent)'}
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>
		<div class="mb-4">
			<label for="ch-dc-owner" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Your Discord user id</label>
			<input id="ch-dc-owner" type="text" bind:value={formDiscordOwnerId} autocomplete="off" data-1p-ignore placeholder="e.g. 209384756019384756"
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- assistant key -->
		<div class="mb-4">
			<label for="ch-agent-key" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Assistant key (Anthropic) — two-way replies {#if cs.agent.hasKey}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}</label>
			<input id="ch-agent-key" type="password" bind:value={formAgentKey} autocomplete="off" data-1p-ignore placeholder={cs.agent.hasKey ? '••••••••• (leave blank to keep)' : 'sk-ant-… (blank = capture only)'}
				class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
			<input type="text" bind:value={formModel} autocomplete="off" aria-label="Assistant model" placeholder="model (default claude-sonnet-4-6)"
				class="w-full mt-2 px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
		</div>

		<!-- authorized groups (with per-channel access policy) -->
		<div class="mb-5">
			<span class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Authorized Telegram groups</span>
			{#if cs.groups.length === 0}
				<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">None yet. Add the bot to a group and send <code>/allow</code>.</div>
			{:else}
				<div class="space-y-2">
					{#each cs.groups as g (g.id)}
						{@const key = `telegram-group:${g.id}`}
						<div class="p-2 rounded-lg border border-[var(--color-border)]">
							<div class="flex items-center justify-between gap-3 mb-2">
								<span class="text-sm text-[var(--color-text-primary)] truncate">{g.title || g.id}</span>
								<button type="button" onclick={() => revoke(`/portal/channels/groups/${encodeURIComponent(g.id)}`)} class="text-[0.65rem] px-2 py-1 text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer">revoke</button>
							</div>
							{#if accessForm[key]}
								<div class="flex items-center gap-2 flex-wrap">
									<select bind:value={accessForm[key].mode} aria-label="Access mode" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
										<option value="owner">Owner only</option><option value="allowlist">Allowlist</option><option value="open">Open to all</option>
									</select>
									{#if accessForm[key].mode === 'allowlist'}
										<input type="text" bind:value={accessForm[key].senders} aria-label="Allowed user ids" placeholder="allowed user ids, comma-separated" class="flex-1 min-w-[12rem] text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
									{/if}
									<button type="button" onclick={() => setAccess('telegram-group', g.id)} class="text-[0.65rem] px-2 py-1 text-[var(--color-accent)] hover:underline cursor-pointer">apply</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- authorized discord channels (with per-channel access policy) -->
		{#if cs.discord.hasToken}
			<div class="mb-5">
				<span class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Authorized Discord channels</span>
				{#if cs.discordChannels.length === 0}
					<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">None yet. In a channel, send <code>/allow</code>.</div>
				{:else}
					<div class="space-y-2">
						{#each cs.discordChannels as c (c.id)}
							{@const key = `discord:${c.id}`}
							<div class="p-2 rounded-lg border border-[var(--color-border)]">
								<div class="flex items-center justify-between gap-3 mb-2">
									<span class="text-sm text-[var(--color-text-primary)] truncate">{c.name || c.id}</span>
									<button type="button" onclick={() => revoke(`/portal/channels/discord/${encodeURIComponent(c.id)}`)} class="text-[0.65rem] px-2 py-1 text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer">revoke</button>
								</div>
								{#if accessForm[key]}
									<div class="flex items-center gap-2 flex-wrap">
										<select bind:value={accessForm[key].mode} aria-label="Access mode" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
											<option value="owner">Owner only</option><option value="allowlist">Allowlist</option><option value="open">Open to all</option>
										</select>
										{#if accessForm[key].mode === 'allowlist'}
											<input type="text" bind:value={accessForm[key].senders} aria-label="Allowed user ids" placeholder="allowed user ids, comma-separated" class="flex-1 min-w-[12rem] text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
										{/if}
										<button type="button" onclick={() => setAccess('discord', c.id)} class="text-[0.65rem] px-2 py-1 text-[var(--color-accent)] hover:underline cursor-pointer">apply</button>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- routing & tuning (advanced) -->
		<details class="mb-5">
			<summary class="text-[0.7rem] text-[var(--color-text-secondary)] cursor-pointer">Routing &amp; tuning (advanced)</summary>
			<div class="mt-3 space-y-3">
				<div>
					<label for="ch-router" class="text-[0.62rem] text-[var(--color-text-tertiary)] block mb-1">Router (when both cloud + local are set)</label>
					<select id="ch-router" bind:value={r.router} class="w-full text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]">
						<option value="">Auto (local-first, escalate complex → cloud)</option>
						<option value="cloud">Cloud only</option>
						<option value="local">Local only</option>
						<option value="auto">Auto (explicit)</option>
					</select>
				</div>
				<div class="grid grid-cols-2 gap-2">
					<input type="text" bind:value={r.ollamaModel} aria-label="Ollama model" placeholder="Ollama model (sovereign)" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
					<input type="text" bind:value={r.ollamaUrl} aria-label="Ollama URL" placeholder="Ollama URL (default :11434)" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
					<input type="number" bind:value={r.coalesceMs} aria-label="Coalesce window ms" placeholder="coalesce ms (1500)" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
					<input type="number" bind:value={r.rateLimitMax} aria-label="Rate limit max" placeholder="rate cap / window (20)" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
					<input type="number" bind:value={r.rateLimitWindowMs} aria-label="Rate limit window ms" placeholder="rate window ms (60000)" class="text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]" />
				</div>
				<div>
					<label for="ch-sensitive" class="text-[0.62rem] text-[var(--color-text-tertiary)] block mb-1">Sensitive patterns (regex, comma-separated) — turns matching these stay local</label>
					<textarea id="ch-sensitive" bind:value={r.sensitivePatterns} rows="2" placeholder="e.g. \\bdiagnosis\\b, \\bsalary\\b" class="w-full text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]"></textarea>
				</div>
			</div>
		</details>

		<div class="flex items-center gap-3">
			<button onclick={save} disabled={saving} class="px-4 py-1.5 text-sm font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer">{saving ? 'Saving…' : 'Save'}</button>
			<span class="text-[0.62rem] text-[var(--color-text-tertiary)]">
				{#if cs.enabled && (cs.telegram.hasToken || cs.discord.hasToken)}
					Configured{cs.agent.hasKey ? ' — two-way replies on' : ' — capture only (add an assistant key)'}
				{:else}
					Add a bot token + enable to start
				{/if}
			</span>
		</div>
	{/if}
</section>
