<!--
  AgentRow — per-agent management card.

  Collapsed: status dot, name, role, model, activeTasks (a quiet single line).
  Expanded: an IDENTITY BLOCK (engine + live status · editable agent name ·
  read-only personality one-liner with a "refine on the character page" link;
  no avatar/emoji here), then Claude subscription assignment,
  bot tokens (Discord/Telegram/OWNER_TELEGRAM_ID per agent-secret-policy),
  read-only details (capabilities, scope, port).

  This is the unification of three previously-duplicated sections from
  the settings page (subscription assignment L:1458, customization L:1526,
  read-only billing summary L:1746) — all keyed on agent.id.

  Source-of-truth merging happens in the parent page's `agentRows[]`
  derivation; this component just renders + dispatches saves.
-->

<script lang="ts">
	import { api } from '$lib/api';
	import { workspace } from '$lib/workspace/store';
	import ReflectionCyclesSection from '$lib/components/settings/ReflectionCyclesSection.svelte';

	type AgentInfo = {
		id: string;
		name: string;
		defaultName?: string;
		role?: string | null;
		color?: string;
		port?: number;
		status: 'online' | 'offline';
		model?: string | null;
		activeTasks?: number;
		avatarEmoji?: string;
	};

	type Provider = {
		id: number;
		provider: string;
		label?: string | null;
		status?: string;
		config_dir?: string | null;
	};

	type Assignment = {
		agent_id: string;
		provider_id: number;
		desired_state: 'pending' | 'applied' | 'failed';
		applied_at?: string | null;
		last_error?: string | null;
	};

	type RuntimeAgent = {
		slug: string;
		name?: string;
		port?: number;
		configDir?: string | null;
		ok: boolean;
		error?: string | null;
	};

	type SecretEntry = { agentId: string; key: string; set: boolean };

	let {
		agent,
		providers = [],
		assignments = [],
		runtimeAgents = [],
		secretsState = [],
		lastActivity = null,
		onChange,
	} = $props<{
		agent: AgentInfo;
		providers?: Provider[];
		assignments?: Assignment[];
		runtimeAgents?: RuntimeAgent[];
		secretsState?: SecretEntry[];
		lastActivity?: string | null;
		onChange?: () => void | Promise<void>;
	}>();

	let expanded = $state(false);

	// ── Customization (display name) ───────────────────────────────────
	// Character (voice + the "being") lives on the Character page now — the old
	// personality tone-enum was removed with the PERSONALITY_GUIDE relic.
	// Initial value comes via a $effect rather than $state initializer so
	// re-renders from parent prop changes (after a save round-trip)
	// re-sync local edits.
	let displayName = $state('');
	let savingCustomization = $state(false);
	let savedCustomization = $state(false);
	let customizationError = $state<string | null>(null);

	$effect(() => {
		displayName = agent.name || '';
	});

	async function saveCustomization() {
		if (savingCustomization) return;
		savingCustomization = true;
		customizationError = null;
		try {
			// PUT /portal/agent-identity is the live route (portal-chat.js) — it MERGES,
			// so sending only `name` preserves channelWrite/scopes. The old
			// `/portal/agents/:id/customize` route never existed → every save 404'd.
			// A blank name clears to the default (server's agentDisplayName(null)).
			const res = await api('/portal/agent-identity', {
				method: 'PUT',
				body: JSON.stringify({ name: displayName.trim() || null }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			savedCustomization = true;
			setTimeout(() => { savedCustomization = false; }, 1500);
			await onChange?.();
		} catch (e) {
			customizationError = e instanceof Error ? e.message : 'save failed';
		} finally {
			savingCustomization = false;
		}
	}

	// ── Claude subscription assignment ─────────────────────────────────
	const claudeProviders = $derived(
		providers.filter((p: Provider) => p.provider === 'claude' && p.status !== 'quarantined'),
	);

	function currentProviderId(): number | null {
		// Walks the assignment chain server-side for this agent (literal
		// agent_id → fall through to '*' wildcard → null).
		const literal = assignments.find((a: Assignment) => a.agent_id === agent.id);
		if (literal) return literal.provider_id;
		const wild = assignments.find((a: Assignment) => a.agent_id === '*');
		if (wild) return wild.provider_id;
		return null;
	}

	let pendingProvider = $state<number | null | undefined>(undefined);
	const effectiveProvider = $derived(
		pendingProvider !== undefined ? pendingProvider : currentProviderId(),
	);
	const effectiveProviderObj = $derived(
		effectiveProvider != null ? claudeProviders.find((p: Provider) => p.id === effectiveProvider) : null,
	);
	const effectiveEmail = $derived(
		effectiveProviderObj?.label || (effectiveProvider != null ? `Claude #${effectiveProvider}` : 'shared default'),
	);
	const isDirty = $derived(pendingProvider !== undefined && pendingProvider !== currentProviderId());
	const assignment = $derived(assignments.find((a: Assignment) => a.agent_id === agent.id));
	const reconcileFailed = $derived(assignment?.desired_state === 'failed');
	const reconcilePending = $derived(assignment?.desired_state === 'pending');

	let applyingAssignment = $state(false);
	let assignmentError = $state<string | null>(null);

	const runtime = $derived(runtimeAgents.find((r: RuntimeAgent) => r.slug === agent.id));
	const runtimeOk = $derived(runtime?.ok !== false);

	async function applyAssignment() {
		if (!isDirty) return;
		applyingAssignment = true;
		assignmentError = null;
		try {
			const res = await api('/portal/providers/assignments', {
				method: 'POST',
				body: JSON.stringify({
					assignments: [{ agentId: agent.id, providerId: pendingProvider ?? null }],
					reason: 'portal-agents-manage',
				}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			pendingProvider = undefined;
			await onChange?.();
		} catch (e) {
			assignmentError = e instanceof Error ? e.message : 'apply failed';
		} finally {
			applyingAssignment = false;
		}
	}

	// ── Bot tokens (Discord / Telegram / OWNER_TELEGRAM_ID) ────────────
	const myKeys = $derived(secretsState.filter((s: SecretEntry) => s.agentId === agent.id));
	let editingKey = $state<string | null>(null);
	let editingValue = $state('');
	let savingSecret = $state<string | null>(null);
	let secretError = $state<string | null>(null);

	function labelForKey(key: string): string {
		if (key === 'OWNER_TELEGRAM_ID') return 'Operator Telegram ID';
		if (key.startsWith('TELEGRAM_BOT_TOKEN')) return 'Telegram bot token';
		if (key.startsWith('DISCORD_') && key.endsWith('_BOT_TOKEN')) return 'Discord bot token';
		return key;
	}

	function startEdit(key: string) {
		editingKey = key;
		editingValue = '';
		secretError = null;
	}

	function cancelEdit() {
		editingKey = null;
		editingValue = '';
		secretError = null;
	}

	async function saveSecret(key: string) {
		if (!editingValue.trim()) return;
		savingSecret = key;
		secretError = null;
		try {
			const res = await api('/portal/settings/secret', {
				method: 'PUT',
				body: JSON.stringify({
					key,
					value: editingValue.trim(),
					agentId: agent.id,
				}),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			editingKey = null;
			editingValue = '';
			await onChange?.();
		} catch (e) {
			secretError = e instanceof Error ? e.message : 'save failed';
		} finally {
			savingSecret = null;
		}
	}

	async function clearSecret(key: string) {
		if (!confirm(`Clear ${labelForKey(key)} for ${agent.name}? The bot will refuse to start without it until you set a new value.`)) return;
		savingSecret = key;
		secretError = null;
		try {
			const res = await api('/portal/settings/secret', {
				method: 'DELETE',
				body: JSON.stringify({ key, agentId: agent.id }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			await onChange?.();
		} catch (e) {
			secretError = e instanceof Error ? e.message : 'delete failed';
		} finally {
			savingSecret = null;
		}
	}

	// Status dot color: green if online AND runtime reachable; coral if offline.
	const statusColor = $derived(
		agent.status === 'online' && runtimeOk
			? 'var(--color-accent-jade)'
			: 'var(--color-accent-coral)',
	);

	// ── Live status label (identity block) — mirrors the collapsed-header meta,
	//    but as a full-word phrase for the expanded identity summary.
	const statusLabel = $derived(
		agent.status === 'offline'
			? 'Offline'
			: !runtimeOk
				? 'Unreachable'
				: (agent.activeTasks ?? 0) > 0
					? `${agent.activeTasks} active`
					: 'Active',
	);

	// ── Engine (identity block) — which engine powers this agent. A resolved Claude
	//    subscription (literal or wildcard assignment) → Claude; otherwise the local
	//    model. Reuses the same assignment walk the subscription section renders, so
	//    the identity summary and the detail never disagree.
	const engineLabel = $derived(
		effectiveProviderObj
			? `Claude subscription · ${effectiveProviderObj.label || `Claude #${effectiveProviderObj.id}`}`
			: agent.model
				? `Local model · ${agent.model}`
				: 'Local model',
	);

	// ── Personality one-liner (identity block, READ-ONLY) — a preview of the agent's
	//    "being" (mind/self.md), authored on the Character page. We surface the first
	//    meaningful line here so the operator sees WHO the agent is without leaving the
	//    tab; editing stays on the Character page ("Refine on the character page →").
	//    Only the personal agent has a character capsule today, so scope the fetch to it.
	let personaLine = $state<string | null>(null);
	let personaLoaded = $state(false);

	function firstMeaningfulLine(md: string): string | null {
		for (const raw of md.split('\n')) {
			const line = raw.replace(/^#+\s*/, '').replace(/^[-*>]\s*/, '').trim();
			if (line) return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
		}
		return null;
	}

	$effect(() => {
		// Lazy: only when the row is expanded for the character-bearing agent, once.
		if (!expanded || personaLoaded || agent.id !== 'personal-agent') return;
		personaLoaded = true;
		api('/portal/character/being')
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { personaLine = d?.content ? firstMeaningfulLine(d.content) : null; })
			.catch(() => { personaLine = null; });
	});
</script>

<div class="agent-row card" class:expanded={expanded} class:dirty={isDirty}>
	<button
		type="button"
		class="header"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}>
		<span class="dot" style:background={statusColor} class:pulse={(agent.activeTasks ?? 0) > 0}></span>
		<span class="name">{agent.name}</span>
		<span class="id">{agent.id}</span>
		<span class="role">{agent.role || ''}</span>
		<span class="meta">
			{#if agent.status === 'offline'}offline
			{:else if !runtimeOk}unreachable
			{:else if (agent.activeTasks ?? 0) > 0}{agent.activeTasks} active
			{:else}idle{/if}
		</span>
		{#if agent.model}<span class="model">{agent.model}</span>{/if}
		{#if lastActivity}<span class="last-activity" title="Most recent agent activity">{lastActivity}</span>{/if}
		<span class="caret">{expanded ? '▾' : '▸'}</span>
	</button>

	{#if expanded}
		<div class="body">
			<!-- Identity block — name (editable) · engine + live status · personality
			     one-liner (read-only, refine on the character page). No avatar/emoji here. -->
			<section class="block identity">
				<!-- Engine + live status -->
				<div class="engine-status">
					<span class="status-pill">
						<span class="dot sm" style:background={statusColor} class:pulse={(agent.activeTasks ?? 0) > 0}></span>
						<span class="status-text">{statusLabel}</span>
						{#if lastActivity}<span class="status-sep">·</span><span class="status-when">{lastActivity}</span>{/if}
					</span>
					<span class="engine" title="Which engine powers this agent">{engineLabel}</span>
				</div>

				<!-- Name (editable) -->
				<label class="field">
					<span>Agent name</span>
					<input
						type="text"
						bind:value={displayName}
						placeholder={agent.defaultName || agent.id}
						maxlength="50"
					/>
				</label>
				<div class="actions">
					<button onclick={saveCustomization} disabled={savingCustomization}>
						{#if savedCustomization}Saved ✓{:else if savingCustomization}Saving…{:else}Save{/if}
					</button>
					{#if customizationError}<span class="err">{customizationError}</span>{/if}
				</div>

				{#if agent.id === 'personal-agent'}
					<!-- Personality one-liner (read-only) — the full "being" + voice are
					     authored on the character page (design §5/§6), not duplicated here. -->
					<div class="field persona">
						<span>Personality</span>
						<p class="persona-line" class:empty={!personaLine}>
							{personaLine || 'No character set yet — give your agent a personality.'}
						</p>
						<button type="button" class="char-link" onclick={() => workspace.openFromRoute('character', { id: agent.id })}>
							Refine on the character page →
						</button>
					</div>
				{/if}
			</section>

			<!-- Claude subscription -->
			{#if claudeProviders.length > 0}
				<section class="block">
					<h3>Claude subscription</h3>
					<div class="status-line">
						{#if !runtimeOk}
							<span class="warn">Agent unreachable: {runtime?.error || 'unknown'}</span>
						{:else if reconcileFailed}
							<span class="warn">Reconcile failed: {assignment?.last_error || 'unknown'}</span>
						{:else if reconcilePending}
							<span class="pending">Pending reconcile…</span>
						{:else}
							Using <span class="email">{effectiveEmail}</span>
						{/if}
					</div>
					<div class="actions">
						<select
							value={effectiveProvider == null ? '' : String(effectiveProvider)}
							onchange={(e) => {
								const v = (e.currentTarget as HTMLSelectElement).value;
								pendingProvider = v === '' ? null : parseInt(v, 10);
							}}>
							<option value="">Use shared default</option>
							{#each claudeProviders as p (p.id)}
								<option value={String(p.id)}>{p.label || `Claude #${p.id}`}</option>
							{/each}
						</select>
						<button onclick={applyAssignment} disabled={!isDirty || applyingAssignment}>
							{applyingAssignment ? 'Applying…' : 'Apply'}
						</button>
						{#if isDirty}
							<button class="ghost" onclick={() => (pendingProvider = undefined)}>Discard</button>
						{/if}
					</div>
					{#if assignmentError}<span class="err">{assignmentError}</span>{/if}
				</section>
			{/if}

			<!-- Bot tokens -->
			{#if myKeys.length > 0}
				<section class="block">
					<h3>Bot tokens</h3>
					<div class="secrets">
						{#each myKeys as entry (entry.key)}
							<div class="secret-row">
								<div class="secret-info">
									<span class="secret-label">{labelForKey(entry.key)}</span>
									<span class="secret-key">{entry.key}</span>
								</div>
								{#if editingKey === entry.key}
									<div class="secret-edit">
										<input
											type="password"
											bind:value={editingValue}
											placeholder="paste new value"
											autocomplete="off"
										/>
										<button
											onclick={() => saveSecret(entry.key)}
											disabled={savingSecret === entry.key || !editingValue.trim()}>
											{savingSecret === entry.key ? 'Saving…' : 'Save'}
										</button>
										<button class="ghost" onclick={cancelEdit}>Cancel</button>
									</div>
								{:else}
									<div class="secret-status">
										<span class="badge" class:set={entry.set}>{entry.set ? 'set' : 'not set'}</span>
										<button class="ghost" onclick={() => startEdit(entry.key)}>
											{entry.set ? 'Change' : 'Set'}
										</button>
										{#if entry.set}
											<button class="ghost danger" onclick={() => clearSecret(entry.key)} disabled={savingSecret === entry.key}>
												Clear
											</button>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
					{#if secretError}<span class="err">{secretError}</span>{/if}
					<p class="hint">
						Setting a Telegram token auto-restarts the bot. Discord token changes auto-restart the bot too. Values are encrypted before leaving this device.
					</p>
				</section>
			{/if}

			<!-- Reflection cycles — this agent's autonomous wake rhythms (opt-in, per-agent).
			     Only the personal agent runs cycles today; the section self-scopes to it. -->
			{#if agent.id === 'personal-agent'}
				<section class="block">
					<ReflectionCyclesSection />
				</section>
			{/if}

			<!-- Read-only details -->
			<section class="block details">
				<h3>Details</h3>
				<dl>
					<dt>Agent ID</dt>
					<dd>{agent.id}</dd>
					{#if agent.role}<dt>Role</dt><dd>{agent.role}</dd>{/if}
					{#if agent.port}<dt>Port</dt><dd>{agent.port}</dd>{/if}
					{#if agent.model}<dt>Model</dt><dd>{agent.model}</dd>{/if}
					{#if runtime?.configDir}<dt>Claude config</dt><dd>{runtime.configDir}</dd>{/if}
				</dl>
			</section>
		</div>
	{/if}
</div>

<style>
	.agent-row {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border);
		border-radius: 0.625rem;
		background: var(--color-surface);
		overflow: hidden;
	}
	.agent-row.dirty {
		border-color: var(--color-accent);
	}

	.header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		font: inherit;
		color: inherit;
		width: 100%;
	}
	.header:hover {
		background: var(--color-elevated);
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		flex-shrink: 0;
	}
	.dot.pulse {
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}
	.id {
		font-size: 0.65rem;
		font-family: ui-monospace, monospace;
		color: var(--color-text-tertiary);
	}
	.role {
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		margin-left: auto;
	}
	.meta {
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		min-width: 4rem;
		text-align: right;
	}
	.model {
		font-size: 0.6rem;
		font-family: ui-monospace, monospace;
		color: var(--color-text-tertiary);
		padding: 0.1rem 0.35rem;
		border-radius: 0.25rem;
		background: var(--color-elevated);
	}
	.last-activity {
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		white-space: nowrap;
	}
	.caret {
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
	}

	.body {
		padding: 0.5rem 1rem 1rem;
		border-top: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.block h3 {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-tertiary);
		font-weight: 500;
		margin: 0;
	}

	/* ── Identity block ─────────────────────────────────────────────── */
	.identity {
		gap: 0.65rem;
	}
	.engine-status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}
	.status-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: var(--color-elevated);
		font-size: 0.65rem;
		color: var(--color-text-secondary);
	}
	.dot.sm {
		width: 0.45rem;
		height: 0.45rem;
	}
	.status-sep { color: var(--color-text-tertiary); }
	.status-when { color: var(--color-text-tertiary); }
	.engine {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--color-border);
	}
	.persona {
		gap: 0.35rem;
	}
	.persona-line {
		margin: 0;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--color-text-primary);
	}
	.persona-line.empty {
		color: var(--color-text-tertiary);
		font-style: italic;
	}
	.char-link {
		align-self: flex-start;
		padding: 0;
		background: transparent;
		border: none;
		color: var(--color-accent);
		font-size: 0.7rem;
		cursor: pointer;
	}
	.char-link:hover {
		text-decoration: underline;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.7rem;
		color: var(--color-text-secondary);
	}
	input, select {
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 0.35rem;
		background: var(--color-bg);
		color: var(--color-text-primary);
		font-size: 0.8rem;
	}
	input:focus, select:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.7rem;
	}
	button {
		padding: 0.35rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--color-accent);
		background: var(--color-accent);
		color: var(--color-bg);
		font-size: 0.7rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button.ghost {
		background: transparent;
		color: var(--color-text-tertiary);
		border-color: transparent;
	}
	button.ghost:hover {
		color: var(--color-text-primary);
	}
	button.ghost.danger:hover {
		color: var(--color-accent-coral);
	}

	.status-line {
		font-size: 0.7rem;
		color: var(--color-text-secondary);
	}
	.email { color: var(--color-text-secondary); }
	.warn { color: var(--color-accent-coral); }
	.pending { color: var(--color-accent-aurum); }
	.err { font-size: 0.65rem; color: var(--color-accent-coral); }
	.hint {
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		margin: 0;
	}

	.secrets {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.secret-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-elevated);
		border-radius: 0.35rem;
	}
	.secret-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}
	.secret-label {
		font-size: 0.75rem;
		color: var(--color-text-primary);
	}
	.secret-key {
		font-size: 0.6rem;
		font-family: ui-monospace, monospace;
		color: var(--color-text-tertiary);
	}
	.secret-status, .secret-edit {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.secret-edit input {
		min-width: 16rem;
	}
	.badge {
		font-size: 0.55rem;
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		background: var(--color-bg);
		color: var(--color-text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.badge.set {
		background: var(--color-accent-jade);
		color: var(--color-bg);
	}

	.details dl {
		display: grid;
		grid-template-columns: 8rem 1fr;
		gap: 0.25rem 1rem;
		font-size: 0.7rem;
		margin: 0;
	}
	.details dt {
		color: var(--color-text-tertiary);
	}
	.details dd {
		color: var(--color-text-secondary);
		font-family: ui-monospace, monospace;
		margin: 0;
		word-break: break-all;
	}
</style>
