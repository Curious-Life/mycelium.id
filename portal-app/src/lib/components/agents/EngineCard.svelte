<!--
  EngineCard — "what powers it, and what credentials does it hold?"

  The three sections that used to be buried inside the Manage tab's accordion-of-one
  (AgentRow): the Claude subscription assignment, the per-agent bot tokens
  (agent-secret-policy), and the read-only runtime details.
-->
<script lang="ts">
	import { api } from '$lib/api';
	import AgentCard from './AgentCard.svelte';

	type Provider = { id: number; provider: string; label?: string | null; status?: string; config_dir?: string | null };
	type Assignment = { agent_id: string; provider_id: number; desired_state: 'pending' | 'applied' | 'failed'; applied_at?: string | null; last_error?: string | null };
	type RuntimeAgent = { slug: string; name?: string; port?: number; configDir?: string | null; ok: boolean; error?: string | null };
	type SecretEntry = { agentId: string; key: string; set: boolean };

	let {
		agent,
		providers = [],
		assignments = [],
		runtime = null,
		secretsState = [],
		loading = false,
		onChange,
	} = $props<{
		agent: { id: string; role?: string | null; port?: number; model?: string | null };
		providers?: Provider[];
		assignments?: Assignment[];
		runtime?: RuntimeAgent | null;
		secretsState?: SecretEntry[];
		loading?: boolean;
		onChange?: () => void | Promise<void>;
	}>();

	// ── Claude subscription ────────────────────────────────────────────────────
	const claudeProviders = $derived(providers.filter((p: Provider) => p.provider === 'claude' && p.status !== 'quarantined'));

	function currentProviderId(): number | null {
		// The server's assignment chain: literal agent_id → '*' wildcard → null.
		const literal = assignments.find((a: Assignment) => a.agent_id === agent.id);
		if (literal) return literal.provider_id;
		const wild = assignments.find((a: Assignment) => a.agent_id === '*');
		if (wild) return wild.provider_id;
		return null;
	}

	let pendingProvider = $state<number | null | undefined>(undefined);
	const effectiveProvider = $derived(pendingProvider !== undefined ? pendingProvider : currentProviderId());
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
	const runtimeOk = $derived(runtime?.ok !== false);

	let applying = $state(false);
	let assignmentError = $state<string | null>(null);

	async function applyAssignment() {
		if (!isDirty) return;
		applying = true;
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
			applying = false;
		}
	}

	// ── Bot tokens ─────────────────────────────────────────────────────────────
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

	function startEdit(key: string) { editingKey = key; editingValue = ''; secretError = null; }
	function cancelEdit() { editingKey = null; editingValue = ''; secretError = null; }

	async function saveSecret(key: string) {
		if (!editingValue.trim()) return;
		savingSecret = key;
		secretError = null;
		try {
			const res = await api('/portal/settings/secret', {
				method: 'PUT',
				body: JSON.stringify({ key, value: editingValue.trim(), agentId: agent.id }),
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
		if (!confirm(`Clear ${labelForKey(key)}? The bot will refuse to start without it until you set a new value.`)) return;
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
</script>

<AgentCard title="Engine & credentials" loading={loading}>
	{#if claudeProviders.length > 0}
		<div class="sub">
			<h3>Claude subscription</h3>
			<p class="state">
				{#if !runtimeOk}
					<span class="warn">Agent unreachable: {runtime?.error || 'unknown'}</span>
				{:else if reconcileFailed}
					<span class="warn">Reconcile failed: {assignment?.last_error || 'unknown'}</span>
				{:else if reconcilePending}
					<span class="pending">Pending reconcile…</span>
				{:else}
					Using <strong>{effectiveEmail}</strong>
				{/if}
			</p>
			<div class="row">
				<select
					aria-label="Claude subscription"
					value={effectiveProvider == null ? '' : String(effectiveProvider)}
					onchange={(e) => {
						const v = (e.currentTarget as HTMLSelectElement).value;
						pendingProvider = v === '' ? null : parseInt(v, 10);
					}}
				>
					<option value="">Use shared default</option>
					{#each claudeProviders as p (p.id)}
						<option value={String(p.id)}>{p.label || `Claude #${p.id}`}</option>
					{/each}
				</select>
				<button class="primary" onclick={applyAssignment} disabled={!isDirty || applying}>
					{applying ? 'Applying…' : 'Apply'}
				</button>
				{#if isDirty}
					<button class="ghost" onclick={() => (pendingProvider = undefined)}>Discard</button>
				{/if}
			</div>
			{#if assignmentError}<p class="err">{assignmentError}</p>{/if}
		</div>
	{/if}

	{#if myKeys.length > 0}
		<div class="sub">
			<h3>Bot tokens</h3>
			<div class="secrets">
				{#each myKeys as entry (entry.key)}
					<div class="secret">
						<div class="secret-info">
							<span class="secret-label">{labelForKey(entry.key)}</span>
							<span class="secret-key">{entry.key}</span>
						</div>
						{#if editingKey === entry.key}
							<div class="row wrap">
								<input type="password" bind:value={editingValue} placeholder="paste new value" autocomplete="off" />
								<button class="primary" onclick={() => saveSecret(entry.key)} disabled={savingSecret === entry.key || !editingValue.trim()}>
									{savingSecret === entry.key ? 'Saving…' : 'Save'}
								</button>
								<button class="ghost" onclick={cancelEdit}>Cancel</button>
							</div>
						{:else}
							<div class="row">
								<span class="badge" class:set={entry.set}>{entry.set ? 'set' : 'not set'}</span>
								<button class="ghost" onclick={() => startEdit(entry.key)}>{entry.set ? 'Change' : 'Set'}</button>
								{#if entry.set}
									<button class="ghost danger" onclick={() => clearSecret(entry.key)} disabled={savingSecret === entry.key}>Clear</button>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
			{#if secretError}<p class="err">{secretError}</p>{/if}
			<p class="note">Setting a Telegram or Discord token auto-restarts that bot. Values are encrypted before leaving this device.</p>
		</div>
	{/if}

	<details class="details">
		<summary>Runtime details</summary>
		<dl>
			<dt>Agent ID</dt><dd>{agent.id}</dd>
			{#if agent.role}<dt>Role</dt><dd>{agent.role}</dd>{/if}
			{#if agent.port}<dt>Port</dt><dd>{agent.port}</dd>{/if}
			{#if agent.model}<dt>Model</dt><dd>{agent.model}</dd>{/if}
			{#if runtime?.configDir}<dt>Claude config</dt><dd>{runtime.configDir}</dd>{/if}
		</dl>
	</details>
</AgentCard>

<style>
	.sub { margin-top: 0.75rem; }
	.sub + .sub { padding-top: 0.85rem; border-top: 1px solid var(--color-border); }
	h3 {
		margin: 0 0 0.35rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}
	.state { margin: 0 0 0.5rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.state strong { font-weight: 500; color: var(--color-text-primary); }
	.warn { color: var(--color-accent-coral); }
	.pending { color: var(--color-accent-aurum); }

	.row { display: flex; align-items: center; gap: 0.4rem; }
	.row.wrap { flex-wrap: wrap; }

	select, input {
		flex: 1;
		min-width: 0;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 7px;
		background: var(--color-bg);
		color: var(--color-text-primary);
		font: inherit;
		font-size: 0.75rem;
	}
	select:focus, input:focus { outline: none; border-color: var(--color-accent); }

	button {
		flex-shrink: 0;
		padding: 0.32rem 0.65rem;
		border-radius: 7px;
		border: 1px solid transparent;
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
	}
	/* The filled button paints the app background as its LABEL colour — the pairing
	   that keeps contrast on the light theme's accent too (see CharacterView D-024). */
	button.primary { background: var(--color-accent); color: var(--color-bg); }
	button.ghost { background: transparent; color: var(--color-text-secondary); border-color: var(--color-border); }
	button.ghost:hover { color: var(--color-text-primary); }
	button.ghost.danger:hover { color: var(--color-accent-coral); border-color: var(--color-accent-coral); }
	button:disabled { opacity: 0.5; cursor: default; }

	.secrets { display: flex; flex-direction: column; gap: 0.45rem; }
	.secret {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.5rem 0.6rem;
		border-radius: 8px;
		background: var(--color-elevated);
	}
	.secret-info { display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
	.secret-label { font-size: 0.74rem; color: var(--color-text-primary); }
	.secret-key { font-family: var(--font-mono); font-size: 0.58rem; color: var(--color-text-tertiary); word-break: break-all; }
	.badge {
		font-size: 0.55rem;
		padding: 0.12rem 0.4rem;
		border-radius: 999px;
		background: var(--color-bg);
		color: var(--color-text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.badge.set { background: var(--color-accent-jade); color: var(--color-bg); }

	.note { margin: 0.5rem 0 0; font-size: 0.62rem; line-height: 1.45; color: var(--color-text-tertiary); }
	.err { margin: 0.45rem 0 0; font-size: 0.68rem; color: var(--color-accent-coral); }

	.details { margin-top: 0.85rem; padding-top: 0.8rem; border-top: 1px solid var(--color-border); }
	summary {
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker { display: none; }
	summary::before { content: '▸ '; }
	.details[open] summary::before { content: '▾ '; }
	summary:hover { color: var(--color-text-secondary); }
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 0.75rem;
		margin: 0.55rem 0 0;
		font-size: 0.68rem;
	}
	dt { color: var(--color-text-tertiary); }
	dd { margin: 0; font-family: var(--font-mono); color: var(--color-text-secondary); word-break: break-all; }
</style>
