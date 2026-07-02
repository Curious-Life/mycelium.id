<script lang="ts">
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { auth } from '$lib/stores/auth';
	import { api } from '$lib/api';
	import { browser } from '$app/environment';
	import ProfileView from '$lib/views/ProfileView.svelte';
	import AreasView from '$lib/views/AreasView.svelte';
	import VoiceSection from '$lib/components/settings/VoiceSection.svelte';
	import ChannelsSection from '$lib/components/settings/ChannelsSection.svelte';
	import AISettings from '$lib/components/settings/AISettings.svelte';
	import EngineSelector from '$lib/components/settings/EngineSelector.svelte';
	import UsageSection from '$lib/components/settings/UsageSection.svelte';
	import AIAccessSection from '$lib/components/settings/AIAccessSection.svelte';
	import AgentCaptureSection from '$lib/components/settings/AgentCaptureSection.svelte';
	import KeepAwakeSection from '$lib/components/settings/KeepAwakeSection.svelte';
	import RemoteAccessSection from '$lib/components/settings/RemoteAccessSection.svelte';
	import ConnectYourAISection from '$lib/components/settings/ConnectYourAISection.svelte';
	import PhoneConnectSection from '$lib/components/settings/PhoneConnectSection.svelte';
	import HarnessPickerSection from '$lib/components/settings/HarnessPickerSection.svelte';

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


	let settings = $state<Settings>({ timezone: 'UTC' });
	let stats = $state<Stats | null>(null);
	// agents[] moved to /agents (Manage tab) on 2026-05-06.

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

	let billing = $state<BillingInfo | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let saved = $state(false);

	// One hub, two panes. The left rail lists categories (grouped); the right pane
	// shows one at a time. The active pane rides in the tab params (mirrored to
	// /settings?pane=…) so deep-links and back/forward work — same pattern as
	// StreamsView's facet. Profile is folded in as the first pane (one home for
	// "you"); it self-loads, so it renders outside the settings `loading` gate.
	let { pane = 'profile', setParams }: {
		pane?: string;
		setParams?: (patch: Record<string, unknown>) => void;
	} = $props();

	interface PaneDef { id: string; label: string; icon: string; desc: string; managedOnly?: boolean }
	const GROUPS: { title: string; items: PaneDef[] }[] = [
		{ title: '', items: [
			{ id: 'profile', label: 'Profile', icon: 'user', desc: 'Your public identity and how you think' },
		] },
		{ title: 'Intelligence & access', items: [
			{ id: 'intelligence', label: 'Intelligence', icon: 'sparkles', desc: 'The model that powers Mycelium' },
			{ id: 'areas', label: 'Areas', icon: 'layers', desc: 'Life domains that give your AI context' },
			{ id: 'usage', label: 'Usage', icon: 'chart', desc: 'Token consumption — input/output by area and model' },
			{ id: 'connections', label: 'Connections', icon: 'plug', desc: 'Use Mycelium from your other apps and devices' },
			{ id: 'channels', label: 'Channels', icon: 'messages', desc: 'Where your agent may listen and reply' },
			{ id: 'integrations', label: 'Integrations', icon: 'puzzle', desc: 'Connect third-party tools with your own keys' },
		] },
		{ title: 'Your vault', items: [
			{ id: 'security', label: 'Security', icon: 'shield', desc: 'Keys, locks, and recovery' },
		] },
		{ title: 'App', items: [
			{ id: 'general', label: 'General', icon: 'sliders', desc: 'Appearance and region' },
			{ id: 'billing', label: 'Billing', icon: 'card', desc: 'Your subscription', managedOnly: true },
		] },
		{ title: '', items: [
			{ id: 'account', label: 'Account', icon: 'id', desc: 'Sign-in and account lifecycle' },
		] },
	];
	const allPanes = GROUPS.flatMap((g) => g.items);

	// Managed-hosted detection: Billing only exists for managed subscriptions, so
	// it is auto-hidden on a local single-user vault (where billing.managed is
	// false/absent). Other surfaces (relay handle, remote access) apply to
	// self-hosted too and stay visible.
	const isManaged = $derived(!!billing?.managed);

	// Resolve the active pane defensively: unknown ids (or billing when not
	// managed) fall back to Profile so a stale deep-link never shows a blank pane.
	const activePane = $derived.by(() => {
		const def = allPanes.find((p) => p.id === pane);
		if (!def) return 'profile';
		if (def.managedOnly && !isManaged) return 'profile';
		return def.id;
	});
	const activeDef = $derived(allPanes.find((p) => p.id === activePane) ?? allPanes[0]);

	let railQuery = $state('');

	// Mobile = list → detail drill. On a phone the rail is the whole screen until
	// you pick a pane; a back button returns to the list.
	let isMobile = $state(false);
	let mobileDetail = $state(false);
	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia('(max-width: 767px)');
		isMobile = mq.matches;
		const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	function selectPane(id: string) {
		setParams?.({ pane: id });
		if (isMobile) mobileDetail = true;
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

	onMount(async () => {
		// Deep-link to a pane (?pane=…, with legacy ?tab=… aliased) is resolved by
		// the /settings route → tab params → the `pane` prop, so nothing to parse
		// here. We just load the data the panes need.
		const [settingsRes, statsRes, billingRes] = await Promise.all([
			api('/portal/settings').catch(() => null),
			api('/portal/stats').catch(() => null),
			api('/portal/billing').catch(() => null),
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

	// ── Local recovery key (V1): reveal / copy / download the single key ────────
	let rkRevealed = $state(false);
	let rkValue = $state('');
	let rkLoading = $state(false);
	let rkError = $state<string | null>(null);
	let rkCopied = $state(false);
	let rkSaving = $state<'keychain' | '1password' | null>(null);
	let rkSavedTo = $state<'keychain' | '1password' | null>(null);
	let rkSaveError = $state<string | null>(null);
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

	// One-click save to Keychain / 1Password — the key is read + handed to the store
	// SERVER-SIDE (it never leaves the box via the browser). "Keychain" = Keychain
	// Access (not the Apple Passwords app); 1Password needs the `op` CLI signed in.
	async function saveRecoveryKey(target: 'keychain' | '1password') {
		rkSaving = target; rkSaveError = null;
		try {
			const res = await fetch('/api/v1/account/recovery-key/save', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ target }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Could not save');
			rkSavedTo = target;
		} catch (e) {
			rkSaveError = e instanceof Error ? e.message : 'Could not save';
		} finally { rkSaving = null; }
	}

	// ── Vault backup (V1): download an encrypted .myvault snapshot to the user's
	// own storage. The recovery key only decrypts data on THIS device — a backup
	// file is what makes device loss recoverable. The file is ciphertext; useless
	// without the recovery key.
	let vbBusy = $state(false);
	let vbError = $state<string | null>(null);
	let vbDone = $state(false);

	async function backupVault() {
		vbBusy = true; vbError = null; vbDone = false;
		try {
			const res = await fetch('/api/v1/account/backup', { credentials: 'same-origin' });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || d.error || 'Backup failed');
			}
			const blob = await res.blob();
			const stamp = new Date().toISOString().slice(0, 10);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url; a.download = `mycelium-vault-${stamp}.myvault`;
			document.body.appendChild(a); a.click(); a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			vbDone = true;
		} catch (e) {
			vbError = e instanceof Error ? e.message : 'Backup failed';
		} finally { vbBusy = false; }
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

{#snippet railIcon(name: string)}
	{#if name === 'user'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.1a7.5 7.5 0 0 1 15 0A17.9 17.9 0 0 1 12 21.75c-2.7 0-5.2-.6-7.5-1.65Z"/></svg>
	{:else if name === 'sparkles'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.8 9.8 12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12zM18 4.5l.6 1.9 1.9.6-1.9.6L18 9.5l-.6-1.9-1.9-.6 1.9-.6z"/></svg>
	{:else if name === 'layers'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2 2 7l10 5 10-5-10-5ZM2 12l10 5 10-5M2 17l10 5 10-5"/></svg>
	{:else if name === 'plug'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0zm6 9v4"/></svg>
	{:else if name === 'messages'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m8.25 1.5a2.25 2.25 0 0 1-2.25 2.25H8.7L4.5 19.5V6.75A2.25 2.25 0 0 1 6.75 4.5h11.25a2.25 2.25 0 0 1 2.25 2.25z"/></svg>
	{:else if name === 'puzzle'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14 6a2 2 0 1 0-4 0H6v4a2 2 0 1 1 0 4v4h4a2 2 0 1 1 4 0h4v-4a2 2 0 1 0 0-4V6z"/></svg>
	{:else if name === 'database'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.07-3.69 3.75-8.25 3.75s-8.25-1.68-8.25-3.75 3.69-3.75 8.25-3.75 8.25 1.68 8.25 3.75zM3.75 6.375v11.25c0 2.07 3.69 3.75 8.25 3.75s8.25-1.68 8.25-3.75V6.375M3.75 12c0 2.07 3.69 3.75 8.25 3.75s8.25-1.68 8.25-3.75"/></svg>
	{:else if name === 'shield'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3 4.5 6v5.5c0 4.5 3.2 7.4 7.5 8.8 4.3-1.4 7.5-4.3 7.5-8.8V6zm0 6.75v3.75"/></svg>
	{:else if name === 'sliders'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9m-9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-6 0h3m1.5 6h9m-12 0h0m4.5 6h9m-12 0h0m4.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6-6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>
	{:else if name === 'card'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15A2.25 2.25 0 0 0 2.25 6.75v10.5A2.25 2.25 0 0 0 4.5 19.5z"/></svg>
	{:else if name === 'id'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15A2.25 2.25 0 0 0 2.25 6.75v10.5A2.25 2.25 0 0 0 4.5 19.5zm6-10.125a1.875 1.875 0 1 1-3.75 0 1.875 1.875 0 0 1 3.75 0zm1.294 6.336a5.5 5.5 0 0 0-6.338 0 .53.53 0 0 0-.21.434c0 .29.235.525.526.525h5.706c.29 0 .526-.234.526-.525a.53.53 0 0 0-.21-.434z"/></svg>
	{:else if name === 'chart'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 20.25h18M6 20.25V13.5m4.5 6.75V8.25M15 20.25v-9m4.5 9V6.75"/></svg>
	{/if}
{/snippet}

<div class="settings-hub">
	<!-- Left rail — identity chip, search, grouped categories. On a phone the
	     rail IS the screen until a pane is picked (mobile drill). -->
	<aside class="rail" class:drilled={isMobile && mobileDetail}>
		{#if $auth.user}
			<button class="rail-id" onclick={() => selectPane('profile')} aria-label="Open your profile">
				<span class="rail-id-avatar">{($auth.user.displayName || '?')[0].toUpperCase()}</span>
				<span class="rail-id-name">{$auth.user.displayName || 'User'}</span>
			</button>
		{/if}

		<div class="rail-search">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-4.35-4.35M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z"/></svg>
			<input class="rail-search-input" placeholder="Search settings" bind:value={railQuery} aria-label="Search settings" />
		</div>

		<nav class="rail-nav">
			{#each GROUPS as g}
				{@const items = g.items.filter((p) => (!p.managedOnly || isManaged) && (!railQuery || p.label.toLowerCase().includes(railQuery.toLowerCase())))}
				{#if items.length}
					{#if g.title && !railQuery}<div class="rail-group">{g.title}</div>{/if}
					{#each items as p}
						<button class="rail-item" class:on={activePane === p.id} onclick={() => selectPane(p.id)} aria-current={activePane === p.id ? 'page' : undefined}>
							<span class="rail-ic">{@render railIcon(p.icon)}</span>
							<span>{p.label}</span>
						</button>
					{/each}
				{/if}
			{/each}
		</nav>
	</aside>

	<!-- Detail — one pane at a time. -->
	<section class="detail" class:drilled={isMobile && !mobileDetail}>
		{#if isMobile}
			<button class="mobile-back" onclick={() => (mobileDetail = false)}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>
				Settings
			</button>
		{/if}

		{#if activePane === 'profile'}
			<!-- Profile is self-loading (its own /portal/profile + /stats fetch), so
			     it lives outside the settings `loading` gate and fills the pane. -->
			<div class="profile-host"><ProfileView /></div>
		{:else if activePane === 'areas'}
			<AreasView />
		{:else}
			<div class="detail-body">
				<header class="pane-head">
					<h1 class="pane-title">{activeDef.label}</h1>
					<p class="pane-desc">{activeDef.desc}</p>
				</header>

				{#if loading}
					<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading…</div>
				{:else}
				<div class="space-y-6">

			{#if activePane === 'connections'}
			<!-- Mental-model intro: two doors (memory + model), two reaches (local /
			     remote). Grounds the cards below so they don't read as a flat pile.
			     The stale onboarding checklist (ConnectionsChecklist) was removed here
			     2026-06-15 — it duplicated the dedicated onboarding flow and the
			     Connect-an-app cards. Local-first order: most clients connect on this
			     Mac; remote is the secondary path. -->
			<div class="conn-intro">
				<p>
					Mycelium exposes two doors to any AI app — <span class="door">Memory</span> over MCP and
					<span class="door">Model</span> over an OpenAI-compatible gateway. Use them on
					<strong>this Mac</strong> right now, or reach them <strong>over the internet</strong> with an address.
				</p>
			</div>

			<div class="conn-group">Your phone</div>
			<!-- The native iOS app: shows Server address + Access token (the Bearer,
			     NOT the operator password) with copy buttons + Tailscale-TLS setup. -->
			<PhoneConnectSection />

			<div class="conn-group">Connect an app</div>
			<!-- Pick your AI app → copy-paste recipe (memory + optional model door). -->
			<HarnessPickerSection />
			<!-- The raw endpoints + auth (bearer / OAuth) the recipes above point to. -->
			<ConnectYourAISection />
			<!-- Consent to auto-capture conversations from the connected agents above
			     (Claude Code / gateway / opencode / openclaw / hermes) into the vault.
			     Default OFF — captures can contain secrets. Home here (not Channels):
			     it governs the CONNECTED agents you just set up, not the in-app chat. -->
			<AgentCaptureSection />

			<div class="conn-group">Reach it over the internet</div>
			<!-- One ordered card (C3 2026-06-25): password → address (managed
			     handle.mycelium.id OR your own domain) → go live. Absorbs what used to
			     be the separate ManagedConnectSection + RemoteAccessSection cards. -->
			<RemoteAccessSection />
			{/if}

			{#if activePane === 'usage'}
			<!-- Token usage transparency — input/output by area/source/provider/model -->
			<UsageSection />
			{/if}

			{#if activePane === 'intelligence'}
			<!-- Engine (harness): native ↔ Claude Code — which engine runs your chat agent -->
			<EngineSelector />

			<!-- The model that powers Mycelium — active-model hero + Local/Cloud lanes -->
			<AISettings />

			<!-- Voice / TTS — provider config + per-voice preview -->
			<VoiceSection />
			{/if}

			{#if activePane === 'channels'}
			<!-- Channels — Telegram + Discord bot token/owner, two-way assistant key, authorized groups -->
			<ChannelsSection />

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

			<!-- AI Access — which vault areas the in-app chat agent may use -->
			<AIAccessSection />
			{/if}

			{#if activePane === 'integrations'}
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

			{/if}

			{#if activePane === 'billing'}
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

			{/if}

			{#if activePane === 'general'}
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

			<!-- Keep the Mac awake while Mycelium runs (so a screen lock doesn't pause
			     background processing). Default ON; macOS-only. -->
			<KeepAwakeSection />

			<!-- Timezone -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Region</h2>
				<div>
					<div class="flex items-center justify-between mb-1">
						<p class="text-sm text-[var(--color-text-primary)]">Timezone</p>
						{#if saved}<span class="text-xs text-jade animate-fade-in">Saved</span>{/if}
					</div>
					<p class="text-xs text-[var(--color-text-tertiary)] mb-3">Used for message timestamps and scheduled events · saves instantly</p>
					<select
						bind:value={settings.timezone}
						onchange={saveSettings}
						disabled={saving}
						class="input w-full text-sm"
					>
						{#each timezones as tz}
							<option value={tz}>{tz.replace(/_/g, ' ')}</option>
						{/each}
					</select>
				</div>
			</section>
			{/if}

			{#if activePane === 'security'}
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
					<div class="flex flex-wrap gap-2 mt-3">
						<button onclick={copyRecoveryKey} class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]">{rkCopied ? 'Copied ✓' : 'Copy'}</button>
						<button onclick={downloadRecoveryKey} class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]">Download</button>
						<button onclick={() => saveRecoveryKey('keychain')} disabled={rkSaving !== null} class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] disabled:opacity-50">{rkSaving === 'keychain' ? 'Saving…' : rkSavedTo === 'keychain' ? 'Saved to Keychain ✓' : 'Save to Keychain'}</button>
						<button onclick={() => saveRecoveryKey('1password')} disabled={rkSaving !== null} class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] disabled:opacity-50">{rkSaving === '1password' ? 'Saving…' : rkSavedTo === '1password' ? 'Saved to 1Password ✓' : 'Save to 1Password'}</button>
						<button onclick={() => { rkRevealed = false; rkValue = ''; rkSavedTo = null; rkSaveError = null; }} class="px-3 py-2 rounded-lg text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">Hide</button>
					</div>
					{#if rkSaveError}
						<p class="mt-2 text-xs text-coral">{rkSaveError}</p>
					{/if}
				{/if}
			</section>

			<!-- Vault Backup (V1) — encrypted .myvault snapshot to user-controlled storage -->
			<section class="card p-5">
				<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Vault Backup</h2>
				<div class="flex items-center justify-between gap-4">
					<div>
						<p class="text-sm text-[var(--color-text-primary)]">Back up your vault</p>
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
							Your recovery key only unlocks data on <strong>this Mac</strong>. Download an
							encrypted backup file and keep it somewhere you control — it's the only way
							to recover your vault if this computer is lost. To restore: on a new device,
							choose “Restore from a backup”, then paste your recovery key.
						</p>
					</div>
					<button
						onclick={backupVault}
						disabled={vbBusy}
						class="px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] whitespace-nowrap disabled:opacity-50"
					>{vbBusy ? 'Preparing…' : 'Back up now'}</button>
				</div>
				{#if vbError}
					<p class="text-xs text-coral mt-2">{vbError}</p>
				{/if}
				{#if vbDone}
					<p class="text-xs text-jade mt-2">Backup downloaded ✓ — store the .myvault file safely.</p>
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

			{/if}

			{#if activePane === 'account'}
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

			{/if}
				</div>
				{/if}
			</div>
		{/if}
	</section>
</div>

<style>
	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.animate-fade-in {
		animation: fade-in 0.2s ease-out;
	}

	/* Connections pane — mental-model intro + group dividers that turn a flat
	   stack of cards into a two-part narrative. */
	.conn-intro {
		padding: 0.9rem 1.1rem;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-surface);
	}
	.conn-intro p {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.6;
		color: var(--color-text-secondary);
	}
	.conn-intro .door {
		color: var(--color-accent-aurum);
		font-weight: 500;
	}
	.conn-intro strong { color: var(--color-text-primary); font-weight: 500; }
	.conn-group {
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
		font-family: var(--font-mono);
		padding: 0.5rem 0.25rem 0;
		margin-top: 0.5rem;
	}

	/* Two-pane hub: a scannable rail + one detail pane (macOS System Settings). */
	.settings-hub {
		display: flex;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	/* ── Left rail ── */
	.rail {
		width: 232px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem;
		background: var(--color-surface);
		border-right: 1px solid var(--color-border);
		overflow-y: auto;
	}
	.rail-id {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem;
		border-radius: 10px;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.rail-id:hover { background: var(--color-elevated); }
	.rail-id-avatar {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: 50%;
		background: rgb(var(--color-accent-aurum-rgb) / 0.18);
		color: var(--color-accent-aurum);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		font-weight: 500;
	}
	.rail-id-name {
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rail-search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.4rem 0.6rem;
		margin: 0.15rem 0 0.35rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
	}
	.rail-search svg { width: 14px; height: 14px; color: var(--color-text-tertiary); flex-shrink: 0; }
	.rail-search-input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		font-size: 0.78rem;
		color: var(--color-text-primary);
	}
	.rail-search-input::placeholder { color: var(--color-text-tertiary); }
	.rail-nav { display: flex; flex-direction: column; gap: 1px; }
	.rail-group {
		font-size: 0.6rem;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
		padding: 0.7rem 0.6rem 0.3rem;
	}
	.rail-item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		text-align: left;
		padding: 0.45rem 0.6rem;
		border-radius: 8px;
		border: none;
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 0.82rem;
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
	}
	.rail-item:hover { background: var(--color-elevated); color: var(--color-text-primary); }
	.rail-item.on {
		background: rgb(var(--color-accent-rgb) / 0.12);
		color: var(--color-text-primary);
		font-weight: 500;
	}
	.rail-ic { display: inline-flex; flex-shrink: 0; }
	.rail-ic :global(svg) { width: 17px; height: 17px; }

	/* ── Detail ── */
	.detail {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.detail-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1.75rem 2rem 3rem;
		max-width: 720px;
		width: 100%;
	}
	.profile-host { flex: 1; min-height: 0; overflow: hidden; }
	.pane-head { margin-bottom: 1.5rem; }
	.pane-title {
		font-size: 1.3rem;
		font-weight: 500;
		color: var(--color-text-emphasis);
		letter-spacing: -0.01em;
		margin: 0;
	}
	.pane-desc {
		font-size: 0.85rem;
		color: var(--color-text-secondary);
		margin: 0.2rem 0 0;
	}
	.mobile-back {
		display: none;
		align-items: center;
		gap: 0.35rem;
		padding: 0.6rem 1rem;
		background: var(--color-surface);
		border: none;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text-secondary);
		font-size: 0.82rem;
		cursor: pointer;
		flex-shrink: 0;
	}
	.mobile-back svg { width: 16px; height: 16px; }

	/* ── Mobile: list → detail drill ── */
	@media (max-width: 767px) {
		.rail { width: 100%; border-right: none; }
		.detail { width: 100%; }
		.detail-body { padding: 1.25rem 1.25rem 3rem; }
		.mobile-back { display: flex; }
		.drilled { display: none; }
	}
</style>
