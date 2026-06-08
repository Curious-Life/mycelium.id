<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';

	// Props
	let { showTitle = true, compact = false }: { showTitle?: boolean; compact?: boolean } = $props();

	let expandedStep: string | null = $state(null);

	// AI state
	// Default to the API-key path: it's the one that actually powers portal
	// inference (writes ai_providers, read by the inference router). The "Claude
	// Code" subscription-OAuth path is not supported in V1 (server refuses it).
	let aiProvider: 'claude' | 'api' = $state('api');
	let aiSubProvider: 'anthropic' | 'openai' = $state('anthropic');
	let aiKeyInput = $state('');
	let aiKeySaving = $state(false);
	let aiKeySaved = $state(false);
	let aiKeyError = $state('');
	let claudeAuthLoading = $state(false);
	let claudeAuthDone = $state(false);
	let claudeAuthError = $state('');
	let claudeAuthUrl = $state('');
	let claudeAuthCode = $state('');
	let claudeEmail = $state<string | null>(null);
	let claudeSubscription = $state<string | null>(null);

	// Integration state
	let telegramTokenInput = $state('');
	let telegramIdInput = $state('');
	let discordTokenInput = $state('');
	let integrationSaving = $state(false);
	let integrationSaved: string | null = $state(null);

	// Check Claude status on mount
	$effect(() => {
		if (browser && !claudeAuthDone) {
			api('/portal/auth/claude/status').then(async (res) => {
				if (res.ok) {
					const data = await res.json();
					if (data.authenticated) claudeAuthDone = true;
					claudeEmail = data.email || null;
					claudeSubscription = data.subscriptionType || null;
				}
			}).catch(() => {});
		}
	});

	async function connectClaude() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		claudeAuthUrl = '';
		try {
			const res = await api('/portal/auth/claude', { method: 'POST' });
			if (!res.ok) throw new Error('Failed to start auth');
			const data = await res.json();
			if (data.url) {
				claudeAuthUrl = data.url;
				window.open(data.url, '_blank');
			} else {
				throw new Error('No auth URL returned');
			}
		} catch (e: any) {
			claudeAuthError = e.message || 'Connection failed';
		}
		claudeAuthLoading = false;
	}

	async function submitClaudeCode() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		try {
			const res = await api('/portal/auth/claude/code', {
				method: 'POST',
				body: JSON.stringify({ code: claudeAuthCode.trim() }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to authenticate');
			claudeAuthDone = true;
			claudeAuthUrl = '';
			claudeAuthCode = '';
			// Re-fetch status to get email/plan
			const statusRes = await api('/portal/auth/claude/status');
			if (statusRes.ok) {
				const s = await statusRes.json();
				claudeEmail = s.email || null;
				claudeSubscription = s.subscriptionType || null;
			}
			if (data.greeting) {
				const { navigationState } = await import('$lib/stores/navigation');
				setTimeout(() => navigationState.setChatOpen(true), 600);
			}
		} catch (e: any) {
			claudeAuthError = e.message || 'Authentication failed';
		}
		claudeAuthLoading = false;
	}

	async function saveAiKey() {
		aiKeySaving = true;
		aiKeyError = '';
		aiKeySaved = false;
		try {
			// Write to ai_providers (the inference router reads this via getActive) —
			// NOT /portal/settings/secret, whose keys never reach the portal router.
			const provider = aiSubProvider === 'anthropic' ? 'anthropic' : 'openai';
			const res = await api('/portal/providers', {
				method: 'POST',
				body: JSON.stringify({ provider, api_key: aiKeyInput.trim() }),
			});
			if (!res.ok) throw new Error('Failed to save');
			aiKeySaved = true;
			setTimeout(() => { aiKeySaved = false; }, 3000);
		} catch (e: any) {
			aiKeyError = e.message || 'Failed to save key';
		}
		aiKeySaving = false;
	}

	async function saveIntegration(key: string, value: string, scope: string) {
		integrationSaving = true;
		integrationSaved = null;
		try {
			const res = await api('/portal/settings/secret', {
				method: 'PUT',
				body: JSON.stringify({ key, value: value.trim(), scope }),
			});
			if (!res.ok) throw new Error('Failed to save');
			const tag = key.includes('TELEGRAM') ? 'telegram' : 'discord';
			integrationSaved = tag;
			setTimeout(() => { integrationSaved = null; }, 3000);
		} catch {}
		integrationSaving = false;
	}
</script>

<div class="connections-checklist" class:compact>
	{#if showTitle}
		<h2 class="checklist-title">Connections</h2>
	{/if}

	<!-- 1. Connect AI -->
	<button class="checklist-step" onclick={() => expandedStep = expandedStep === 'ai' ? null : 'ai'}>
		<div class="step-icon">&#10024;</div>
		<div class="step-content">
			<div class="step-name">Connect AI</div>
			<div class="step-desc">
				{#if claudeAuthDone}
					{claudeEmail || 'Claude Code'}{claudeSubscription ? ` · ${claudeSubscription}` : ''}
				{:else}
					Authenticate Claude Code or add an API key
				{/if}
			</div>
		</div>
		{#if claudeAuthDone}
			<div class="step-status connected">Connected</div>
		{:else}
			<div class="step-status pending">Required</div>
		{/if}
		<div class="step-arrow">{expandedStep === 'ai' ? '\u25B4' : '\u25BE'}</div>
	</button>
	{#if expandedStep === 'ai'}
		<div class="step-guide">
			<div class="guide-tabs">
				<button class:active={aiProvider === 'claude'} onclick={() => aiProvider = 'claude'}>Claude Code</button>
				<button class:active={aiProvider === 'api'} onclick={() => aiProvider = 'api'}>API Key</button>
			</div>

			{#if aiProvider === 'claude'}
				{#if claudeAuthDone}
					<div class="guide-hero" style="border-left: 2px solid #4ade80;">
						<p><strong style="color: #4ade80;">&#10003; Connected</strong> &mdash; {claudeEmail || 'Claude Code authenticated'}{claudeSubscription ? ` (${claudeSubscription})` : ''}</p>
					</div>
				{:else if claudeAuthUrl}
					<div class="guide-steps-compact">
						<div class="gsc-step"><span class="gsc-num">1</span> Sign in on the page that just opened</div>
						<div class="gsc-step"><span class="gsc-num">2</span> Copy the code shown after signing in</div>
						<div class="gsc-step"><span class="gsc-num">3</span> Paste it below</div>
					</div>
					<div class="guide-input-row">
						<input type="text" bind:value={claudeAuthCode} placeholder="Paste the code here" autocomplete="off" data-1p-ignore class="guide-input" />
						<button class="guide-save-btn" disabled={!claudeAuthCode || claudeAuthLoading} onclick={submitClaudeCode}>
							{claudeAuthLoading ? 'Connecting...' : 'Connect'}
						</button>
					</div>
					<p style="font-size: 0.65rem; color: var(--color-text-tertiary); margin-top: 0.35rem;">
						Window didn't open? <a href={claudeAuthUrl} target="_blank" rel="noopener" style="color: var(--color-accent-aurum);">Click here</a>
					</p>
				{:else}
					<div class="guide-hero">
						<p><strong>Recommended</strong> &mdash; use your existing Claude subscription</p>
						<p>No API key needed. Your agents use Claude Code directly.</p>
					</div>
					<button class="guide-connect-btn" disabled={claudeAuthLoading} onclick={connectClaude}>
						{claudeAuthLoading ? 'Starting...' : 'Connect with Claude \u2192'}
					</button>
				{/if}
				{#if claudeAuthError}
					<p class="guide-error">{claudeAuthError}</p>
				{/if}
			{:else}
				<div class="guide-tabs-sub">
					<button class:active={aiSubProvider === 'anthropic'} onclick={() => aiSubProvider = 'anthropic'}>Anthropic API</button>
					<button class:active={aiSubProvider === 'openai'} onclick={() => aiSubProvider = 'openai'}>OpenAI API</button>
				</div>

				{#if aiSubProvider === 'anthropic'}
					<p>1. Open <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> &rarr; API Keys</p>
					<p>2. Create a key and paste it below</p>
				{:else}
					<p>1. Open <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a> &rarr; API Keys</p>
					<p>2. Create a key and paste it below</p>
				{/if}

				<div class="guide-input-row">
					<input type="text" bind:value={aiKeyInput} placeholder={aiSubProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'} autocomplete="off" data-1p-ignore class="guide-input" />
					<button class="guide-save-btn" disabled={!aiKeyInput || aiKeySaving} onclick={saveAiKey}>
						{aiKeySaving ? 'Saving...' : aiKeySaved ? '\u2713 Saved' : 'Save'}
					</button>
				</div>
				{#if aiKeyError}
					<p class="guide-error">{aiKeyError}</p>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- 2. Import Data -->
	<button class="checklist-step" onclick={() => expandedStep = expandedStep === 'import' ? null : 'import'}>
		<div class="step-icon">&#128206;</div>
		<div class="step-content">
			<div class="step-name">Import data</div>
			<div class="step-desc">Bring in your existing conversations and contacts</div>
		</div>
		<div class="step-status optional">Quick start</div>
		<div class="step-arrow">{expandedStep === 'import' ? '\u25B4' : '\u25BE'}</div>
	</button>
	{#if expandedStep === 'import'}
		<div class="step-guide">
			<div class="data-sources">
				<div class="data-source"><span class="ds-icon">&#128101;</span><span class="ds-name">LinkedIn</span><span class="ds-desc">Connections, messages</span><span class="ds-format">ZIP</span></div>
				<div class="data-source"><span class="ds-icon">&#128221;</span><span class="ds-name">Obsidian</span><span class="ds-desc">Markdown vault</span><span class="ds-format">ZIP</span></div>
				<div class="data-source"><span class="ds-icon">&#129302;</span><span class="ds-name">ChatGPT</span><span class="ds-desc">Conversation export</span><span class="ds-format">JSON</span></div>
				<div class="data-source"><span class="ds-icon">&#10024;</span><span class="ds-name">Claude</span><span class="ds-desc">Chat history</span><span class="ds-format">JSON</span></div>
			</div>
			<p style="margin-top: 0.75rem;"><a href="/import" style="color: var(--color-accent);">Go to Import &rarr;</a></p>
		</div>
	{/if}

	<!-- 3. Telegram -->
	<button class="checklist-step" onclick={() => expandedStep = expandedStep === 'telegram' ? null : 'telegram'}>
		<div class="step-icon">&#9993;</div>
		<div class="step-content">
			<div class="step-name">Connect Telegram</div>
			<div class="step-desc">Talk to your agent from Telegram</div>
		</div>
		<div class="step-status optional">Optional</div>
		<div class="step-arrow">{expandedStep === 'telegram' ? '\u25B4' : '\u25BE'}</div>
	</button>
	{#if expandedStep === 'telegram'}
		<div class="step-guide">
			<p>1. Open Telegram, message <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a></p>
			<p>2. Send <code>/newbot</code>, choose a name, paste the token below</p>
			<div class="guide-input-row">
				<input type="text" bind:value={telegramTokenInput} placeholder="bot token: 123456:ABC-DEF..." autocomplete="off" data-1p-ignore class="guide-input" />
			</div>
			<p style="margin-top: 0.5rem;">3. Your Telegram user ID — send <code>/start</code> to <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a></p>
			<div class="guide-input-row">
				<input type="text" bind:value={telegramIdInput} placeholder="your user id: 123456789" autocomplete="off" data-1p-ignore class="guide-input" />
				<button class="guide-save-btn" disabled={!telegramTokenInput || !telegramIdInput || integrationSaving} onclick={async () => {
					integrationSaving = true;
					try {
						await api('/portal/settings/secret', { method: 'PUT', body: JSON.stringify({ key: 'OWNER_TELEGRAM_ID', value: telegramIdInput.trim(), scope: 'personal' }) });
						await saveIntegration('TELEGRAM_BOT_TOKEN', telegramTokenInput, 'personal');
						integrationSaved = 'telegram';
						telegramTokenInput = '';
						telegramIdInput = '';
						setTimeout(() => { integrationSaved = null; }, 3000);
					} catch { /* */ }
					integrationSaving = false;
				}}>
					{integrationSaving ? 'Saving...' : integrationSaved === 'telegram' ? '\u2713 Saved' : 'Save'}
				</button>
			</div>
		</div>
	{/if}

	<!-- 4. Discord -->
	<button class="checklist-step" onclick={() => expandedStep = expandedStep === 'discord' ? null : 'discord'}>
		<div class="step-icon">&#128172;</div>
		<div class="step-content">
			<div class="step-name">Connect Discord</div>
			<div class="step-desc">Add your agent to a Discord server</div>
		</div>
		<div class="step-status optional">Optional</div>
		<div class="step-arrow">{expandedStep === 'discord' ? '\u25B4' : '\u25BE'}</div>
	</button>
	{#if expandedStep === 'discord'}
		<div class="step-guide">
			<p>1. Open <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers</a></p>
			<p>2. New Application &rarr; Bot &rarr; Reset Token, paste below</p>
			<div class="guide-input-row">
				<input type="text" bind:value={discordTokenInput} placeholder="Bot token..." autocomplete="off" data-1p-ignore class="guide-input" />
				<button class="guide-save-btn" disabled={!discordTokenInput || integrationSaving} onclick={() => saveIntegration('DISCORD_BOT_TOKEN', discordTokenInput, 'org')}>
					{integrationSaving ? 'Saving...' : integrationSaved === 'discord' ? '\u2713 Saved' : 'Save'}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.connections-checklist { display: flex; flex-direction: column; gap: 2px; }
	.checklist-title {
		font-size: 0.7rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--color-text-tertiary); margin-bottom: 0.5rem;
	}
	.checklist-step {
		display: flex; align-items: center; gap: 0.75rem;
		padding: 0.75rem 0.85rem; border-radius: 8px;
		background: none; border: 1px solid var(--color-border);
		cursor: pointer; transition: border-color 0.2s;
		font-family: inherit; text-align: left; width: 100%;
		color: inherit;
	}
	.checklist-step:hover { border-color: var(--color-accent); }
	.step-icon { font-size: 1rem; flex-shrink: 0; }
	.step-content { flex: 1; min-width: 0; }
	.step-name { font-size: 0.82rem; font-weight: 500; color: var(--color-text-primary); }
	.step-desc { font-size: 0.68rem; color: var(--color-text-tertiary); margin-top: 1px; }
	.step-status {
		font-size: 0.6rem; font-weight: 500; padding: 2px 8px; border-radius: 10px;
		white-space: nowrap;
	}
	.step-status.connected { background: rgba(74, 222, 128, 0.1); color: #4ade80; }
	.step-status.pending { background: rgba(229, 184, 76, 0.1); color: var(--color-accent); }
	.step-status.optional { background: rgba(148, 148, 158, 0.1); color: var(--color-text-tertiary); }
	.step-arrow { font-size: 0.65rem; color: var(--color-text-tertiary); flex-shrink: 0; }

	.step-guide {
		padding: 0.75rem 0.85rem; margin-top: -1px;
		border: 1px solid var(--color-border); border-top: none;
		border-radius: 0 0 8px 8px;
		font-size: 0.78rem; color: var(--color-text-secondary);
	}
	.step-guide p { margin-bottom: 0.4rem; line-height: 1.5; }
	.step-guide a { color: var(--color-accent); }
	.step-guide code { font-family: var(--font-mono); font-size: 0.72rem; background: var(--color-elevated); padding: 1px 4px; border-radius: 3px; }

	.guide-tabs, .guide-tabs-sub { display: flex; gap: 2px; margin-bottom: 0.75rem; }
	.guide-tabs button, .guide-tabs-sub button {
		padding: 4px 12px; border: 1px solid var(--color-border); border-radius: 6px;
		background: none; font-size: 0.7rem; color: var(--color-text-tertiary);
		cursor: pointer; font-family: inherit;
	}
	.guide-tabs button.active, .guide-tabs-sub button.active {
		background: var(--color-accent); color: var(--color-bg); border-color: var(--color-accent);
	}

	.guide-hero {
		padding: 0.6rem 0.75rem; border-radius: 6px; margin-bottom: 0.75rem;
		background: var(--color-elevated); font-size: 0.75rem;
	}
	.guide-hero p { margin-bottom: 0.25rem; }

	.guide-input-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
	.guide-input {
		flex: 1; padding: 0.45rem 0.6rem; border-radius: 6px; font-size: 0.75rem;
		border: 1px solid var(--color-border); background: var(--color-elevated);
		color: var(--color-text-primary); font-family: var(--font-mono);
	}
	.guide-save-btn, .guide-connect-btn {
		padding: 0.45rem 1rem; border-radius: 6px; border: none;
		background: var(--color-accent); color: var(--color-bg);
		font-size: 0.72rem; font-weight: 500; cursor: pointer; font-family: inherit;
		white-space: nowrap;
	}
	.guide-save-btn:disabled, .guide-connect-btn:disabled { opacity: 0.5; cursor: default; }
	.guide-error { color: #ef4444; font-size: 0.7rem; margin-top: 0.4rem; }

	.guide-steps-compact { margin-bottom: 0.5rem; }
	.gsc-step { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; font-size: 0.75rem; }
	.gsc-num {
		width: 18px; height: 18px; border-radius: 50%;
		background: var(--color-accent); color: var(--color-bg);
		display: flex; align-items: center; justify-content: center;
		font-size: 0.6rem; font-weight: 600; flex-shrink: 0;
	}

	.data-sources { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
	.data-source {
		display: flex; align-items: center; gap: 0.4rem;
		padding: 0.4rem 0.6rem; border-radius: 6px;
		background: var(--color-elevated); font-size: 0.7rem;
	}
	.ds-icon { font-size: 0.85rem; }
	.ds-name { font-weight: 500; color: var(--color-text-primary); }
	.ds-desc { color: var(--color-text-tertiary); font-size: 0.6rem; }
	.ds-format { margin-left: auto; font-size: 0.55rem; color: var(--color-text-tertiary); font-family: var(--font-mono); }

	.compact .checklist-step { padding: 0.55rem 0.7rem; }
	.compact .step-name { font-size: 0.78rem; }
</style>
