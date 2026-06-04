<script lang="ts">
	import { onMount } from 'svelte';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { theme } from '$lib/stores/theme';
	import { auth } from '$lib/stores/auth';
	import { api } from '$lib/api';
	import { preparePrfOptions } from '$lib/passkey-prf';
	import ConnectionsChecklist from '$lib/components/ConnectionsChecklist.svelte';
	import VoiceSection from '$lib/components/settings/VoiceSection.svelte';
	import IntelligenceSection from '$lib/components/settings/IntelligenceSection.svelte';
	import RemoteAccessSection from '$lib/components/settings/RemoteAccessSection.svelte';

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
		defaultName: string;
		role: string;
		color: string;
		status: string;
		model?: string;
		activeTasks?: number;
		personality?: string | null;
		avatarEmoji?: string | null;
	}

	// Agent customization state — moved to /agents (Manage tab) on 2026-05-06.

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
		config_dir: string | null;
		is_active: number;
		status: string;
		last_used_at: string | null;
		created_at: string;
	}

	let settings = $state<Settings>({ timezone: 'UTC' });
	let stats = $state<Stats | null>(null);
	// agents[] moved to /agents (Manage tab) on 2026-05-06.

	// Passkey management
	interface PasskeyInfo { id: string; credential_id: string; name: string | null; created_at: string; last_used_at: string | null; has_prf: number }
	// Channel Authority Registry — unified view of every channel the agent
	// may send to (Telegram DMs/groups, Discord channels, etc.) plus the
	// global autonomous kill-switch. Backed by GET /portal/channels.
	interface ChannelMember { id: string; name?: string; firstSeen?: string; lastSeen?: string }
	interface AuthChannel {
		kind: string;
		id: string;
		label: string;
		isOperatorDM?: boolean;
		allowAutonomous?: boolean;
		lastSeen?: string;
		members?: ChannelMember[];
	}
	let authChannels = $state<AuthChannel[]>([]);
	let autonomousGlobalEnabled = $state<boolean>(true);
	let channelAuthorityLoaded = $state(false);

	let passkeys = $state<PasskeyInfo[]>([]);
	let addingPasskey = $state(false);
	let newPasskeyName = $state('');
	let passkeyError = $state<string | null>(null);
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let billing = $state<BillingInfo | null>(null);
	let providers = $state<Provider[]>([]);
	// Runtime state: which CLAUDE_CONFIG_DIR each peer agent is currently
	// using. Loaded from /portal/providers/runtime-state. Used to show
	// "current vs preferred" badges per provider row — a row whose
	// config_dir matches any agent's runtime configDir is "running"; a
	// row that's marked is_active=1 but isn't running anywhere is
	// "preferred — restart required" (PR 2 will remove the restart bit).
	interface RuntimeAgent {
		slug: string;
		name: string;
		port: number;
		configDir?: string | null;
		configDirHash?: string | null;
		ok: boolean;
		source?: string;
		error?: string;
	}
	let runtimeAgents = $state<RuntimeAgent[]>([]);

	// Per-agent assignments (PR 2b). Reconciler converges these into the
	// tmpfs cache that every Claude CLI spawn reads. `desired_state` is one
	// of 'pending' | 'applied' | 'failed'; routes return whatever is in the
	// table now, and the row transitions through pending → applied (or
	// → failed with last_error) within ~1s of the SIGUSR2 fired by POST.
	interface Assignment {
		id: number;
		user_id: string;
		agent_id: string;        // literal agent slug, 'scope:<x>', or '*'
		provider_id: number;
		desired_state: string;
		applied_at: string | null;
		last_error: string | null;
		created_at: string;
		updated_at: string;
	}
	let assignments = $state<Assignment[]>([]);

	let claudeStatus = $state<{ authenticated: boolean; email?: string; subscriptionType?: string; orgName?: string } | null>(null);
	let claudeAuthUrl = $state('');
	let claudeAuthCode = $state('');
	let claudeAuthLoading = $state(false);
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

	// Account-deletion state. The flow:
	//   idle → typing (phrase input) → reauth (passkey or master key) → deleting → done
	// All calls hit /portal/delete-account/{auth,verify,} — same three-step
	// pattern as export/restore, but the token lives in a separate map on the
	// server and cannot be reused for export.
	const DELETE_CONFIRM_PHRASE = 'DELETE ALL MY DATA';
	type DeleteStage = 'idle' | 'typing' | 'reauth' | 'deleting' | 'done';
	let deleteStage = $state<DeleteStage>('idle');
	let deletePhrase = $state('');
	let deleteError = $state<string | null>(null);
	let deleteAuthOptions = $state<any>(null);
	let deleteHasMasterKey = $state(false);
	let deleteMasterKeyInput = $state('');
	let deletePartial = $state(false);
	let deleteStats = $state<Record<string, unknown> | null>(null);
	let deletionRecordId = $state<string | null>(null);  // Phase 5 receipt

	// Provider management state
	let showAddOpenAI = $state(false);
	let showAddCustom = $state(false);
	let newApiKey = $state('');
	let newLabel = $state('');
	let newModel = $state('');
	let newBaseUrl = $state('');
	let providerSaving = $state(false);
	let providerError = $state<string | null>(null);

	// OpenAI connection state
	let openaiStatus = $state<{ authenticated: boolean; status?: string; label?: string } | null>(null);

	async function loadOpenAIStatus() {
		try {
			const res = await api('/portal/auth/openai/status');
			if (res.ok) openaiStatus = await res.json();
		} catch { /* silent */ }
	}

	// Codex OAuth flow removed — auth.openai.com is Cloudflare-challenged
	// (TLS fingerprinting blocks all non-browser clients including Workers,
	// Node.js, and even OpenAI's own Codex CLI as of Apr 2026).
	// OpenAI connection uses API key paste via the provider system instead.

	async function disconnectOpenAI() {
		try {
			await api('/portal/auth/openai/disconnect', { method: 'POST' });
			openaiStatus = null;
			await loadProviders();
		} catch { /* silent */ }
	}

	// Linear integration state
	interface LinearStatus {
		connected: boolean;
		teamId?: string | null;
		teamName?: string | null;
		teamKey?: string | null;
		viewerName?: string | null;
		error?: string;
	}
	let linear = $state<LinearStatus>({ connected: false });
	let linearLoading = $state(true);
	let showLinearForm = $state(false);
	let linearApiKey = $state('');
	let linearTeamId = $state('');
	let linearSaving = $state(false);
	let linearError = $state<string | null>(null);

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

	async function loadLinearStatus() {
		linearLoading = true;
		try {
			const res = await api('/portal/integrations/linear');
			if (res.ok) linear = await res.json();
			else linear = { connected: false };
		} catch {
			linear = { connected: false };
		} finally {
			linearLoading = false;
		}
	}

	async function saveLinear(e: Event) {
		e.preventDefault();
		linearError = null;
		linearSaving = true;
		try {
			const res = await api('/portal/integrations/linear', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ apiKey: linearApiKey.trim(), teamId: linearTeamId.trim() }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error || 'Failed to save');
			linear = { connected: true, teamName: body.teamName, teamKey: body.teamKey, viewerName: body.viewerName, teamId: linearTeamId.trim() };
			showLinearForm = false;
			linearApiKey = '';
			linearTeamId = '';
		} catch (err: any) {
			linearError = err.message || 'Failed to save';
		} finally {
			linearSaving = false;
		}
	}

	async function disconnectLinear() {
		if (!confirm('Disconnect Linear? Mya and Com will lose access to your Linear workspace.')) return;
		try {
			const res = await api('/portal/integrations/linear', { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed');
			linear = { connected: false };
		} catch (err: any) {
			linearError = err.message || 'Failed to disconnect';
		}
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

	async function loadRuntimeState() {
		try {
			const res = await api('/portal/providers/runtime-state');
			if (res.ok) {
				const data = await res.json();
				runtimeAgents = data.agents || [];
			}
		} catch {}
	}

	async function loadAssignments() {
		try {
			const res = await api('/portal/providers/assignments');
			if (res.ok) {
				const data = await res.json();
				assignments = data.assignments || [];
			}
		} catch {}
	}

	// Effective provider for an agent at runtime, walking the same lookup
	// chain the helper at packages/core/claude-config.js uses on every CLI
	// spawn: literal agent-id assignment → wildcard '*' assignment →
	// fallback to whatever configDir the agent's /health reports (which is
	// process.env.CLAUDE_CONFIG_DIR — the inherited PM2 env).
	//
	// Returns the matching Provider row, or null if nothing matches the
	// runtime configDir among the user's known providers (rare — happens
	// when the env points at a dir that isn't tracked in the providers DB).
	function effectiveProviderForAgent(agent: RuntimeAgent): Provider | null {
		const literal = assignments.find(a => a.agent_id === agent.slug);
		if (literal) return providers.find(p => p.id === literal.provider_id) || null;
		const wildcard = assignments.find(a => a.agent_id === '*');
		if (wildcard) return providers.find(p => p.id === wildcard.provider_id) || null;
		// Fall back to matching against the agent's runtime configDir (env).
		if (agent.configDir) {
			return providers.find(p => p.config_dir === agent.configDir) || null;
		}
		return null;
	}

	function isProviderQuarantined(p: Provider): boolean {
		return p.status === 'quarantined' || p.auth_type === 'setup_token';
	}

	// "Running" = at least one agent is effectively using this provider,
	// resolved via the assignment chain (literal → wildcard → env fallback).
	// Pre-PR-2b this checked configDir-vs-env equality, which lied when a
	// cache override was active. Now we use effectiveProviderForAgent so a
	// row with a wildcard assignment shows "Running" even though no agent's
	// PM2 env points at it (the cache routes the per-spawn env there).
	function isProviderRunning(p: Provider): boolean {
		return runtimeAgents.some(a => effectiveProviderForAgent(a)?.id === p.id);
	}

	async function startClaudeAuth(label?: string) {
		providerError = null;
		claudeAuthLoading = true;
		claudeAuthUrl = '';
		claudeAuthCode = '';
		try {
			const res = await api('/portal/auth/claude', {
				method: 'POST',
				body: JSON.stringify({ label }),
			});
			if (!res.ok) throw new Error('Failed to start auth');
			const { url } = await res.json();
			claudeAuthUrl = url;
			window.open(url, '_blank', 'width=600,height=700');
		} catch (e) {
			providerError = e instanceof Error ? e.message : 'Auth failed';
		}
		claudeAuthLoading = false;
	}

	async function submitClaudeCode() {
		if (!claudeAuthCode.trim()) return;
		claudeAuthLoading = true;
		providerError = null;
		try {
			const res = await api('/portal/auth/claude/code', {
				method: 'POST',
				body: JSON.stringify({ code: claudeAuthCode.trim() }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to authenticate');
			claudeAuthUrl = '';
			claudeAuthCode = '';
			await loadClaudeStatus();
			await loadProviders();
		} catch (e) {
			providerError = e instanceof Error ? e.message : 'Auth failed';
		}
		claudeAuthLoading = false;
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
		providerError = null;
		const res = await api(`/portal/providers/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
		if (!res.ok) {
			let msg = 'Failed to mark preferred';
			try {
				const data = await res.json();
				if (data?.error === 'quarantined_provider') {
					msg = data.message || 'This provider is quarantined and cannot be used.';
				} else if (data?.error || data?.message) {
					msg = data.message || data.error;
				}
			} catch {}
			providerError = msg;
			return;
		}
		// PR 2b: server-side shim writes a '*' assignment when this fires for
		// a Claude row, so the reconciler picks it up via SIGUSR2 within ~1s.
		// Reload providers (status flag), runtime state (configDirs), and
		// assignments (the new wildcard row).
		await new Promise(r => setTimeout(r, 1500));
		await Promise.all([loadProviders(), loadRuntimeState(), loadAssignments()]);
	}

	async function disconnectClaudeCli() {
		if (!confirm('Disconnect the Claude CLI session? You can sign in again from here.')) return;
		try {
			await api('/portal/auth/claude/disconnect', { method: 'POST' });
			claudeStatus = null;
		} catch {
			/* the server log captures the real reason; surface a generic
			   recovery path in the UI */
			providerError = 'Disconnect failed — refresh and retry';
		}
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

	// ── Channel Authority Registry helpers ─────────────────────────────
	// All four endpoints accept either a portal session (this UI) or a
	// loopback bot calling with WORKER_SECRET — the bot path is what
	// /allow + /channels in Telegram/Discord uses.

	async function loadChannelAuthority() {
		try {
			const res = await api('/portal/channels');
			if (res.ok) {
				const data = await res.json();
				authChannels = data.channels || [];
				autonomousGlobalEnabled = data.autonomousGlobalEnabled !== false;
				channelAuthorityLoaded = true;
			}
		} catch {}
	}

	async function toggleGlobalAutonomous(value: boolean) {
		const previous = autonomousGlobalEnabled;
		autonomousGlobalEnabled = value;  // optimistic
		try {
			const res = await api('/portal/channels/global', {
				method: 'PATCH',
				body: JSON.stringify({ autonomousGlobalEnabled: value }),
			});
			if (!res.ok) {
				autonomousGlobalEnabled = previous;
			}
		} catch {
			autonomousGlobalEnabled = previous;
		}
	}

	async function toggleChannelAutonomous(channel: AuthChannel, value: boolean) {
		const previous = !!channel.allowAutonomous;
		// Optimistic update: mutate the array reference so Svelte rerenders.
		authChannels = authChannels.map((c) =>
			(c.kind === channel.kind && c.id === channel.id)
				? { ...c, allowAutonomous: value }
				: c,
		);
		try {
			const res = await api(
				`/portal/channels/${encodeURIComponent(channel.kind)}/${encodeURIComponent(channel.id)}`,
				{ method: 'PATCH', body: JSON.stringify({ allowAutonomous: value }) },
			);
			if (!res.ok) {
				// Revert on failure (e.g. cannot-disallow-operator-dm).
				authChannels = authChannels.map((c) =>
					(c.kind === channel.kind && c.id === channel.id)
						? { ...c, allowAutonomous: previous }
						: c,
				);
			}
		} catch {
			authChannels = authChannels.map((c) =>
				(c.kind === channel.kind && c.id === channel.id)
					? { ...c, allowAutonomous: previous }
					: c,
			);
		}
	}

	async function revokeChannel(channel: AuthChannel) {
		try {
			const res = await api(
				`/portal/channels/${encodeURIComponent(channel.kind)}/${encodeURIComponent(channel.id)}`,
				{ method: 'DELETE' },
			);
			if (res.ok) {
				authChannels = authChannels.filter((c) => !(c.kind === channel.kind && c.id === channel.id));
			}
		} catch {}
	}

	function groupChannelsByKind(channels: AuthChannel[]) {
		const grouped = new Map<string, AuthChannel[]>();
		for (const c of channels) {
			if (!grouped.has(c.kind)) grouped.set(c.kind, []);
			grouped.get(c.kind)!.push(c);
		}
		return Array.from(grouped.entries());
	}

	function kindLabel(kind: string): string {
		switch (kind) {
			case 'telegram': return 'Telegram (DM)';
			case 'telegram-group': return 'Telegram (group)';
			case 'discord': return 'Discord';
			case 'discord-thread': return 'Discord (thread)';
			case 'whatsapp': return 'WhatsApp';
			case 'portal': return 'Portal';
			case 'collab': return 'Inter-agent collab';
			default: return kind;
		}
	}

	async function loadPasskeys() {
		try {
			const res = await api('/portal/passkeys');
			if (res.ok) { const data = await res.json(); passkeys = data.passkeys || []; }
		} catch {}
	}

	async function addPasskey() {
		passkeyError = null;
		addingPasskey = true;
		try {
			const optRes = await api('/portal/passkeys/register/options', { method: 'POST' });
			if (!optRes.ok) throw new Error('Failed to get registration options');
			const { options, challengeKey } = await optRes.json();
			// Server emits PRF salts as base64url; WebAuthn needs Uint8Array.
			preparePrfOptions(options as Record<string, unknown>);
			const credential = await startRegistration({ optionsJSON: options });
			const verRes = await api('/portal/passkeys/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ credential, challengeKey, name: newPasskeyName || null }),
			});
			if (!verRes.ok) { const e = await verRes.json(); throw new Error(e.error || 'Registration failed'); }
			newPasskeyName = '';
			await loadPasskeys();
		} catch (e: any) {
			passkeyError = e.message || 'Failed to add passkey';
		} finally {
			addingPasskey = false;
		}
	}

	async function renamePasskey(id: string) {
		if (!renameValue.trim()) return;
		await api('/portal/passkeys/rename', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, name: renameValue.trim() }),
		});
		renamingId = null;
		renameValue = '';
		await loadPasskeys();
	}

	async function deletePasskey(id: string, name: string | null) {
		if (!confirm(`Delete passkey "${name || 'Unnamed'}"? You cannot undo this.`)) return;
		const res = await api(`/portal/passkeys/${id}`, { method: 'DELETE' });
		if (!res.ok) { const e = await res.json(); alert(e.error || 'Failed to delete'); return; }
		await loadPasskeys();
	}

	onMount(async () => {
		const [settingsRes, statsRes, billingRes] = await Promise.all([
			api('/portal/settings').catch(() => null),
			api('/portal/stats').catch(() => null),
			api('/portal/billing').catch(() => null),
			loadProviders(),
			// runtimeAgents + assignments still feed isProviderRunning() badges in the
			// providers list, even though the per-agent assignment grid moved to /agents.
			loadRuntimeState(),
			loadAssignments(),
			loadClaudeStatus(),
			loadOpenAIStatus(),
			loadPasskeys(),
			loadLinearStatus(),
			loadChannelAuthority(),
		]);

		if (settingsRes?.ok) {
			const data = await settingsRes.json();
			settings = data.settings || settings;
		}
		if (statsRes?.ok) {
			stats = await statsRes.json();
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
			// Verify master key — hash client-side before sending (never transmit raw key).
			// Server expects keyHash (SHA-256 hex), not the raw key material.
			const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
			const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
			const verifyRes = await api('/portal/export/verify', {
				method: 'POST',
				body: JSON.stringify({ keyHash }),
			});
			if (!verifyRes.ok) {
				const err = await verifyRes.json().catch(() => ({ error: 'Verification failed' }));
				throw new Error(err.error || 'Invalid master key');
			}
			const { exportToken } = await verifyRes.json();

			// Trigger export — KEEP RAW: response is a binary zip (Content-Type:
			// application/zip), which can't be routed through the JSON-framed
			// secure channel. The /portal/export/verify above issues a
			// short-lived exportToken; this POST returns the file. Defer
			// migration to PR1c (chunked-binary frames).
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
			const res = await api('/portal/billing/portal', {
				method: 'POST',
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
				preparePrfOptions(authData.options as Record<string, unknown>);
				const credential = await startAuthentication({ optionsJSON: authData.options });
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

			// KEEP RAW: /portal/import/vault parses multipart Busboy upload
			// (2GB ZIP cap) — FormData can't serialize through JSON-framed
			// secure channel. Defer to PR1c (chunked-binary frames).
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

	// ── Account deletion (irreversible) ──

	function resetDeleteFlow() {
		deleteStage = 'idle';
		deletePhrase = '';
		deleteError = null;
		deleteAuthOptions = null;
		deleteHasMasterKey = false;
		deleteMasterKeyInput = '';
		deletePartial = false;
		deleteStats = null;
	}

	function beginDeletion() {
		resetDeleteFlow();
		deleteStage = 'typing';
	}

	// Phrase confirmed — kick off reauth. On a no-passkey deployment the auth
	// endpoint short-circuits and hands back a deletionToken directly, in
	// which case we skip the reauth stage entirely and run the purge.
	async function continueAfterPhrase() {
		if (deletePhrase !== DELETE_CONFIRM_PHRASE) {
			deleteError = `Type the phrase exactly: ${DELETE_CONFIRM_PHRASE}`;
			return;
		}
		deleteError = null;

		try {
			const res = await api('/portal/delete-account/auth', { method: 'POST' });
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: 'Auth request failed' }));
				throw new Error(err.error || 'Auth request failed');
			}
			const data = await res.json();
			if (!data.reauthRequired) {
				// No passkeys configured — token issued inline; run purge now.
				await runPurge(data.deletionToken);
				return;
			}
			deleteAuthOptions = data.options;
			deleteHasMasterKey = !!data.hasMasterKeyOption;
			deleteStage = 'reauth';
		} catch (e: any) {
			deleteError = e?.message || 'Could not start deletion';
		}
	}

	async function deleteWithPasskey() {
		deleteError = null;
		try {
			// Decode PRF salts (base64url → Uint8Array) + strip on mobile.
			// Server emits salts in options.extensions.prf.evalByCredential; WebAuthn
			// requires Uint8Array. Without this step the API rejects with the
			// "first property is not of type BufferSource" error nati hit 2026-05-21.
			preparePrfOptions(deleteAuthOptions as Record<string, unknown>);
			const credential = await startAuthentication({ optionsJSON: deleteAuthOptions });
			const verifyRes = await api('/portal/delete-account/verify', {
				method: 'POST',
				body: JSON.stringify({ credential }),
			});
			if (!verifyRes.ok) {
				const err = await verifyRes.json().catch(() => ({ error: 'Re-authentication failed' }));
				throw new Error(err.error || 'Re-authentication failed');
			}
			const { deletionToken } = await verifyRes.json();
			await runPurge(deletionToken);
		} catch (e: any) {
			if (e?.name === 'NotAllowedError') {
				deleteError = 'Passkey verification cancelled';
			} else {
				deleteError = e?.message || 'Deletion failed';
			}
		}
	}

	async function deleteWithMasterKey() {
		const key = deleteMasterKeyInput.trim();
		if (!key || key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key)) {
			deleteError = 'Enter your 64-character hex master key';
			return;
		}
		deleteError = null;
		try {
			// Hash client-side — raw key material never leaves the browser.
			const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
			const keyHash = Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0')).join('');
			const verifyRes = await api('/portal/delete-account/verify', {
				method: 'POST',
				body: JSON.stringify({ keyHash }),
			});
			if (!verifyRes.ok) {
				const err = await verifyRes.json().catch(() => ({ error: 'Invalid master key' }));
				throw new Error(err.error || 'Invalid master key');
			}
			const { deletionToken } = await verifyRes.json();
			await runPurge(deletionToken);
		} catch (e: any) {
			deleteError = e?.message || 'Deletion failed';
		}
	}

	async function runPurge(deletionToken: string) {
		deleteStage = 'deleting';
		try {
			const res = await api('/portal/delete-account', {
				method: 'POST',
				body: JSON.stringify({ deletionToken, confirmation: DELETE_CONFIRM_PHRASE }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: `Deletion failed (${res.status})` }));
				throw new Error(err.error || 'Deletion failed');
			}
			const data = await res.json();
			deleteStats = data.stats || null;
			deletePartial = !!data.partial;
			deletionRecordId = data.deletionRecordId || null;
			deleteStage = 'done';
			// Phase 5: persist receipt URL to sessionStorage so the user can
			// recover it after auth.logout() + redirect. Also build the URL
			// they can bookmark for later (the deletion_record_id is the bearer).
			if (deletionRecordId) {
				try {
					sessionStorage.setItem('mycelium-deletion-receipt-id', deletionRecordId);
				} catch { /* private mode */ }
			}
			// Server already cleared the session cookie. Log out the local
			// auth store and head to /login. Longer delay so the user can
			// see + copy the receipt URL before we bounce.
			auth.logout();
			setTimeout(() => { window.location.href = '/login'; }, deletePartial ? 8000 : 5000);
		} catch (e: any) {
			// Purge endpoint failed. Go back to typing stage so the user can
			// retry (token was consumed on the server side, so phrase +
			// reauth must be redone).
			deleteError = e?.message || 'Deletion failed';
			deleteStage = 'typing';
		}
	}

	const integrationIcons: Record<string, string> = {
		telegram: '✈',
		discord: '💬',
		portal: '🌐',
		whatsapp: '📱',
		import: '📥',
	};

	// ── Vault Security: Master Key Restore & Rotation ──

	let mkRestoreOpen = $state(false);
	let mkRestoreKey = $state('');
	let mkRestoreLoading = $state(false);
	let mkRestoreError = $state<string | null>(null);
	let mkRestoreSuccess = $state<string | null>(null);

	let mkRotateOpen = $state(false);
	let mkRotateCurrentKey = $state('');
	let mkRotateNewKey = $state('');
	let mkRotateConfirmed = $state(false);
	let mkRotateLoading = $state(false);
	let mkRotateError = $state<string | null>(null);
	let mkRotateProgress = $state<{ table?: string; processed?: number; total?: number; rowsRewrapped?: number; complete?: boolean }>({});

	function generateNewKey() {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		mkRotateNewKey = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
	}

	async function submitRestore() {
		mkRestoreError = null;
		mkRestoreSuccess = null;
		if (mkRestoreKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(mkRestoreKey)) {
			mkRestoreError = 'Master key must be 64 hex characters';
			return;
		}
		mkRestoreLoading = true;
		try {
			const res = await api('/portal/master-key/restore', {
				method: 'POST',
				body: JSON.stringify({ key: mkRestoreKey }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Restore failed');
			mkRestoreSuccess = data.kmsStored
				? 'Master key restored. Stored in Swiss KMS for auto-recovery on reboot.'
				: 'Master key restored to VPS memory.';
			mkRestoreKey = '';
			setTimeout(() => { mkRestoreOpen = false; mkRestoreSuccess = null; }, 3000);
		} catch (e) {
			mkRestoreError = e instanceof Error ? e.message : 'Restore failed';
		} finally {
			mkRestoreLoading = false;
		}
	}

	async function submitRotate() {
		mkRotateError = null;
		mkRotateProgress = {};
		if (mkRotateCurrentKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(mkRotateCurrentKey)) {
			mkRotateError = 'Current key must be 64 hex characters';
			return;
		}
		if (mkRotateNewKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(mkRotateNewKey)) {
			mkRotateError = 'New key must be 64 hex characters';
			return;
		}
		if (mkRotateCurrentKey === mkRotateNewKey) {
			mkRotateError = 'New key must differ from current key';
			return;
		}
		if (!mkRotateConfirmed) {
			mkRotateError = 'You must confirm you have saved the new key';
			return;
		}

		mkRotateLoading = true;
		try {
			// KEEP RAW: /portal/master-key/rotate streams SSE (Content-Type:
			// text/event-stream) for per-row re-wrap progress. Channel uses
			// JSON request/response; SSE migration deferred to PR1c via
			// STREAM_TYPES handler.
			const res = await fetch('/portal/master-key/rotate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ currentKey: mkRotateCurrentKey, newKey: mkRotateNewKey }),
			});
			if (!res.ok) {
				const errData = await res.json().catch(() => ({}));
				throw new Error(errData.error || `HTTP ${res.status}`);
			}

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6);
					if (payload === '[DONE]') continue;
					try {
						const event = JSON.parse(payload);
						if (event.type === 'progress') {
							mkRotateProgress = { table: event.table, processed: event.processed, total: event.total };
						} else if (event.type === 'complete') {
							mkRotateProgress = { complete: true, rowsRewrapped: event.rowsRewrapped, total: event.tablesProcessed };
						} else if (event.type === 'error') {
							throw new Error(event.message);
						}
					} catch (e) {
						if (e instanceof SyntaxError) continue;
						throw e;
					}
				}
			}

			// Force re-login (session is now invalid since key changed)
			setTimeout(() => { window.location.href = '/login'; }, 3000);
		} catch (e) {
			mkRotateError = e instanceof Error ? e.message : 'Rotation failed';
		} finally {
			mkRotateLoading = false;
		}
	}

	// ── Local recovery key (V1): reveal / copy / download the single key ────────
	let rkRevealed = $state(false);
	let rkValue = $state('');
	let rkLoading = $state(false);
	let rkError = $state<string | null>(null);
	let rkCopied = $state(false);
	const rkGrouped = $derived(rkValue ? rkValue.replace(/(.{4})/g, '$1 ').trim() : '');

	async function revealRecoveryKey() {
		rkLoading = true; rkError = null;
		try {
			const res = await fetch('/api/v1/account/recovery-key', { credentials: 'same-origin' });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Could not read the recovery key');
			rkValue = data.recoveryKey;
			rkRevealed = true;
		} catch (e) {
			rkError = e instanceof Error ? e.message : 'Could not read the recovery key';
		} finally { rkLoading = false; }
	}

	async function copyRecoveryKey() {
		try { await navigator.clipboard.writeText(rkValue); rkCopied = true; setTimeout(() => (rkCopied = false), 1800); } catch { /* */ }
	}

	function downloadRecoveryKey() {
		const body =
			'Mycelium recovery key\n\n' +
			'Keep this secret and safe. It is the ONLY way to recover your vault on a\n' +
			'new computer. Anyone with this key can read your vault. It cannot be reset.\n\n' +
			`Recovery key:\n${rkValue}\n\nSaved ${new Date().toISOString()}\n`;
		const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url; a.download = 'mycelium-recovery-key.txt';
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	// ── App passphrase lock (V1, optional) — encrypts the master keys at rest so
	// the vault won't auto-open from the Keychain alone. The recovery key still
	// works if the passphrase is forgotten (it's a lock, not a second secret).
	let lockEnabled = $state(false);
	let lockBusy = $state(false);
	let lockError = $state<string | null>(null);
	let lockMsg = $state<string | null>(null);
	let showLockForm = $state<null | 'enable' | 'disable'>(null);
	let lockPass1 = $state('');
	let lockPass2 = $state('');
	let lockPassCurrent = $state('');

	async function refreshLockStatus() {
		try {
			const res = await fetch('/api/v1/account/status', { credentials: 'same-origin' });
			if (res.ok) { const s = await res.json(); lockEnabled = s.passphraseEnabled === true; }
		} catch { /* leave as-is */ }
	}
	refreshLockStatus();

	function resetLockForm() { showLockForm = null; lockPass1 = ''; lockPass2 = ''; lockPassCurrent = ''; lockError = null; }

	async function enablePassphrase() {
		lockError = null; lockMsg = null;
		if (lockPass1.length < 8) { lockError = 'Use at least 8 characters.'; return; }
		if (lockPass1 !== lockPass2) { lockError = 'The passphrases don’t match.'; return; }
		lockBusy = true;
		try {
			const res = await fetch('/api/v1/account/passphrase/enable', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passphrase: lockPass1 }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Could not enable the passphrase');
			lockEnabled = true; resetLockForm();
			lockMsg = 'Passphrase set. Your keys are no longer in the Keychain — the app will ask for this passphrase on every launch.';
		} catch (e) { lockError = e instanceof Error ? e.message : 'Could not enable the passphrase'; }
		finally { lockBusy = false; }
	}

	async function disablePassphrase() {
		lockError = null; lockMsg = null;
		if (!lockPassCurrent) { lockError = 'Enter your passphrase.'; return; }
		lockBusy = true;
		try {
			const res = await fetch('/api/v1/account/passphrase/disable', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passphrase: lockPassCurrent }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Could not turn off the passphrase');
			lockEnabled = false; resetLockForm();
			lockMsg = 'Passphrase removed. Your keys are back in the Keychain and the vault opens automatically.';
		} catch (e) { lockError = e instanceof Error ? e.message : 'Could not turn off the passphrase'; }
		finally { lockBusy = false; }
	}
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

			<!-- Remote Access — connect Claude / any MCP client over the internet (operator password, status, connector URL) -->
			<RemoteAccessSection />

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
						<button onclick={() => startClaudeAuth()} class="text-[0.7rem] text-[var(--color-accent)] hover:underline cursor-pointer">{claudeAuthUrl ? 'Cancel' : '+ Add account'}</button>
					</div>

					<!-- Live Claude status (from CLI). Only labeled "Active" if no
					     DB-stored provider has is_active=1, otherwise this is just
					     a legacy CLI session that can be disconnected. -->
					{#if claudeStatus?.authenticated}
						{@const cliIsActive = !providers.some(p => p.provider === 'claude' && p.is_active)}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-accent)]/30 mb-2 bg-[var(--color-surface)]">
							<span class="w-2 h-2 rounded-full flex-shrink-0 bg-green-400"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{claudeStatus.email || 'Claude'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">
									{#if claudeStatus.subscriptionType}
										<span class="text-[var(--color-accent)] font-medium uppercase">{claudeStatus.subscriptionType}</span> plan ·
									{/if}
									Signed in via CLI
									{#if claudeStatus.orgName} · {claudeStatus.orgName}{/if}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if cliIsActive}
									<span class="text-[0.6rem] text-[var(--color-accent)] font-medium">Active</span>
								{/if}
								<button onclick={disconnectClaudeCli} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer" title="Disconnect CLI session">Disconnect</button>
							</div>
						</div>
					{/if}

					<!-- Additional Claude accounts from providers DB.
					     Per-row visual state machine:
					       - quarantined / setup_token: red border, dot, badge; "Mark
					         preferred" disabled with explanatory tooltip.
					       - is_active=1 AND running on at least one peer agent:
					         green dot, "Active" badge.
					       - is_active=1 AND not running anywhere: yellow dot,
					         "Preferred · restart required" (PR 2 will close this gap
					         by making the cascade automatic).
					       - is_active=0 AND running: small grey "Running" badge plus
					         a "Mark preferred" button to flip the active flag.
					       - is_active=0 AND not running: just "Mark preferred". -->
					{#each providers.filter(p => p.provider === 'claude') as p (p.id)}
						{@const quarantined = isProviderQuarantined(p)}
						{@const running = isProviderRunning(p)}
						{@const dotColor = quarantined ? '#ef4444'
							: p.status === 'expired' ? '#fbbf24'
							: p.is_active && !running ? '#fbbf24'
							: running || p.status === 'active' ? '#4ade80'
							: '#ef4444'}
						{@const borderColor = quarantined ? '#ef4444'
							: p.is_active ? 'var(--color-accent)'
							: ''}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] mb-2 transition-colors" style:border-color={borderColor}>
							<span class="w-2 h-2 rounded-full flex-shrink-0" style="background: {dotColor}"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{p.label || 'Claude'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">
									{#if quarantined}
										<span class="text-red-400">Quarantined — `claude setup-token` artifact, no `user:inference` scope. Cannot be used as a chat subscription.</span>
									{:else if p.status === 'expired'}
										Token expired
									{:else if p.is_active && !running}
										Preferred · restart required
									{:else if running}
										Running
									{:else if p.status === 'active'}
										Connected
									{:else}
										{p.status}
									{/if}
									{#if p.last_used_at} · Last used {new Date(p.last_used_at).toLocaleDateString()}{/if}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if quarantined}
									<span class="text-[0.6rem] text-red-400 font-medium" title="Re-authenticate from a Claude subscription account (not setup-token).">Quarantined</span>
								{:else if p.is_active}
									<span class="text-[0.6rem] text-[var(--color-accent)] font-medium">{running ? 'Active' : 'Preferred'}</span>
								{:else}
									{#if running}
										<span class="text-[0.6rem] text-[var(--color-text-tertiary)]" title="An agent is currently using this subscription">Running</span>
									{/if}
									<button onclick={() => setProviderActive(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] cursor-pointer">Mark preferred</button>
								{/if}
								<button onclick={() => testProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] cursor-pointer" title="Test connection">&#x21bb;</button>
								<button onclick={() => removeProvider(p.id)} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer" title="Remove">&times;</button>
							</div>
						</div>
					{/each}

					{#if !claudeStatus?.authenticated && providers.filter(p => p.provider === 'claude').length === 0 && !claudeAuthUrl}
						<div class="text-[0.7rem] text-[var(--color-text-tertiary)] p-3 rounded-lg border border-dashed border-[var(--color-border)]">
							No Claude account connected. <button onclick={() => startClaudeAuth()} class="text-[var(--color-accent)] hover:underline cursor-pointer">Connect with Claude</button>
						</div>
					{/if}

					{#if claudeAuthUrl}
						<div class="p-3 rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-surface)] space-y-2">
							<div class="text-xs text-[var(--color-text-secondary)]">
								<p>1. Sign in on the page that opened</p>
								<p>2. Copy the code shown after signing in</p>
								<p>3. Paste it below</p>
							</div>
							<div class="flex gap-2">
								<input type="text" bind:value={claudeAuthCode} placeholder="Paste the code here" autocomplete="off" data-1p-ignore
									class="flex-1 px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" />
								<button onclick={submitClaudeCode} disabled={!claudeAuthCode.trim() || claudeAuthLoading}
									class="px-3 py-1.5 text-sm font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40">
									{claudeAuthLoading ? '...' : 'Connect'}
								</button>
							</div>
							<p class="text-[0.62rem] text-[var(--color-text-tertiary)]">
								Window didn't open? <a href={claudeAuthUrl} target="_blank" rel="noopener" class="text-[var(--color-accent)] hover:underline">Click here</a>
							</p>
						</div>
					{/if}
				</div>

				<!-- OpenAI accounts -->
				<div class="mb-4">
					<div class="flex items-center justify-between mb-2">
						<span class="text-sm font-medium text-[var(--color-text-primary)]">OpenAI</span>
						<button onclick={() => showAddOpenAI = !showAddOpenAI} class="text-[0.7rem] text-[var(--color-text-tertiary)] hover:underline cursor-pointer">+ API key</button>
					</div>

					{#if openaiStatus?.authenticated}
						<div class="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-accent)] mb-2">
							<span class="w-2 h-2 rounded-full flex-shrink-0 bg-green-400"></span>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-[var(--color-text-primary)]">{openaiStatus.label || 'ChatGPT subscription'}</div>
								<div class="text-[0.65rem] text-[var(--color-text-tertiary)]">Connected via Codex OAuth</div>
							</div>
							<button onclick={disconnectOpenAI} class="text-[0.6rem] text-[var(--color-text-tertiary)] hover:text-red-400 cursor-pointer">Disconnect</button>
						</div>
					{:else if providers.filter(p => p.provider === 'openai').length === 0}
						<button onclick={() => showAddOpenAI = true} class="w-full p-3 rounded-lg border border-dashed border-[var(--color-border)] mb-2 text-sm text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer text-left">
							Connect with API key
							<span class="block text-[0.62rem] text-[var(--color-text-tertiary)] mt-0.5">Paste your OpenAI API key. Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="text-[var(--color-accent)] hover:underline" onclick={(e) => e.stopPropagation()}>platform.openai.com/api-keys</a></span>
						</button>
					{/if}
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

			<!-- Per-agent management moved to /agents on 2026-05-06.
			     Settings is operator-account only now. -->

			<!-- Connections -->
			<section class="card p-5">
				<ConnectionsChecklist compact />
			</section>

			<!-- Channel Authority — every channel the personal-agent may post to,
			     plus per-channel + global autonomous flags. Backed by
			     /portal/channels (single-agent: only personal-agent serves the
			     portal today, so this surface controls personal-agent's channels.
			     Multi-agent channel UI deferred per design doc 2026-05-06). -->
			{#if channelAuthorityLoaded}
				<section class="card p-5">
					<div class="flex items-start justify-between mb-4">
						<div>
							<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">Personal Agent · Channel Authority</h2>
							<p class="text-[0.6rem] text-[var(--color-text-tertiary)] mt-1">Channels the personal agent may send to. Operator-only. Mirrors /allow, /disallow, and /channels in chat.</p>
						</div>
						<label class="flex items-center gap-2 text-xs">
							<span class="text-[var(--color-text-secondary)]">Allow autonomous output</span>
							<input
								type="checkbox"
								checked={autonomousGlobalEnabled}
								onchange={(e) => toggleGlobalAutonomous((e.target as HTMLInputElement).checked)}
								class="accent-[var(--color-accent)]"
							/>
						</label>
					</div>

					{#if !autonomousGlobalEnabled}
						<div class="text-[0.65rem] text-amber-400 mb-3 px-3 py-2 rounded bg-amber-400/10 border border-amber-400/20">
							Wake-cycle output is globally OFF. Per-channel flags are preserved and will resume when re-enabled.
						</div>
					{/if}

					{#if authChannels.length === 0}
						<div class="text-xs text-[var(--color-text-tertiary)] py-3 italic">
							No channels registered yet. DM the bot or run /allow in a group to add one.
						</div>
					{:else}
						{#each groupChannelsByKind(authChannels) as [kind, list]}
							<div class="mb-4 last:mb-0">
								<h3 class="text-[0.65rem] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-2">{kindLabel(kind)}</h3>
								<div class="flex flex-col gap-2">
									{#each list as channel}
										<div class="flex flex-col py-2 px-3 rounded-lg bg-[var(--color-elevated)]">
											<div class="flex items-center justify-between">
												<div class="flex-1 min-w-0">
													<div class="flex items-center gap-2">
														<span class="text-sm font-medium text-[var(--color-text-primary)] truncate">{channel.label}</span>
														{#if channel.isOperatorDM}
															<span class="text-[0.55rem] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)] uppercase tracking-wider">operator</span>
														{/if}
													</div>
													<span class="text-[0.6rem] text-[var(--color-text-tertiary)] font-mono">{channel.kind}_{channel.id}</span>
												</div>
												<div class="flex items-center gap-3 ml-2">
													<label class="flex items-center gap-1.5 text-xs cursor-pointer" title={!autonomousGlobalEnabled ? 'Globally disabled — flip the master switch above' : ''}>
														<span class="text-[var(--color-text-secondary)]">autonomous</span>
														<input
															type="checkbox"
															checked={!!channel.allowAutonomous}
															disabled={!autonomousGlobalEnabled || channel.isOperatorDM}
															onchange={(e) => toggleChannelAutonomous(channel, (e.target as HTMLInputElement).checked)}
															class="accent-[var(--color-accent)]"
														/>
													</label>
													{#if !channel.isOperatorDM}
														<button
															class="text-xs text-[var(--color-text-tertiary)] hover:text-red-400 transition-colors"
															onclick={() => revokeChannel(channel)}
														>
															Revoke
														</button>
													{/if}
												</div>
											</div>
											{#if channel.members && channel.members.length > 0}
												<div class="text-[0.6rem] text-[var(--color-text-tertiary)] mt-1.5 truncate">
													members: {channel.members.slice(0, 8).map((m) => m.name ? `${m.name} (${m.id})` : m.id).join(', ')}{channel.members.length > 8 ? ` +${channel.members.length - 8} more` : ''}
												</div>
											{/if}
										</div>
									{/each}
								</div>
							</div>
						{/each}
					{/if}
				</section>
			{/if}

			<!-- Intelligence — connect Mycelium's outbound AI to any provider -->
			<IntelligenceSection />

			<!-- Voice / TTS — provider config + per-voice preview -->
			<VoiceSection />

			<!-- External Integrations — user-supplied API credentials -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">External Integrations</h2>

				<!-- Linear -->
				<div class="py-2 px-3 rounded-lg bg-[var(--color-elevated)]">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-3">
							<span class="text-lg">▲</span>
							<div>
								<div class="text-sm text-[var(--color-text-primary)] font-medium">Linear</div>
								<div class="text-xs text-[var(--color-text-tertiary)]">
									{#if linearLoading}
										checking…
									{:else if linear.connected}
										connected{linear.teamName ? ` — ${linear.teamName}${linear.teamKey ? ` (${linear.teamKey})` : ''}` : ''}{linear.viewerName ? ` as ${linear.viewerName}` : ''}
									{:else if linear.error}
										error — {linear.error}
									{:else}
										not connected
									{/if}
								</div>
							</div>
						</div>
						<div class="flex items-center gap-2">
							<div class="w-1.5 h-1.5 rounded-full {linear.connected ? 'bg-jade' : 'bg-[var(--color-text-tertiary)]'}"></div>
							{#if linear.connected}
								<button onclick={disconnectLinear} class="text-xs text-[var(--color-text-tertiary)] hover:text-coral cursor-pointer transition">Disconnect</button>
							{:else}
								<button onclick={() => { showLinearForm = !showLinearForm; linearError = null; }} class="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">{showLinearForm ? 'Cancel' : 'Connect'}</button>
							{/if}
						</div>
					</div>

					{#if showLinearForm && !linear.connected}
						<form onsubmit={saveLinear} class="mt-4 space-y-3">
							<div>
								<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1" for="linear-key">API Key</label>
								<input
									id="linear-key"
									type="password"
									bind:value={linearApiKey}
									placeholder="lin_api_..."
									autocomplete="off"
									required
									class="w-full px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none"
								/>
								<div class="text-[10px] text-[var(--color-text-tertiary)] mt-1">
									Create one at linear.app → Settings → API → Personal API keys
								</div>
							</div>
							<div>
								<label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1" for="linear-team">Team ID <span class="normal-case tracking-normal">(optional)</span></label>
								<input
									id="linear-team"
									type="text"
									bind:value={linearTeamId}
									placeholder="UUID — leave blank for all teams"
									autocomplete="off"
									class="w-full px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:border-aurum outline-none"
								/>
								<div class="text-[10px] text-[var(--color-text-tertiary)] mt-1">
									Leave blank to access all teams your key can see. To scope to one team: Linear → team → Settings → General → Team ID
								</div>
							</div>
							{#if linearError}
								<div class="text-xs text-coral">{linearError}</div>
							{/if}
							<div class="flex items-center gap-2">
								<button type="submit" disabled={linearSaving || !linearApiKey.trim()} class="px-3 py-1.5 text-xs rounded bg-aurum text-[var(--color-bg)] font-medium disabled:opacity-50 disabled:cursor-not-allowed">
									{linearSaving ? 'Verifying…' : 'Connect'}
								</button>
								<span class="text-[10px] text-[var(--color-text-tertiary)]">
									Stored encrypted. Mya and Com will pick up the change within 5 min.
								</span>
							</div>
						</form>
					{/if}
				</div>
			</section>

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

			<!-- Recovery Key (V1 local) — reveal to back up the single key again -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Recovery Key</h2>
				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Your recovery key</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							The single key that unlocks this vault on a new computer. Reveal it to back it up again — keep it secret; anyone with it can read your vault.
						</p>
					</div>
					{#if !rkRevealed}
						<button
							onclick={revealRecoveryKey}
							disabled={rkLoading}
							class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] whitespace-nowrap"
						>{rkLoading ? 'Revealing…' : 'Show recovery key'}</button>
					{/if}
				</div>
				{#if rkError}
					<p class="text-xs text-coral mt-2">{rkError}</p>
				{/if}
				{#if rkRevealed}
					<div class="mt-3 p-3 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] font-mono text-sm tracking-wide break-all text-[var(--color-text-primary)] select-all">
						{rkGrouped}
					</div>
					<div class="flex gap-2 mt-3">
						<button onclick={copyRecoveryKey} class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]">{rkCopied ? 'Copied ✓' : 'Copy'}</button>
						<button onclick={downloadRecoveryKey} class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]">Download</button>
						<button onclick={() => { rkRevealed = false; rkValue = ''; }} class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Hide</button>
					</div>
				{/if}
			</section>

			<!-- App passphrase lock (V1, optional) — encrypt the keys at rest -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">App Passphrase</h2>
				<div class="flex items-center justify-between gap-4">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">
							{lockEnabled ? 'Passphrase lock is on' : 'Lock the app with a passphrase'}
						</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							{#if lockEnabled}
								Your keys are encrypted at rest — the app asks for this passphrase on every launch. Your recovery key still works if you forget it.
							{:else}
								Optional. Encrypts your keys at rest so the vault won’t open from the Keychain alone. You’ll enter it each launch; your recovery key remains the backup.
							{/if}
						</p>
					</div>
					{#if showLockForm === null}
						<button
							onclick={() => { resetLockForm(); showLockForm = lockEnabled ? 'disable' : 'enable'; }}
							class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] whitespace-nowrap"
						>{lockEnabled ? 'Turn off' : 'Set passphrase'}</button>
					{/if}
				</div>

				{#if lockError}<p class="text-xs text-coral mt-2">{lockError}</p>{/if}
				{#if lockMsg}<p class="text-xs text-jade mt-2">{lockMsg}</p>{/if}

				{#if showLockForm === 'enable'}
					<div class="mt-3 space-y-2">
						<input bind:value={lockPass1} type="password" autocomplete="new-password" placeholder="New passphrase (min 8 characters)"
							class="input w-full text-sm" />
						<input bind:value={lockPass2} type="password" autocomplete="new-password" placeholder="Confirm passphrase"
							onkeydown={(e) => { if (e.key === 'Enter') enablePassphrase(); }}
							class="input w-full text-sm" />
						<div class="flex gap-2">
							<button onclick={enablePassphrase} disabled={lockBusy}
								class="px-3 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] text-sm font-medium disabled:opacity-50">
								{lockBusy ? 'Saving…' : 'Enable lock'}</button>
							<button onclick={resetLockForm} class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
						</div>
					</div>
				{:else if showLockForm === 'disable'}
					<div class="mt-3 space-y-2">
						<input bind:value={lockPassCurrent} type="password" autocomplete="current-password" placeholder="Current passphrase"
							onkeydown={(e) => { if (e.key === 'Enter') disablePassphrase(); }}
							class="input w-full text-sm" />
						<div class="flex gap-2">
							<button onclick={disablePassphrase} disabled={lockBusy}
								class="px-3 py-2 rounded-lg bg-coral/15 border border-coral/30 text-sm text-[var(--color-text-primary)] disabled:opacity-50">
								{lockBusy ? 'Removing…' : 'Turn off lock'}</button>
							<button onclick={resetLockForm} class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Cancel</button>
						</div>
					</div>
				{/if}
			</section>

			<!-- Vault Security: Master Key Restore + Rotation -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Vault Security</h2>

				<!-- Restore Master Key -->
				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Restore Master Key</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							Re-enter your master key after a VPS reboot or if encryption is unavailable. No data is changed.
						</p>
					</div>
					{#if !mkRestoreOpen}
						<button
							onclick={() => { mkRestoreOpen = true; mkRestoreError = null; }}
							class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]"
						>Restore</button>
					{/if}
				</div>
				{#if mkRestoreOpen}
					<div class="mt-3 p-3 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)]">
						<p class="text-xs text-[var(--color-text-secondary)] mb-2">Enter your existing master key (64 hex characters)</p>
						<div class="flex gap-2">
							<input
								type="password"
								bind:value={mkRestoreKey}
								placeholder="64-character hex key"
								class="flex-1 px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
								maxlength="64"
								onkeydown={(e) => { if (e.key === 'Enter') submitRestore(); }}
							/>
							<button
								onclick={submitRestore}
								disabled={mkRestoreLoading}
								class="px-3 py-2 rounded-lg bg-aurum/20 border border-aurum/40 hover:border-aurum transition-colors text-sm text-aurum font-medium"
							>{mkRestoreLoading ? 'Restoring...' : 'Confirm'}</button>
							<button
								onclick={() => { mkRestoreOpen = false; mkRestoreKey = ''; mkRestoreError = null; }}
								class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
							>Cancel</button>
						</div>
						{#if mkRestoreError}
							<p class="text-xs text-coral mt-1.5">{mkRestoreError}</p>
						{/if}
						{#if mkRestoreSuccess}
							<p class="text-xs text-jade mt-1.5">{mkRestoreSuccess}</p>
						{/if}
					</div>
				{/if}

				<!-- Rotate Master Key -->
				<div class="flex items-center justify-between mt-5 pt-5 border-t border-[var(--color-border)]">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Rotate Master Key</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							Generate a new master key and re-encrypt all data. Takes 1-2 minutes. You will be logged out.
						</p>
					</div>
					{#if !mkRotateOpen}
						<button
							onclick={() => { mkRotateOpen = true; mkRotateError = null; mkRotateConfirmed = false; }}
							class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-coral transition-colors text-sm text-[var(--color-text-primary)]"
						>Rotate</button>
					{/if}
				</div>
				{#if mkRotateOpen}
					<div class="mt-3 p-3 rounded-lg bg-[var(--color-elevated)] border border-coral/40">
						<p class="text-xs font-medium text-coral mb-2">⚠️ Warning: Save the new key in a password manager immediately. If you lose it, your data is unrecoverable.</p>

						<div class="space-y-2">
							<div>
								<label class="text-xs text-[var(--color-text-tertiary)] block mb-1">Current master key</label>
								<input
									type="password"
									bind:value={mkRotateCurrentKey}
									placeholder="64-character hex key"
									class="w-full px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
									maxlength="64"
								/>
							</div>
							<div>
								<label class="text-xs text-[var(--color-text-tertiary)] block mb-1">New master key</label>
								<div class="flex gap-2">
									<input
										type="text"
										bind:value={mkRotateNewKey}
										placeholder="64-character hex key"
										class="flex-1 px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
										maxlength="64"
									/>
									<button
										onclick={generateNewKey}
										class="px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] hover:border-aurum text-xs text-[var(--color-text-secondary)]"
									>Generate</button>
								</div>
							</div>
							<label class="flex items-center gap-2 mt-2">
								<input type="checkbox" bind:checked={mkRotateConfirmed} class="rounded" />
								<span class="text-xs text-[var(--color-text-secondary)]">I have saved the new key in a secure location</span>
							</label>
						</div>

						<div class="flex gap-2 mt-3">
							<button
								onclick={submitRotate}
								disabled={mkRotateLoading || !mkRotateConfirmed}
								class="px-3 py-2 rounded-lg bg-coral/20 border border-coral/40 hover:border-coral transition-colors text-sm text-coral font-medium disabled:opacity-50"
							>{mkRotateLoading ? 'Rotating...' : 'Confirm Rotation'}</button>
							<button
								onclick={() => { mkRotateOpen = false; mkRotateCurrentKey = ''; mkRotateNewKey = ''; mkRotateError = null; }}
								disabled={mkRotateLoading}
								class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
							>Cancel</button>
						</div>

						{#if mkRotateError}
							<p class="text-xs text-coral mt-2">{mkRotateError}</p>
						{/if}

						{#if mkRotateProgress.table || mkRotateProgress.complete}
							<div class="mt-3 p-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
								{#if mkRotateProgress.complete}
									<p class="text-xs text-jade">✓ Re-wrapped {mkRotateProgress.rowsRewrapped} records across {mkRotateProgress.total} tables. Logging out...</p>
								{:else}
									<p class="text-xs text-[var(--color-text-secondary)]">
										{mkRotateProgress.table}: {mkRotateProgress.processed} / {mkRotateProgress.total}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</section>

			<!-- Passkeys -->
			<section class="card p-5">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">Passkeys</h2>
					<button
						onclick={addPasskey}
						disabled={addingPasskey}
						class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-azure bg-azure/10 hover:bg-azure/20 transition-colors disabled:opacity-50"
					>
						<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
						{addingPasskey ? 'Adding...' : 'Add Passkey'}
					</button>
				</div>

				{#if addingPasskey}
					<div class="mb-3">
						<input
							type="text"
							bind:value={newPasskeyName}
							placeholder="Name this passkey (e.g. MacBook, iPhone)"
							class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] focus:outline-none focus:border-azure"
						/>
					</div>
				{/if}

				{#if passkeyError}
					<p class="text-xs text-coral mb-3">{passkeyError}</p>
				{/if}

				{#if passkeys.length === 0}
					<p class="text-sm text-[var(--color-text-tertiary)]">No passkeys registered.</p>
				{:else}
					<div class="space-y-2">
						{#each passkeys as pk (pk.id)}
							<div class="flex items-center justify-between p-3 rounded-lg bg-[var(--color-bg-secondary)]">
								<div class="flex items-center gap-3 flex-1 min-w-0">
									<svg class="w-5 h-5 text-[var(--color-text-tertiary)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
									</svg>
									<div class="min-w-0">
										{#if renamingId === pk.id}
											<form onsubmit={(e) => { e.preventDefault(); renamePasskey(pk.id); }} class="flex gap-2">
												<input
													type="text"
													bind:value={renameValue}
													class="px-2 py-1 rounded text-sm bg-[var(--color-bg-primary)] border border-[var(--color-border)] focus:outline-none focus:border-azure"
													onfocus={() => {}}
												/>
												<button type="submit" class="text-xs text-azure">Save</button>
												<button type="button" onclick={() => { renamingId = null; }} class="text-xs text-[var(--color-text-tertiary)]">Cancel</button>
											</form>
										{:else}
											<p class="text-sm text-[var(--color-text-primary)] truncate">
												{pk.name || 'Unnamed passkey'}
												{#if pk.has_prf}<span class="text-[10px] text-azure ml-1">PRF</span>{/if}
											</p>
											<p class="text-[11px] text-[var(--color-text-tertiary)]">
												Added {new Date(pk.created_at).toLocaleDateString()}
												{#if pk.last_used_at}
													&middot; Last used {new Date(pk.last_used_at).toLocaleDateString()}
												{:else}
													&middot; Never used
												{/if}
											</p>
										{/if}
									</div>
								</div>
								{#if renamingId !== pk.id}
									<div class="flex items-center gap-1 shrink-0">
										<button
											onclick={() => { renamingId = pk.id; renameValue = pk.name || ''; }}
											class="p-1.5 rounded hover:bg-[var(--color-bg-primary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
											title="Rename"
										>
											<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
										</button>
										{#if passkeys.length > 1}
											<button
												onclick={() => deletePasskey(pk.id, pk.name)}
												class="p-1.5 rounded hover:bg-coral/10 text-[var(--color-text-tertiary)] hover:text-coral transition-colors"
												title="Delete"
											>
												<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
											</button>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
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

			<!-- Danger Zone -->
			<section class="card p-5 border border-coral/40">
				<h2 class="text-xs font-medium text-coral uppercase tracking-wider mb-4">Danger Zone</h2>

				<div class="flex items-start justify-between gap-4">
					<div class="min-w-0">
						<p class="text-sm text-[var(--color-text-primary)]">Delete Account</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							Irreversibly erases every byte of your data — messages, documents, attachments, mindscape,
							contacts, health, wealth, passkeys, identities. Cannot be undone. Export first if you want a backup.
						</p>
					</div>
					{#if deleteStage === 'idle'}
						<button
							onclick={beginDeletion}
							class="shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-coral bg-coral/10 hover:bg-coral/20 transition-colors"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
							</svg>
							Delete Account
						</button>
					{/if}
				</div>

				{#if deleteStage === 'typing'}
					<div class="mt-4 p-4 rounded-lg bg-coral/5 border border-coral/30 space-y-3">
						<p class="text-sm text-coral font-medium">This cannot be undone.</p>
						<p class="text-xs text-[var(--color-text-secondary)]">
							To confirm, type the phrase below exactly. After that, you will be asked to
							re-authenticate with your passkey or master key.
						</p>
						<div>
							<label class="text-[0.65rem] text-[var(--color-text-tertiary)] uppercase tracking-wider block mb-1">
								Type: <span class="font-mono text-coral">{DELETE_CONFIRM_PHRASE}</span>
							</label>
							<input
								type="text"
								bind:value={deletePhrase}
								autocomplete="off"
								autocapitalize="off"
								spellcheck={false}
								placeholder={DELETE_CONFIRM_PHRASE}
								class="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] outline-none focus:border-coral"
							/>
						</div>
						{#if deleteError}
							<p class="text-xs text-coral">{deleteError}</p>
						{/if}
						<div class="flex items-center gap-2 pt-1">
							<button
								onclick={resetDeleteFlow}
								class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
							>Cancel</button>
							<button
								onclick={continueAfterPhrase}
								disabled={deletePhrase !== DELETE_CONFIRM_PHRASE}
								class="px-3 py-2 rounded-lg text-sm text-coral bg-coral/10 hover:bg-coral/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							>Continue</button>
						</div>
					</div>
				{/if}

				{#if deleteStage === 'reauth'}
					<div class="mt-4 p-4 rounded-lg bg-coral/5 border border-coral/30 space-y-3">
						<p class="text-sm text-coral font-medium">Re-authenticate to confirm deletion</p>
						<p class="text-xs text-[var(--color-text-secondary)]">
							Use a passkey{deleteHasMasterKey ? ' or your master key' : ''} to prove you really
							are the account owner. No going back after this step.
						</p>
						<div class="flex flex-wrap items-center gap-2">
							<button
								onclick={deleteWithPasskey}
								class="px-3 py-2 rounded-lg text-sm text-coral bg-coral/10 hover:bg-coral/20 transition-colors"
							>Use Passkey</button>
							<button
								onclick={resetDeleteFlow}
								class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
							>Cancel</button>
						</div>
						{#if deleteHasMasterKey}
							<div class="pt-2 border-t border-[var(--color-border)]">
								<label class="text-[0.65rem] text-[var(--color-text-tertiary)] uppercase tracking-wider block mb-1">
									Or enter your master key
								</label>
								<div class="flex gap-2">
									<input
										type="password"
										bind:value={deleteMasterKeyInput}
										placeholder="64-character hex key"
										maxlength="64"
										class="flex-1 px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] outline-none focus:border-coral"
										onkeydown={(e) => { if (e.key === 'Enter') deleteWithMasterKey(); }}
									/>
									<button
										onclick={deleteWithMasterKey}
										class="px-3 py-2 rounded-lg text-sm text-coral bg-coral/10 hover:bg-coral/20 transition-colors"
									>Confirm</button>
								</div>
							</div>
						{/if}
						{#if deleteError}
							<p class="text-xs text-coral">{deleteError}</p>
						{/if}
					</div>
				{/if}

				{#if deleteStage === 'deleting'}
					<div class="mt-4 p-4 rounded-lg bg-coral/5 border border-coral/30 flex items-center gap-3">
						<div class="w-4 h-4 border-2 border-coral/40 border-t-coral rounded-full animate-spin"></div>
						<p class="text-sm text-coral">Erasing your vault…</p>
					</div>
				{/if}

				{#if deleteStage === 'done'}
					<div class="mt-4 p-4 rounded-lg bg-coral/5 border border-coral/30 space-y-3">
						<p class="text-sm text-coral font-medium">
							{deletePartial ? 'Deletion completed with partial failures' : 'Account deleted'}
						</p>
						<p class="text-xs text-[var(--color-text-secondary)]">
							{deletePartial
								? 'Some surfaces could not be cleaned. Operator deprovision script will complete them. You will be signed out shortly.'
								: 'Customer-side data wiped. Operator deprovision (DNS, VPS, KMS) runs next.'}
						</p>

						{#if deletionRecordId}
							<div class="mt-3 p-3 rounded bg-[var(--color-bg-soft)] border border-[var(--color-border-subtle)] space-y-2">
								<p class="text-xs font-semibold text-[var(--color-text-secondary)]">
									Deletion Receipt
								</p>
								<p class="text-[0.7rem] text-[var(--color-text-tertiary)]">
									Save this URL — you can fetch the full per-target deletion ledger
									(every D1 table, R2 prefix, external system) by visiting it.
									GDPR Article 17 receipt.
								</p>
								<div class="flex items-center gap-2">
									<code class="flex-1 text-[0.7rem] font-mono break-all text-[var(--color-text-primary)] bg-[var(--color-bg)] px-2 py-1 rounded">
										{window.location.origin}/portal/deletion-receipt?id={deletionRecordId}
									</code>
									<button
										onclick={() => navigator.clipboard?.writeText(`${window.location.origin}/portal/deletion-receipt?id=${deletionRecordId}`)}
										class="btn btn-secondary text-xs"
									>Copy</button>
								</div>
								<p class="text-[0.65rem] text-[var(--color-text-tertiary)]">
									Record ID: <code class="font-mono">{deletionRecordId}</code>
								</p>
							</div>
						{/if}

						{#if deleteStats && deletePartial}
							<div class="mt-2 text-[0.65rem] font-mono text-[var(--color-text-tertiary)] max-h-32 overflow-y-auto">
								{#each Object.entries(deleteStats).filter(([, v]) => typeof v === 'string' && v.startsWith('error:')) as [table, msg]}
									<div>{table}: {msg}</div>
								{/each}
							</div>
						{/if}
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

</style>
