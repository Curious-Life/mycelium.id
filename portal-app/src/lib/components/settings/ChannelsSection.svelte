<!--
	Channels settings section — manage the Telegram + Discord channel-daemon.

	CH-1 (QA simplification): the DEFAULT surface is "pick a logo → connect" — two
	channel tiles (Telegram / Discord); selecting one reveals its connect flow. The
	gold-standard <TelegramConnect> primitive drives Telegram (paste token → message
	the bot → approve the code). Discord mirrors it with a minimal token + id connect.
	Everything else (assistant key, per-channel access policy, routing/tuning, the
	master enable toggle) moves into a collapsed "Advanced" section so a first-time
	user only sees the two-step connect — no behaviour or endpoint removed.

	GET/PUT /portal/channels (tokens, owner ids, assistant key/model, routing knobs);
	PUT /portal/channels/access (per-channel access policy: owner|allowlist|open);
	DELETE /portal/channels/{groups,discord}/:id (revoke). All secrets encrypted in
	the vault; the daemon hydrates over loopback (/api/v1/internal/channel-config)
	at startup, so editing here is authoritative.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import TelegramConnect from '$lib/components/channels/TelegramConnect.svelte';

	type Access = { mode: 'owner' | 'allowlist' | 'open'; allowedSenders: string[] };
	type Group = { id: string; title: string | null; access: Access };
	type DChan = { id: string; name: string | null; access: Access };
	type Routing = { router: string; ollamaModel: string; ollamaUrl: string; coalesceMs: string; rateLimitMax: string; rateLimitWindowMs: string; sensitivePatterns: string };
	// D-014 — the honest per-channel connection state the server derives
	// (src/channels/supervisor.js honestChannelConnection). `connected` is true ONLY
	// when the daemon reports a live gateway for that platform.
	type Conn = {
		state: 'not-configured' | 'off' | 'connecting' | 'connected' | 'failed' | 'unknown';
		connected: boolean; reason: string | null; detail: string | null;
	};
	type ChannelsState = {
		enabled: boolean;
		telegram: { hasToken: boolean; ownerId: string | null; connection?: Conn };
		discord: { hasToken: boolean; ownerId: string | null; connection?: Conn };
		agent: { hasKey: boolean; model: string | null };
		routing: Routing;
		groups: Group[];
		discordChannels: DChan[];
		daemon?: { status: string; message: string | null; detail: string | null; replies?: string | null; backend?: string | null };
	};

	let cs: ChannelsState | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let connectingDiscord = $state(false);
	let error: string | null = $state(null);

	// which channel tile is expanded (pick-a-logo → connect)
	let selected: 'telegram' | 'discord' | null = $state(null);

	// write-only secret form fields
	let formEnabled = $state(false);
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
			formDiscordOwnerId = cs.discord.ownerId ?? '';
			formModel = cs.agent.model ?? '';
			r = { ...r, ...cs.routing };
			accessForm = {};
			cs.groups.forEach((g: Group) => seedAccess('telegram-group', g.id, g.access));
			cs.discordChannels.forEach((c: DChan) => seedAccess('discord', c.id, c.access));
			// First visit: auto-open the channel already configured, else leave the
			// picker closed so the two tiles are the first thing a new user sees.
			if (selected === null) {
				if (cs.telegram.hasToken) selected = 'telegram';
				else if (cs.discord.hasToken) selected = 'discord';
			}
		} catch (e: any) {
			error = e?.message || 'Failed to load channel settings';
		} finally { loading = false; }
	}
	onMount(load);

	// Discord one-call connect — mirrors <TelegramConnect>.save(): one PUT that saves
	// the token (+ id), flips CHANNEL_ENABLED, and reloads the daemon over loopback.
	async function connectDiscord() {
		if (!formDiscordToken.trim() && !cs?.discord.hasToken) return;
		connectingDiscord = true; error = null;
		try {
			const discord: Record<string, string> = {};
			if (formDiscordToken.trim()) discord.token = formDiscordToken.trim();
			if (formDiscordOwnerId.trim() !== (cs?.discord.ownerId ?? '')) discord.ownerId = formDiscordOwnerId.trim();
			const body: Record<string, unknown> = { enabled: true };
			if (Object.keys(discord).length) body.discord = discord;
			const res = await api('/portal/channels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json?.error || 'Save failed');
			formDiscordToken = '';
			await load();
		} catch (e: any) { error = e?.message || 'Save failed'; } finally { connectingDiscord = false; }
	}

	async function save() {
		if (!cs) return;
		saving = true; error = null;
		try {
			// Telegram is owned by <TelegramConnect> (design D1); this batch handles
			// the master enable toggle, Discord, the assistant key/model, and routing.
			const body: Record<string, unknown> = { enabled: formEnabled, routing: r };
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
			formDiscordToken = ''; formAgentKey = '';
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

	function pick(ch: 'telegram' | 'discord') { selected = selected === ch ? null : ch; }

	// ── D-014: the tile badge ────────────────────────────────────────────────────
	// The operator's words: "discord shows as connected even though it is not connected."
	// The badge used to read `hasToken` — "a bot token is saved in the vault" — which is a
	// credential, not a connection. It said Connected while the Discord gateway had never
	// started (discord.js is an optional dep that isn't installed, so every start() threw
	// and the error was swallowed at index.js's `.catch()`).
	//
	// Now it renders the SERVER-DERIVED honest state, and it FAILS CLOSED: an older server
	// that sends no `connection` object, or any state that is not exactly 'connected',
	// renders as something other than Connected. There is no branch that can print
	// "Connected" from a stored flag.
	function badgeFor(c: { hasToken: boolean; connection?: Conn } | undefined): { text: string; tone: string } | null {
		if (!c?.hasToken) return null;                                  // nothing configured → no badge
		const st = c.connection?.state;
		if (st === 'connected') return { text: 'Connected', tone: 'ok' };
		if (st === 'connecting') return { text: 'Connecting…', tone: 'warn' };
		if (st === 'off') return { text: 'Off', tone: 'muted' };
		if (st === 'failed') return { text: 'Not connected', tone: 'bad' };
		// 'unknown' — and the no-`connection`-field case. We do NOT know it is connected,
		// so we must not say it is. "Checking…" is the honest word for an absent read.
		return { text: 'Checking…', tone: 'muted' };
	}
	// Called from the markup (inside the `{:else}` arm where `cs` is already narrowed
	// non-null) rather than hoisted into a `$derived` — at this point in the module TS
	// narrows the still-unassigned `cs` to `null`, so `cs?.telegram` would be `never`.
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Channels</h2>

	{#if loading}
		<div class="text-[0.7rem] text-[var(--color-text-tertiary)]">Loading…</div>
	{:else if !cs}
		<div class="text-[0.7rem] text-red-400">{error || 'Failed to load'}</div>
	{:else}
		<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-4">
			Talk to your vault over a messaging app. Pick one below and connect — tokens stay encrypted on this
			machine, and the app starts the bridge for you. Pairing is approved here in the app, never by a code
			typed into a terminal.
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
					<span class="text-[var(--color-text-tertiary)]">· no AI model connected — pick one in Settings → AI, or add a key in Advanced</span>
				{:else if st === 'ok' && cs.daemon.backend}
					<span class="text-[var(--color-text-tertiary)]">· via {cs.daemon.backend}</span>
				{/if}
			</div>
		{/if}

		{#if error}<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>{/if}

		<!-- pick a logo → connect. The badges are {@const} here rather than a module-level
		     $derived: at that point TS narrows the still-unassigned `cs` to `null`, so
		     `cs.telegram` would be `never`. Inside this {:else} arm `cs` is non-null. -->
		{@const tgBadge = badgeFor(cs.telegram)}
		{@const dcBadge = badgeFor(cs.discord)}
		<div class="grid grid-cols-2 gap-3 mb-4">
			<button type="button" onclick={() => pick('telegram')} aria-pressed={selected === 'telegram'}
				class="channel-tile {selected === 'telegram' ? 'channel-tile--on' : ''}">
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="w-6 h-6"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.13-3.05-1.98 1.93c-.23.23-.42.42-.86.42z"/></svg>
				<span class="channel-name">Telegram</span>
				{#if tgBadge}<span class="channel-badge" data-tone={tgBadge.tone} data-testid="badge-telegram" title={cs.telegram.connection?.detail ?? undefined}>{tgBadge.text}</span>{/if}
			</button>
			<button type="button" onclick={() => pick('discord')} aria-pressed={selected === 'discord'}
				class="channel-tile {selected === 'discord' ? 'channel-tile--on' : ''}">
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="w-6 h-6"><path d="M20.32 4.37A19.8 19.8 0 0015.45 3l-.24.44a18.3 18.3 0 014.32 1.35 16.9 16.9 0 00-19.06 0A18.3 18.3 0 018.8 3.44L8.55 3a19.8 19.8 0 00-4.87 1.37C.6 8.96-.24 13.44.18 17.86a19.95 19.95 0 006.03 3.05l.66-1.05a13 13 0 01-2.06-.98l.5-.38a14.24 14.24 0 0012.36 0l.5.38c-.65.38-1.34.71-2.06.98l.66 1.05a19.95 19.95 0 006.03-3.05c.5-5.12-.84-9.56-3.5-13.49zM8.03 15.33c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.16 1.09 2.15 2.42c0 1.32-.96 2.4-2.15 2.4zm7.94 0c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.16 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4z"/></svg>
				<span class="channel-name">Discord</span>
				{#if dcBadge}<span class="channel-badge" data-tone={dcBadge.tone} data-testid="badge-discord" title={cs.discord.connection?.detail ?? undefined}>{dcBadge.text}</span>{/if}
			</button>
		</div>

		{#if selected === 'telegram'}
			<!-- telegram — the shared connect primitive (design D1): token + message-first
			     pairing (D2). Writes through PUT /portal/channels, same as this panel. -->
			<div class="connect-panel mb-4">
				<TelegramConnect onconnected={() => load()} />
			</div>
		{:else if selected === 'discord'}
			<div class="connect-panel mb-4 space-y-3">
				<!-- D-014: this line claimed "✓ Discord connected" off `hasToken` too. It now
				     tracks the same honest state, and NAMES THE REMEDY when it is not connected
				     (the QA6 bar) instead of asserting a connection that does not exist. -->
				{#if cs.discord.hasToken}
					{#if cs.discord.connection?.state === 'connected'}
						<p class="text-[0.75rem] text-[var(--color-accent)]">✓ Discord connected. Add me to a server and send <code>/allow</code> in a channel.</p>
					{:else if cs.discord.connection?.state === 'connecting'}
						<p class="text-[0.75rem] text-[var(--color-text-secondary)]">Connecting to Discord…</p>
					{:else if cs.discord.connection?.state === 'off'}
						<p class="text-[0.75rem] text-[var(--color-text-secondary)]">Token saved, but channels are switched off — turn on “Enable channels” in Advanced below.</p>
					{:else if cs.discord.connection?.state === 'failed'}
						<p class="text-[0.75rem] text-amber-400" data-testid="discord-not-connected">
							Token saved, but Discord is <strong>not connected</strong>.
							{#if cs.discord.connection?.reason === 'module_missing'}
								This build doesn’t include the Discord gateway library, so incoming Discord messages can’t be received.
							{:else if cs.discord.connection?.detail}
								{cs.discord.connection.detail}
							{/if}
							Re-check the bot token and that the <code>MESSAGE CONTENT</code> intent is enabled in the Discord dev portal, then press Update.
						</p>
					{:else}
						<p class="text-[0.75rem] text-[var(--color-text-tertiary)]">Token saved — checking the Discord connection…</p>
					{/if}
				{/if}
				<div>
					<label for="ch-dc-token" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Discord bot token {#if cs.discord.hasToken}<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>{/if}</label>
					<input id="ch-dc-token" type="password" bind:value={formDiscordToken} autocomplete="off" data-1p-ignore placeholder={cs.discord.hasToken ? '••••••••• (leave blank to keep)' : 'Discord dev portal (enable MESSAGE CONTENT intent)'}
						onkeydown={(e) => { if (e.key === 'Enter') connectDiscord(); }}
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
				</div>
				<div>
					<label for="ch-dc-owner" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Your Discord user id</label>
					<input id="ch-dc-owner" type="text" bind:value={formDiscordOwnerId} autocomplete="off" data-1p-ignore placeholder="e.g. 209384756019384756"
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
				</div>
				<button type="button" onclick={connectDiscord} disabled={connectingDiscord || (!formDiscordToken.trim() && !cs.discord.hasToken)}
					class="px-4 py-1.5 text-sm font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer">
					{connectingDiscord ? 'Connecting…' : (cs.discord.hasToken ? 'Update' : 'Connect')}
				</button>
			</div>
		{/if}

		<!-- ADVANCED — assistant key, per-channel access, routing, master toggle. All the
		     prior controls live here so the default surface stays pick-logo → connect. -->
		<details class="channel-advanced">
			<summary class="text-[0.7rem] text-[var(--color-text-secondary)] cursor-pointer">Advanced — replies, access &amp; tuning</summary>
			<div class="mt-4">
				<label class="flex items-center gap-2 mb-5 cursor-pointer">
					<input type="checkbox" bind:checked={formEnabled} class="accent-[var(--color-accent)]" />
					<span class="text-sm text-[var(--color-text-primary)]">Enable channels (master switch)</span>
				</label>

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

				<!-- routing & tuning -->
				<div class="mb-5">
					<span class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Routing &amp; tuning</span>
					<div class="space-y-3">
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
							<textarea id="ch-sensitive" bind:value={r.sensitivePatterns} rows="2" placeholder="e.g. \bdiagnosis\b, \bsalary\b" class="w-full text-[0.7rem] px-2 py-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]"></textarea>
						</div>
					</div>
				</div>

				<div class="flex items-center gap-3">
					<button onclick={save} disabled={saving} class="px-4 py-1.5 text-sm font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer">{saving ? 'Saving…' : 'Save advanced'}</button>
					<span class="text-[0.62rem] text-[var(--color-text-tertiary)]">
						{#if cs.enabled && (cs.telegram.hasToken || cs.discord.hasToken)}
							Configured{cs.agent.hasKey ? ' — two-way replies on' : ' — capture only (add an assistant key)'}
						{:else}
							Add a bot token + enable to start
						{/if}
					</span>
				</div>
			</div>
		</details>
	{/if}
</section>

<style>
	.channel-tile {
		display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
		padding: 1rem 0.75rem; border-radius: 0.6rem; cursor: pointer;
		border: 1px solid var(--color-border, rgba(128,128,128,0.3));
		background: var(--color-bg, transparent); color: var(--color-text-secondary);
		transition: border-color 0.15s, color 0.15s, background 0.15s;
	}
	.channel-tile:hover { color: var(--color-text-primary); border-color: var(--color-accent); }
	.channel-tile--on {
		color: var(--color-text-primary); border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 8%, transparent);
	}
	.channel-name { font-size: 0.8rem; font-weight: 500; }
	/* D-014: the badge is TONED by the honest state, so "Not connected" cannot read as
	   an accent-coloured success the way the old unconditional "Connected" did. */
	.channel-badge {
		font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--color-text-tertiary);
	}
	.channel-badge[data-tone='ok'] { color: var(--color-accent-jade); }
	.channel-badge[data-tone='warn'] { color: var(--color-accent-aurum); }
	.channel-badge[data-tone='bad'] { color: var(--color-accent-coral); }
	.channel-badge[data-tone='muted'] { color: var(--color-text-tertiary); }
	.connect-panel {
		padding: 0.85rem; border-radius: 0.6rem;
		border: 1px solid var(--color-border, rgba(128,128,128,0.3));
	}
	.channel-advanced { margin-top: 0.5rem; }
	.channel-advanced code { font-family: ui-monospace, monospace; }
</style>
