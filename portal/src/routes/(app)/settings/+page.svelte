<script lang="ts">
	import { onMount } from 'svelte';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { theme } from '$lib/stores/theme';
	import { auth } from '$lib/stores/auth';
	import { api } from '$lib/api';
	import ConnectionsChecklist from '$lib/components/ConnectionsChecklist.svelte';

	interface Settings {
		timezone: string;
	}

	interface Stats {
		messages: {
			total: number;
			bySource: Record<string, number>;
			byAgent: Record<string, number>;
			dateRange: { first: string | null; last: string | null };
			last30Days: number;
		};
		documents: { total: number };
		attachments: { total: number; byType: Record<string, number>; totalSizeMB: number };
		contacts: { total: number; byTier: Record<string, number> };
		mindscape: { territories: number; realms: number; points: number };
		integrations: Array<{ name: string; icon: string; messageCount: number; status: string }>;
	}

	interface AgentInfo {
		id: string;
		name: string;
		status: string;
		model?: string;
		activeTasks?: number;
	}

	interface CryptoPayment {
		coingate_order_id: string;
		plan: string;
		amount_eur: number;
		crypto_amount: string | null;
		crypto_coin: string | null;
		credited_months: number;
		paid_at: string;
	}

	interface BillingInfo {
		managed: boolean;
		subscription?: {
			plan: string;
			type: string;
			status: string;
			currentPeriodEnd: string | null;
			cancelAtPeriodEnd: number;
			createdAt: string;
			paymentMethod: 'stripe' | 'crypto';
			paidThrough: string | null;
			cryptoCoin: string | null;
		} | null;
		cryptoPayments?: CryptoPayment[];
	}

	interface Provider {
		id: number;
		provider: string;
		label: string | null;
		auth_type: string;
		model_preference: string | null;
		base_url: string | null;
		is_active: number;
		status: string;
		last_used_at: string | null;
		created_at: string;
	}

	let settings = $state<Settings>({ timezone: 'UTC' });
	let stats = $state<Stats | null>(null);
	let agents = $state<AgentInfo[]>([]);
	let billing = $state<BillingInfo | null>(null);
	let providers = $state<Provider[]>([]);
	let claudeStatus = $state<{ authenticated: boolean; email?: string; subscriptionType?: string; orgName?: string } | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let saved = $state(false);
	let exporting = $state(false);
	let exportError = $state<string | null>(null);
	let exportSuccess = $state<string | null>(null);
	let exportPin = $state<string | null>(null);
	let showKeyPrompt = $state(false);
	let masterKeyInput = $state('');
	let keyError = $state<string | null>(null);
	let authOptions = $state<any>(null);
	let hasMasterKeyOption = $state(false);

	// Vault restore state
	let restoring = $state(false);
	let restoreError = $state<string | null>(null);
	let restoreStats = $state<Record<string, number> | null>(null);
	let restoreConfirm = $state(false);
	let restoreFile = $state<File | null>(null);

	// Provider management state
	let showAddOpenAI = $state(false);
	let showAddCustom = $state(false);
	let newApiKey = $state('');
	let newLabel = $state('');
	let newModel = $state('');
	let newBaseUrl = $state('');
	let providerSaving = $state(false);
	let providerError = $state<string | null>(null);

	const timezones = [
		'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
		'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam', 'Europe/Riga',
		'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney',
	];

	function formatNumber(n: number): string {
		if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
		return n.toString();
	}

	function formatDate(d: string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
	}

	async function loadClaudeStatus() {
		try {
			const res = await api('/portal/auth/claude/status');
			if (res.ok) claudeStatus = await res.json();
		} catch {}
	}

	async function loadProviders() {
		try {
			const res = await api('/portal/providers');
			if (res.ok) {
				const data = await res.json();
				providers = data.providers || [];
			}
		} catch {}
	}

	async function startClaudeAuth(label?: string) {
		providerError = null;
		try {
			const res = await api('/portal/auth/claude', {
				method: 'POST',
				body: JSON.stringify({ label }),
			});
			if (!res.ok) throw new Error('Failed to start auth');
			const { url } = await res.json();
			window.open(url, '_blank', 'width=600,height=700');
		} catch (e) {
			providerError = e instanceof Error ? e.message : 'Auth failed';
		}
	}

	async function addApiKeyProvider(provider: string) {
		if (!newApiKey.trim()) return;
		providerSaving = true;
		providerError = null;
		try {
			const res = await api('/portal/providers', {
				method: 'POST',
				body: JSON.stringify({
					provider,
					label: newLabel.trim() || undefined,
					api_key: newApiKey.trim(),
					model_preference: newModel.trim() || undefined,
					base_url: newBaseUrl.trim() || undefined,
				}),
			});
			if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
			newApiKey = ''; newLabel = ''; newModel = ''; newBaseUrl = '';
			showAddOpenAI = false; showAddCustom = false;
			await loadProviders();
		} catch (e) {
			providerError = e instanceof Error ? e.message : 'Failed to add provider';
		}
		providerSaving = false;
	}

	async function setProviderActive(id: number) {
		await api(`/portal/providers/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
		await loadProviders();
	}

	async function removeProvider(id: number) {
		if (!confirm('Remove this provider?')) return;
		await api(`/portal/providers/${id}`, { method: 'DELETE' });
		await loadProviders();
	}

	async function testProvider(id: number) {
		const res = await api(`/portal/providers/${id}/test`, { method: 'POST' });
		if (res.ok) await loadProviders();
	}

	onMount(async () => {
		const [settingsRes, statsRes, agentsRes, billingRes] = await Promise.all([
			api('/portal/settings').catch(() => null),
			api('/portal/stats').catch(() => null),
			api('/portal/agents').catch(() => null),
			api('/portal/billing').catch(() => null),
			loadProviders(),
			loadClaudeStatus(),
		]);

		if (settingsRes?.ok) {
			const data = await settingsRes.json();
			settings = data.settings || settings;
		}
		if (statsRes?.ok) {
			stats = await statsRes.json();
		}
		if (agentsRes?.ok) {
			const data = await agentsRes.json();
			agents = data.agents || [];
		}
		if (billingRes?.ok) {
			billing = await billingRes.json();
		}
		loading = false;
	});

	async function saveSettings() {
		saving = true;
		saved = false;
		try {
			const res = await api('/portal/settings', {
				method: 'PUT',
				body: JSON.stringify(settings),
			});
			if (res.ok) {
				saved = true;
				setTimeout(() => saved = false, 2000);
			}
		} catch {}
		saving = false;
	}

	function startExport() {
		exportError = null;
		exportSuccess = null;
		exportPin = null;
		keyError = null;
		masterKeyInput = '';
		showKeyPrompt = true;
	}

	async function confirmExport() {
		const key = masterKeyInput.trim();
		if (!key || key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key)) {
			keyError = 'Enter your 64-character hex master key';
			return;
		}

		exporting = true;
		keyError = null;
		showKeyPrompt = false;

		try {
			// Verify master key and get export token (use raw fetch to avoid 401 redirect)
			const verifyRes = await fetch(`${window.location.origin}/portal/export/verify`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ masterKey: key }),
			});
			if (!verifyRes.ok) {
				const err = await verifyRes.json().catch(() => ({ error: 'Verification failed' }));
				throw new Error(err.error || 'Invalid master key');
			}
			const { exportToken } = await verifyRes.json();

			// Trigger export (use raw fetch — can be large response, avoid 401 redirect)
			const res = await fetch(`${window.location.origin}/portal/export`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ exportToken }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: `Export failed (${res.status})` }));
				throw new Error(err.error || `Export failed (${res.status})`);
			}

			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('application/json') && !res.headers.get('content-disposition')) {
				const data = await res.json();
				if (data.method === 'email') {
					exportSuccess = 'Download link sent to your email.';
					exportPin = data.pin || null;
				} else {
					exportSuccess = data.message || 'Export complete';
				}
			} else {
				const blob = await res.blob();
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				const ext = contentType.includes('zip') ? '.zip' : '.json';
				a.download = `mycelium-export-${new Date().toISOString().slice(0, 10)}${ext}`;
				a.click();
				URL.revokeObjectURL(url);
			}
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exporting = false;
		}
	}

	let billingLoading = $state(false);

	let billingError = $state<string | null>(null);

	async function openBillingPortal() {
		billingLoading = true;
		billingError = null;
		try {
			const res = await fetch('/portal/billing/portal', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ returnUrl: window.location.href }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: `Error ${res.status}` }));
				throw new Error(err.error || 'Failed to open billing portal');
			}
			const { url } = await res.json();
			window.location.href = url;
		} catch (e) {
			billingError = e instanceof Error ? e.message : 'Billing portal unavailable';
		} finally {
			billingLoading = false;
		}
	}

	function formatPeriodEnd(iso: string | null): string {
		if (!iso) return '';
		return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
	}

	async function handleRestore() {
		if (!restoreFile) return;
		restoring = true;
		restoreError = null;
		restoreStats = null;

		try {
			// Step 1: Re-auth (same as export)
			const authRes = await api('/portal/export/auth', { method: 'POST' });
			if (!authRes.ok) throw new Error('Auth request failed');
			const authData = await authRes.json();

			let exportToken: string;
			if (authData.reauthRequired) {
				const credential = await startAuthentication(authData.options);
				const verifyRes = await api('/portal/export/verify', {
					method: 'POST',
					body: JSON.stringify({ credential }),
				});
				if (!verifyRes.ok) throw new Error('Re-authentication failed');
				exportToken = (await verifyRes.json()).exportToken;
			} else {
				exportToken = authData.exportToken;
			}

			// Step 2: Upload ZIP with token
			const formData = new FormData();
			formData.append('file', restoreFile);
			formData.append('exportToken', exportToken);

			const res = await fetch('/portal/import/vault', {
				method: 'POST',
				credentials: 'same-origin',
				body: formData,
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: `Restore failed (${res.status})` }));
				throw new Error(err.error || 'Restore failed');
			}

			const data = await res.json();
			restoreStats = data.stats;
			restoreFile = null;
			restoreConfirm = false;
		} catch (e: any) {
			if (e.name === 'NotAllowedError') {
				restoreError = 'Passkey verification cancelled';
			} else {
				restoreError = e.message || 'Restore failed';
			}
		} finally {
			restoring = false;
		}
	}

	async function handleLogout() {
		await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
		auth.logout();
		window.location.href = '/login';
	}

	const integrationIcons: Record<string, string> = {
		telegram: '✈',
		discord: '💬',
		portal: '🌐',
		whatsapp: '📱',
		import: '📥',
	};
</script>

<svelte:head>
	<title>Settings - Mycelium</title>
</svelte:head>

<div class="h-full overflow-y-auto">
<div class="max-w-2xl mx-auto px-8 py-8">
	<h1 class="text-xl font-medium text-[var(--color-text-emphasis)] mb-2">Settings</h1>
	<p class="text-sm text-[var(--color-text-secondary)] mb-8">Your Mycelium instance at a glance</p>

	{#if loading}
		<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading...</div>
	{:else}
		<div class="space-y-6">

			<!-- AI Subscriptions -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">AI Subscriptions</h2>

				{#if providerError}
					<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{providerError}</div>
				{/if}

				<!-- Claude accounts -->
				<div class="mb-4">
					<div class="flex items-center justify-between mb-2">
						<span class="text-sm font-medium text-[var(--color-text-primary)]">Claude</span>
						<button onclick={() => startClaudeAuth()} class="text-[0.7rem] text-[var(--color-accent)] hover:underline cursor-pointer">+ Add account</button>
					</div>

					<!-- Live Claude status (from CLI) -->
					{#if claudeStatus?.authenticated}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-accent)]/30 mb-2 bg-[var(--color-surface)]">
							<span class="w-2 h-2 rounded-full flex-shrink-0 bg-green-400"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{claudeStatus.email || 'Claude'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">
									{#if claudeStatus.subscriptionType}
										<span class="text-[var(--color-accent)] font-medium uppercase">{claudeStatus.subscriptionType}</span> plan ·
									{/if}
									Connected
									{#if claudeStatus.orgName} · {claudeStatus.orgName}{/if}
								</div>
							</div>
							<span class="text-[0.6rem] text-[var(--color-accent)] font-medium">Active</span>
						</div>
					{/if}

					<!-- Additional Claude accounts from providers DB -->
					{#each providers.filter(p => p.provider === 'claude') as p (p.id)}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] mb-2 transition-colors" style:border-color={p.is_active ? 'var(--color-accent)' : ''}>
							<span class="w-2 h-2 rounded-full flex-shrink-0" style="background: {p.status === 'active' ? '#4ade80' : p.status === 'expired' ? '#fbbf24' : '#ef4444'}"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{p.label || 'Claude'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">
									{p.status === 'active' ? 'Connected' : p.status === 'expired' ? 'Token expired' : p.status}
									{#if p.last_used_at} · Last used {new Date(p.last_used_at).toLocaleDateString()}{/if}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if p.is_active}
									<span class="text-[0.6rem] text-[var(--color-accent)] font-medium">Active</span>
								{:else}
									<button onclick={() => setProviderActive(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] cursor-pointer">Set active</button>
								{/if}
								<button onclick={() => testProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] cursor-pointer" title="Test connection">&#x21bb;</button>
								<button onclick={() => removeProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer" title="Remove">&times;</button>
							</div>
						</div>
					{/each}

					{#if !claudeStatus?.authenticated && providers.filter(p => p.provider === 'claude').length === 0}
						<div class="text-[0.7rem] text-[var(--color-text-tertiary)] p-3 rounded-lg border border-dashed border-[var(--color-border)]">
							No Claude account connected. <button onclick={() => startClaudeAuth()} class="text-[var(--color-accent)] hover:underline cursor-pointer">Connect with Claude</button>
						</div>
					{/if}
				</div>

				<!-- OpenAI accounts -->
				<div class="mb-4">
					<div class="flex items-center justify-between mb-2">
						<span class="text-sm font-medium text-[var(--color-text-primary)]">OpenAI</span>
						<button onclick={() => showAddOpenAI = !showAddOpenAI} class="text-[0.7rem] text-[var(--color-accent)] hover:underline cursor-pointer">+ Add key</button>
					</div>
					{#each providers.filter(p => p.provider === 'openai') as p (p.id)}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] mb-2 transition-colors" style:border-color={p.is_active ? 'var(--color-accent)' : ''}>
							<span class="w-2 h-2 rounded-full flex-shrink-0" style="background: {p.status === 'active' ? '#4ade80' : '#ef4444'}"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{p.label || 'OpenAI'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">
									{p.model_preference || 'Default model'} · {p.status}
									{#if p.last_used_at} · Last used {new Date(p.last_used_at).toLocaleDateString()}{/if}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if p.is_active}
									<span class="text-[0.6rem] text-[var(--color-accent)] font-medium">Active</span>
								{:else}
									<button onclick={() => setProviderActive(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] cursor-pointer">Set active</button>
								{/if}
								<button onclick={() => testProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] cursor-pointer" title="Test">&#x21bb;</button>
								<button onclick={() => removeProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer" title="Remove">&times;</button>
							</div>
						</div>
					{/each}
					{#if showAddOpenAI}
						<div class="p-3 rounded-lg border border-[var(--color-border)] space-y-2">
							<input type="text" bind:value={newLabel} placeholder="Label (optional)" class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
							<input type="password" bind:value={newApiKey} placeholder="sk-..." class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)] font-mono">
							<input type="text" bind:value={newModel} placeholder="Model (e.g. gpt-4o)" class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
							<div class="flex gap-2">
								<button onclick={() => addApiKeyProvider('openai')} disabled={providerSaving} class="text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer disabled:opacity-50">
									{providerSaving ? 'Adding...' : 'Add OpenAI'}
								</button>
								<button onclick={() => { showAddOpenAI = false; newApiKey = ''; }} class="text-xs px-3 py-1.5 rounded text-[var(--color-text-tertiary)] cursor-pointer">Cancel</button>
							</div>
						</div>
					{/if}
				</div>

				<!-- Custom providers -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<span class="text-sm font-medium text-[var(--color-text-primary)]">Custom</span>
						<button onclick={() => showAddCustom = !showAddCustom} class="text-[0.7rem] text-[var(--color-accent)] hover:underline cursor-pointer">+ Add provider</button>
					</div>
					{#each providers.filter(p => p.provider === 'custom') as p (p.id)}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] mb-2">
							<span class="w-2 h-2 rounded-full flex-shrink-0" style="background: {p.status === 'active' ? '#4ade80' : '#ef4444'}"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{p.label || 'Custom'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">{p.base_url || 'No endpoint'} · {p.status}</div>
							</div>
							<div class="flex items-center gap-2">
								<button onclick={() => removeProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer">&times;</button>
							</div>
						</div>
					{/each}
					{#if showAddCustom}
						<div class="p-3 rounded-lg border border-[var(--color-border)] space-y-2">
							<input type="text" bind:value={newLabel} placeholder="Provider name" class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
							<input type="text" bind:value={newBaseUrl} placeholder="API base URL" class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)] font-mono">
							<input type="password" bind:value={newApiKey} placeholder="API key" class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)] font-mono">
							<input type="text" bind:value={newModel} placeholder="Model name (optional)" class="w-full text-sm p-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
							<div class="flex gap-2">
								<button onclick={() => addApiKeyProvider('custom')} disabled={providerSaving} class="text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer disabled:opacity-50">
									{providerSaving ? 'Adding...' : 'Add Provider'}
								</button>
								<button onclick={() => { showAddCustom = false; newApiKey = ''; }} class="text-xs px-3 py-1.5 rounded text-[var(--color-text-tertiary)] cursor-pointer">Cancel</button>
							</div>
						</div>
					{/if}
				</div>
			</section>

			<!-- Connections -->
			<section class="card p-5">
				<ConnectionsChecklist compact />
			</section>

			<!-- Data Overview -->
			{#if stats}
				<section class="card p-5">
					<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Data Overview</h2>
					<div class="grid grid-cols-3 gap-3 mb-4">
						<div class="stat-card">
							<div class="stat-value">{formatNumber(stats.messages.total)}</div>
							<div class="stat-label">Messages</div>
							{#if stats.messages.dateRange.first}
								<div class="stat-sub">since {formatDate(stats.messages.dateRange.first)}</div>
							{/if}
						</div>
						<div class="stat-card">
							<div class="stat-value">{formatNumber(stats.contacts.total)}</div>
							<div class="stat-label">Contacts</div>
							<div class="stat-sub">{stats.contacts.byTier.inner || 0} inner circle</div>
						</div>
						<div class="stat-card">
							<div class="stat-value">{stats.mindscape.territories}</div>
							<div class="stat-label">Territories</div>
							<div class="stat-sub">{stats.mindscape.realms} realms</div>
						</div>
						<div class="stat-card">
							<div class="stat-value">{formatNumber(stats.documents.total)}</div>
							<div class="stat-label">Documents</div>
						</div>
						<div class="stat-card">
							<div class="stat-value">{formatNumber(stats.attachments.total)}</div>
							<div class="stat-label">Attachments</div>
							<div class="stat-sub">{stats.attachments.totalSizeMB} MB</div>
						</div>
						<div class="stat-card">
							<div class="stat-value">{formatNumber(stats.messages.last30Days)}</div>
							<div class="stat-label">Last 30 days</div>
							<div class="stat-sub">messages</div>
						</div>
					</div>

					<!-- Source breakdown bar -->
					{#if stats.messages.total > 0}
						<div class="mt-4">
							<div class="text-xs text-[var(--color-text-tertiary)] mb-2">Messages by source</div>
							<div class="source-bar">
								{#each Object.entries(stats.messages.bySource).filter(([,v]) => v > 0) as [source, count]}
									<div
										class="source-segment source-{source}"
										style="width: {Math.max((count / stats.messages.total) * 100, 2)}%"
										title="{source}: {formatNumber(count)}"
									></div>
								{/each}
							</div>
							<div class="flex flex-wrap gap-3 mt-2">
								{#each Object.entries(stats.messages.bySource).filter(([,v]) => v > 0) as [source, count]}
									<div class="flex items-center gap-1.5">
										<div class="w-2 h-2 rounded-full source-dot-{source}"></div>
										<span class="text-xs text-[var(--color-text-tertiary)]">{source} <span class="font-mono">{formatNumber(count)}</span></span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</section>
			{/if}

			<!-- Connected Services -->
			{#if stats && stats.integrations.length > 0}
				<section class="card p-5">
					<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Connected Services</h2>
					<div class="space-y-3">
						{#each stats.integrations as integration}
							<div class="flex items-center justify-between py-2 px-3 rounded-lg bg-[var(--color-elevated)]">
								<div class="flex items-center gap-3">
									<span class="text-lg">{integrationIcons[integration.icon] || '•'}</span>
									<div>
										<div class="text-sm text-[var(--color-text-primary)] font-medium">{integration.name}</div>
										<div class="text-xs text-[var(--color-text-tertiary)]">{formatNumber(integration.messageCount)} messages</div>
									</div>
								</div>
								<div class="flex items-center gap-2">
									<div class="w-1.5 h-1.5 rounded-full {integration.status === 'connected' ? 'bg-jade' : 'bg-[var(--color-text-tertiary)]'}"></div>
									<span class="text-xs text-[var(--color-text-tertiary)] capitalize">{integration.status.replace('_', ' ')}</span>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Agents -->
			{#if agents.length > 0}
				<section class="card p-5">
					<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Agents</h2>
					<div class="space-y-2">
						{#each agents as agent}
							<div class="flex items-center justify-between py-2 px-3 rounded-lg bg-[var(--color-elevated)]">
								<div class="flex items-center gap-3">
									<div class="w-1.5 h-1.5 rounded-full {agent.status === 'online' ? 'bg-jade' : 'bg-coral'}"></div>
									<div>
										<div class="text-sm text-[var(--color-text-primary)]">{agent.name || agent.id}</div>
										{#if agent.model}
											<div class="text-xs text-[var(--color-text-tertiary)] font-mono">{agent.model}</div>
										{/if}
									</div>
								</div>
								<div class="text-xs text-[var(--color-text-tertiary)]">
									{agent.status}
									{#if agent.activeTasks}
										<span class="ml-1 text-aurum">{agent.activeTasks} active</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Billing -->
			{#if billing?.managed && billing.subscription}
				<section class="card p-5">
					<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Subscription</h2>
					<div class="space-y-3">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div class="w-8 h-8 rounded-lg bg-aurum/20 flex items-center justify-center">
									<span class="text-aurum text-sm">
										{billing.subscription.plan === 'decade' ? 'X' : billing.subscription.plan === 'annual' ? 'Y' : 'M'}
									</span>
								</div>
								<div>
									<p class="text-sm text-[var(--color-text-primary)] font-medium capitalize">
										{billing.subscription.plan === 'decade' ? 'Decade' : billing.subscription.plan} plan
									</p>
									<p class="text-xs text-[var(--color-text-tertiary)]">
										{#if billing.subscription.type === 'lifetime'}
											Lifetime access
										{:else if billing.subscription.paymentMethod === 'crypto' && billing.subscription.paidThrough}
											Paid through {formatPeriodEnd(billing.subscription.paidThrough)}
											{#if billing.subscription.cryptoCoin}
												<span class="uppercase"> &middot; {billing.subscription.cryptoCoin}</span>
											{/if}
										{:else if billing.subscription.cancelAtPeriodEnd}
											Cancels {formatPeriodEnd(billing.subscription.currentPeriodEnd)}
										{:else if billing.subscription.currentPeriodEnd}
											Renews {formatPeriodEnd(billing.subscription.currentPeriodEnd)}
										{/if}
									</p>
								</div>
							</div>
							<div class="flex items-center gap-2">
								<div class="w-1.5 h-1.5 rounded-full {billing.subscription.status === 'active' || billing.subscription.status === 'lifetime' ? 'bg-jade' : billing.subscription.status === 'past_due' ? 'bg-coral' : 'bg-[var(--color-text-tertiary)]'}"></div>
								<span class="text-xs text-[var(--color-text-tertiary)] capitalize">{billing.subscription.status.replace('_', ' ')}</span>
							</div>
						</div>
						{#if billing.subscription.type !== 'lifetime'}
							{#if billing.subscription.paymentMethod === 'stripe'}
								<button
									onclick={openBillingPortal}
									disabled={billingLoading}
									class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] w-full justify-center"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
									</svg>
									{billingLoading ? 'Opening...' : 'Manage Billing'}
								</button>
							{:else}
								<button
									onclick={() => window.open('https://mycelium.id/signup/?topup=crypto', '_blank')}
									class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] w-full justify-center"
								>
									Top up with crypto
								</button>
							{/if}
							{#if billingError}
								<p class="text-xs text-coral mt-2">{billingError}</p>
							{/if}
						{/if}

						<!-- Crypto payment history -->
						{#if billing.cryptoPayments && billing.cryptoPayments.length > 0}
							<div class="mt-4 pt-3 border-t border-[var(--color-border)]">
								<h3 class="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wider mb-2">Payment History</h3>
								<div class="space-y-2">
									{#each billing.cryptoPayments as payment}
										<div class="flex items-center justify-between text-xs">
											<div class="text-[var(--color-text-secondary)]">
												{formatDate(payment.paid_at)}
											</div>
											<div class="text-[var(--color-text-secondary)]">
												EUR {payment.amount_eur}
											</div>
											<div class="text-[var(--color-text-tertiary)] uppercase">
												{payment.crypto_coin || '—'}
											</div>
											<div class="text-[var(--color-text-tertiary)]">
												{payment.credited_months}mo
											</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				</section>
			{/if}

			<!-- Appearance -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Appearance</h2>
				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Theme</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">Toggle between dark and light mode</p>
					</div>
					<button
						onclick={() => theme.toggle()}
						class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]"
					>
						{#if $theme === 'dark'}
							<svg class="w-4 h-4 text-aurum" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
							</svg>
							Switch to Light
						{:else}
							<svg class="w-4 h-4 text-amethyst" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 006.002-2.998z" />
							</svg>
							Switch to Dark
						{/if}
					</button>
				</div>
			</section>

			<!-- Timezone -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Region</h2>
				<div>
					<p class="text-sm text-[var(--color-text-primary)] mb-1">Timezone</p>
					<p class="text-xs text-[var(--color-text-tertiary)] mb-3">Used for message timestamps and scheduled events</p>
					<select
						bind:value={settings.timezone}
						class="input w-full text-sm"
					>
						{#each timezones as tz}
							<option value={tz}>{tz.replace(/_/g, ' ')}</option>
						{/each}
					</select>
				</div>
			</section>

			<!-- Data -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Data</h2>
				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Export All Data</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							Full vault ZIP: messages, documents, attachments, mindscape, contacts, health, wealth, agent files, and all metadata. Requires master key.
						</p>
					</div>
					{#if !showKeyPrompt}
						<button
							onclick={startExport}
							disabled={exporting}
							class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
							</svg>
							{exporting ? 'Exporting...' : 'Export'}
						</button>
					{/if}
				</div>
				{#if showKeyPrompt}
					<div class="mt-3 p-3 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)]">
						<p class="text-xs text-[var(--color-text-secondary)] mb-2">Enter your master encryption key to confirm export</p>
						<div class="flex gap-2">
							<input
								type="password"
								bind:value={masterKeyInput}
								placeholder="64-character hex key"
								class="flex-1 px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
								maxlength="64"
								onkeydown={(e) => { if (e.key === 'Enter') confirmExport(); }}
							/>
							<button
								onclick={confirmExport}
								disabled={exporting}
								class="px-3 py-2 rounded-lg bg-aurum/20 border border-aurum/40 hover:border-aurum transition-colors text-sm text-aurum font-medium"
							>{exporting ? 'Exporting...' : 'Confirm'}</button>
							<button
								onclick={() => { showKeyPrompt = false; masterKeyInput = ''; keyError = null; }}
								class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
							>Cancel</button>
						</div>
						{#if keyError}
							<p class="text-xs text-coral mt-1.5">{keyError}</p>
						{/if}
					</div>
				{/if}
				{#if exportError}
					<p class="text-xs text-coral mt-2">{exportError}</p>
				{/if}
				{#if exportSuccess}
					<p class="text-xs text-jade mt-2">{exportSuccess}</p>
					{#if exportPin}
						<div class="mt-2 p-3 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)]">
							<p class="text-[0.65rem] text-[var(--color-text-tertiary)] uppercase tracking-wider mb-1">Download PIN</p>
							<p class="text-2xl font-mono font-bold text-[var(--color-text-emphasis)] tracking-[0.3em] text-center">{exportPin}</p>
							<p class="text-[0.65rem] text-[var(--color-text-tertiary)] mt-1.5">Enter this PIN when you open the download link from your email. It expires in 1 hour.</p>
						</div>
					{/if}
				{/if}

				<!-- Restore Vault -->
				<div class="flex items-center justify-between mt-5 pt-5 border-t border-[var(--color-border)]">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Restore Vault</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">Import a Mycelium vault export ZIP. Merges into this vault.</p>
					</div>
					{#if !restoreConfirm}
						<label class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] cursor-pointer">
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
							</svg>
							Select ZIP
							<input type="file" accept=".zip" class="hidden" onchange={(e) => {
								const f = (e.target as HTMLInputElement).files?.[0];
								if (f) { restoreFile = f; restoreConfirm = true; }
							}} />
						</label>
					{:else}
						<div class="flex items-center gap-2">
							<button
								onclick={() => { restoreConfirm = false; restoreFile = null; }}
								class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
							>Cancel</button>
							<button
								onclick={handleRestore}
								disabled={restoring}
								class="flex items-center gap-2 px-3 py-2 rounded-lg bg-aurum/20 border border-aurum/40 hover:border-aurum transition-colors text-sm text-aurum"
							>
								{restoring ? 'Restoring...' : `Restore ${restoreFile?.name}`}
							</button>
						</div>
					{/if}
				</div>
				{#if restoreError}
					<p class="text-xs text-coral mt-2">{restoreError}</p>
				{/if}
				{#if restoreStats}
					<div class="mt-3 p-3 rounded-lg bg-jade/10 border border-jade/20">
						<p class="text-xs text-jade font-medium mb-1">Vault restored successfully</p>
						<div class="grid grid-cols-3 gap-1 text-xs text-[var(--color-text-tertiary)]">
							{#each Object.entries(restoreStats).filter(([,v]) => typeof v === 'number' && v > 0) as [key, val]}
								<span>{key}: <span class="font-mono text-[var(--color-text-primary)]">{val}</span></span>
							{/each}
						</div>
					</div>
				{/if}
			</section>

			<!-- Account -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Account</h2>
				{#if $auth.user}
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-3">
							<div class="w-10 h-10 rounded-full bg-azure/20 flex items-center justify-center">
								<span class="text-azure text-sm font-medium">
									{($auth.user.displayName || 'U')[0].toUpperCase()}
								</span>
							</div>
							<div>
								<p class="text-sm text-[var(--color-text-primary)] font-medium">
									{$auth.user.displayName || 'User'}
								</p>
								<p class="text-xs text-[var(--color-text-tertiary)]">Passkey authentication</p>
							</div>
						</div>
						<button
							onclick={handleLogout}
							class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-coral hover:bg-coral/10 transition-colors"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
							</svg>
							Sign Out
						</button>
					</div>
				{/if}
			</section>

			<!-- Save -->
			<div class="flex items-center gap-3">
				<button onclick={saveSettings} disabled={saving} class="btn btn-primary">
					{saving ? 'Saving...' : 'Save Settings'}
				</button>
				{#if saved}
					<span class="text-xs text-jade animate-fade-in">Saved</span>
				{/if}
			</div>
		</div>
	{/if}
</div>
</div>

<style>
	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.animate-fade-in {
		animation: fade-in 0.2s ease-out;
	}

	.stat-card {
		padding: 0.75rem;
		background: var(--color-elevated);
		border-radius: var(--radius-md, 8px);
		text-align: center;
	}
	.stat-value {
		font-family: var(--font-mono, monospace);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-text-emphasis);
		line-height: 1.2;
	}
	.stat-label {
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--color-text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-top: 0.25rem;
	}
	.stat-sub {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		margin-top: 0.15rem;
	}

	.source-bar {
		display: flex;
		height: 6px;
		border-radius: 3px;
		overflow: hidden;
		background: var(--color-elevated);
	}
	.source-segment { min-width: 3px; transition: width 0.3s ease; }
	.source-telegram { background: #0088cc; }
	.source-discord { background: #5865F2; }
	.source-portal { background: var(--color-accent-aurum, #B8860B); }
	.source-whatsapp { background: #25D366; }
	.source-imported { background: var(--color-accent-amethyst, #8B5CF6); }
	.source-other { background: var(--color-text-tertiary); }

	.source-dot-telegram { background: #0088cc; }
	.source-dot-discord { background: #5865F2; }
	.source-dot-portal { background: var(--color-accent-aurum, #B8860B); }
	.source-dot-whatsapp { background: #25D366; }
	.source-dot-imported { background: var(--color-accent-amethyst, #8B5CF6); }
	.source-dot-other { background: var(--color-text-tertiary); }
</style>
