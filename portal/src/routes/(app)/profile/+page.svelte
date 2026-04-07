<script lang="ts">
	import { browser } from '$app/environment';
	import JSZip from 'jszip';
	import { api, apiGet, apiPost, apiPut, apiPostForm } from '$lib/api';

	interface Profile {
		handle: string | null;
		display_name: string | null;
		signature: string | null;
		depth_score: number;
		breadth_score: number;
		coherence_score: number;
		exploration_score: number;
		territory_count: number;
		realm_count: number;
		message_count: number;
		member_since: string | null;
		public_realms_json: string | null;
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

	interface ImportResult {
		type: string;
		imported: number;
		skipped: number;
		stats?: Record<string, number>;
	}

	interface AIProvider {
		id: string;
		provider: string;
		label: string;
		auth_type: string;
		model_preference: string | null;
		is_active: number;
		status: string;
		last_used_at: string | null;
	}

	let profile = $state<Profile | null>(null);
	let stats = $state<Stats | null>(null);
	let aiProviders = $state<AIProvider[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);

	// Edit state
	let editingHandle = $state(false);
	let handleInput = $state('');
	let handleAvailable = $state<boolean | null>(null);
	let handleChecking = $state(false);
	let handleCheckTimer: ReturnType<typeof setTimeout> | null = null;

	function onHandleInput() {
		handleAvailable = null;
		if (handleCheckTimer) clearTimeout(handleCheckTimer);
		const val = handleInput.trim().toLowerCase();
		if (!val || val.length < 3) return;
		if (val === profile?.handle) { handleAvailable = true; return; }
		handleChecking = true;
		handleCheckTimer = setTimeout(async () => {
			try {
				const res = await api(`/portal/profile/handle/check?handle=${encodeURIComponent(val)}`);
				if (res.ok) {
					const data = await res.json();
					handleAvailable = data.available;
				}
			} catch {}
			handleChecking = false;
		}, 400);
	}
	let editingSignature = $state(false);
	let signatureInput = $state('');
	let recomputing = $state(false);
	let copied = $state(false);

	// Import state
	let importing = $state(false);
	let importSource = $state<string | null>(null);
	let importResult = $state<ImportResult | null>(null);
	let importError = $state<string | null>(null);
	// @ts-ignore — used by dynamic file input

	// Drag state
	let dragging = $state(false);

	$effect(() => {
		if (browser) {
			loadProfile();
			loadStats();
			loadProviders();
		}
	});

	let claudeConnected = $state(false);
	let claudeEmail = $state<string | null>(null);
	let claudeSubscription = $state<string | null>(null);
	let showAddProvider = $state(false);
	let addProviderTab = $state<'claude' | 'api'>('claude');
	let apiSubProvider = $state<'anthropic' | 'openai'>('anthropic');
	let claudeAuthLoading = $state(false);
	let claudeAuthUrl = $state('');
	let claudeAuthCode = $state('');
	let claudeAuthError = $state('');
	let claudeLabelInput = $state('');
	let apiKeyInput = $state('');
	let apiKeySaving = $state(false);
	let apiKeyError = $state('');
	let apiKeySaved = $state(false);

	async function connectClaude() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		claudeAuthUrl = '';
		try {
			const res = await api('/portal/auth/claude', {
				method: 'POST',
				body: JSON.stringify({ label: claudeLabelInput.trim() || undefined }),
			});
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
			claudeConnected = true;
			claudeAuthUrl = '';
			claudeAuthCode = '';
			showAddProvider = false;
			showSuccess('Claude Code connected');
		} catch (e: any) {
			claudeAuthError = e.message || 'Authentication failed';
		}
		claudeAuthLoading = false;
	}

	async function saveApiKey() {
		apiKeySaving = true;
		apiKeyError = '';
		apiKeySaved = false;
		try {
			const provider = apiSubProvider === 'anthropic' ? 'anthropic' : 'openai';
			const res = await apiPost('/portal/providers', {
				provider,
				label: apiSubProvider === 'anthropic' ? 'Anthropic API' : 'OpenAI API',
				auth_type: 'api_key',
				credentials: { api_key: apiKeyInput.trim() },
			});
			apiKeySaved = true;
			apiKeyInput = '';
			showAddProvider = false;
			showSuccess(`${apiSubProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key saved`);
			loadProviders();
			setTimeout(() => { apiKeySaved = false; }, 3000);
		} catch (e: any) {
			apiKeyError = e.message || 'Failed to save key';
		}
		apiKeySaving = false;
	}

	async function disconnectClaude() {
		if (!confirm('Disconnect Claude Code? You\'ll need to re-authenticate to use it again.')) return;
		try {
			const res = await api('/portal/auth/claude/disconnect', { method: 'POST' });
			if (!res.ok) throw new Error('Failed');
			claudeConnected = false;
			claudeEmail = null;
			claudeSubscription = null;
			showSuccess('Claude disconnected');
		} catch {
			error = 'Failed to disconnect';
		}
	}

	async function deleteProvider(id: string) {
		if (!confirm('Remove this API key?')) return;
		try {
			const res = await api(`/portal/providers/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed');
			aiProviders = aiProviders.filter((p: AIProvider) => p.id !== id);
			showSuccess('Provider removed');
		} catch {
			error = 'Failed to remove provider';
		}
	}

	async function loadProviders() {
		try {
			const [provRes, claudeRes] = await Promise.all([
				api('/portal/providers'),
				api('/portal/auth/claude/status'),
			]);
			if (provRes.ok) {
				const data = await provRes.json();
				aiProviders = data.providers || [];
			}
			if (claudeRes.ok) {
				const data = await claudeRes.json();
				claudeConnected = data.authenticated || false;
				claudeEmail = data.email || null;
				claudeSubscription = data.subscriptionType || null;
			}
		} catch {}
	}

	async function loadProfile() {
		try {
			const data = await apiGet<{ profile: Profile }>('/portal/profile');
			profile = data.profile;
		} catch (e) {
			error = 'Failed to load profile';
		} finally {
			loading = false;
		}
	}

	async function loadStats() {
		try {
			const res = await api('/portal/stats');
			if (res.ok) stats = await res.json();
		} catch {}
	}

	async function saveHandle() {
		if (!handleInput.trim()) return;
		saving = true;
		error = null;
		try {
			const data = await apiPut<{ profile: Profile }>('/portal/profile', { handle: handleInput.trim().toLowerCase() });
			profile = data.profile;
			editingHandle = false;
			showSuccess('Handle saved');
		} catch (e: any) {
			error = e.message || 'Failed to save handle';
		} finally {
			saving = false;
		}
	}

	async function saveSignature() {
		saving = true;
		error = null;
		try {
			const data = await apiPut<{ profile: Profile }>('/portal/profile', { signature: signatureInput.trim() });
			profile = data.profile;
			editingSignature = false;
			showSuccess('Signature saved');
		} catch (e: any) {
			error = e.message || 'Failed to save';
		} finally {
			saving = false;
		}
	}

	async function recomputeFingerprint() {
		recomputing = true;
		try {
			await apiPost('/portal/profile/stats/recompute', {});
			await loadProfile();
			showSuccess('Fingerprint recomputed');
		} catch (e: any) {
			error = e.message || 'Failed to recompute';
		} finally {
			recomputing = false;
		}
	}

	async function shareProfile() {
		if (!profile?.handle) return;
		const url = `https://mycelium.id/u/?h=${profile.handle}`;
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => copied = false, 2000);
		} catch {
			// Fallback for non-HTTPS or denied clipboard
			window.prompt('Copy your profile link:', url);
		}
	}

	function showSuccess(msg: string) {
		success = msg;
		setTimeout(() => success = null, 3000);
	}

	function scoreDescriptor(key: string, score: number): string {
		const label = score >= 0.8 ? 'very high' : score >= 0.6 ? 'high' : score >= 0.4 ? 'moderate' : score >= 0.2 ? 'low' : 'minimal';
		const descriptors: Record<string, Record<string, string>> = {
			depth: { 'very high': 'deep-diver', high: 'thorough', moderate: 'balanced', low: 'broad strokes', minimal: 'surface-level' },
			breadth: { 'very high': 'polymathic', high: 'wide-ranging', moderate: 'focused', low: 'specialist', minimal: 'narrow' },
			coherence: { 'very high': 'integrated', high: 'connected', moderate: 'mixed', low: 'scattered', minimal: 'fragmented' },
			exploration: { 'very high': 'explorer', high: 'curious', moderate: 'balanced', low: 'settled', minimal: 'rooted' },
		};
		return descriptors[key]?.[label] || label;
	}

	function formatNumber(n: number): string {
		if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
		return n.toString();
	}

	function formatDate(d: string | null): string {
		if (!d) return '';
		return new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
	}

	const realms = $derived(profile?.public_realms_json ? JSON.parse(profile.public_realms_json) : []);

	// Data streams
	const streams = [
		{ id: 'telegram', name: 'Telegram', desc: 'Live message sync' },
		{ id: 'discord', name: 'Discord', desc: 'Server + DM sync' },
		{ id: 'whatsapp', name: 'WhatsApp', desc: 'Live message sync' },
		{ id: 'portal', name: 'Portal', desc: 'Direct conversations' },
	];

	const nativeApps = [
		{ id: 'ios', name: 'iOS App', desc: 'Voice capture, Apple Health, transcription, encrypted sync' },
		{ id: 'macos', name: 'macOS App', desc: 'Transcription, screen context, clipboard, ambient capture' },
	];

	const integrations = [
		{ id: 'gmail', name: 'Gmail', desc: 'Email sync + search' },
		{ id: 'calendar', name: 'Google Calendar', desc: 'Event awareness' },
		{ id: 'linear', name: 'Linear', desc: 'Issues + project tracking' },
		{ id: 'github', name: 'GitHub', desc: 'Repository activity' },
	];

	// SVG logos for services (inline for no external deps)
	const logos: Record<string, string> = {
		telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
		discord: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>',
		whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492a.5.5 0 0 0 .611.611l4.458-1.495A11.94 11.94 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>',
		portal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h6M9 13h4"/></svg>',
		ios: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83"/><path d="M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11"/></svg>',
		macos: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 13h18v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-1zm5 2h8v1H8v-1z"/></svg>',
		gmail: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>',
		calendar: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-2 .9-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/></svg>',
		linear: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.997 12.73a.993.993 0 0 1-.003-.072C2.994 6.377 7.376 1.994 13.657 1.994c.025 0 .049 0 .073.003l-10.733 10.733zm.712 1.665 12.288-12.288a10.94 10.94 0 0 1 2.92 1.394L5.103 17.315a10.94 10.94 0 0 1-1.394-2.92zm2.296 3.823L18.218 5.905A10.96 10.96 0 0 1 20.094 8.8L8.805 20.088a10.96 10.96 0 0 1-2.8-1.87zm3.834 2.31L21.27 9.097c.19.72.31 1.47.35 2.24L11.6 21.36c-.77-.04-1.52-.16-2.24-.35l-.52.518zm4.89.478 7.768-7.768c-.314 2.87-1.674 5.43-3.718 7.268a10.88 10.88 0 0 1-4.05.5z"/></svg>',
		github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>',
		claude: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
		chatgpt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073z"/></svg>',
		linkedin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
		obsidian: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm5.5 16.5L12 22l-5.5-5.5L12 11l5.5 5.5z"/></svg>',
		mycelium: '<svg viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="232" fill="var(--color-accent-aurum, #E5B84C)"/><g fill="#fff"><path d="M256,512 L768,512 A64,64 0 0 0 832,448 C832,88 192,88 192,448 A64,64 0 0 0 256,512 Z"/><path d="M412,560 L612,560 A32,32 0 0 1 644,592 L672,800 A48,48 0 0 1 624,848 L400,848 A48,48 0 0 1 352,800 L380,592 A32,32 0 0 1 412,560 Z"/></g></svg>',
	};

	function hasHealthData(): boolean {
		return (stats?.messages?.total || 0) > 0; // Rough check — will be refined
	}

	// Import sources with inline help
	const importSources = [
		{ id: 'mycelium', name: 'Mycelium', desc: 'Full vault export (restore)', accept: '.zip',
		  help: 'Export from another vault via Settings > Export All Data. Upload the .zip here.' },
		{ id: 'claude', name: 'Claude', desc: 'Conversations, projects, memories', accept: '.zip,.json',
		  help: 'claude.ai > Settings > Export Data > Confirm. You\'ll get an email with a download link. Upload the .zip here.' },
		{ id: 'chatgpt', name: 'ChatGPT', desc: 'Conversation export', accept: '.zip,.json',
		  help: 'chatgpt.com > Settings > Data Controls > Export data. You\'ll get an email with a .zip. Upload it here.' },
		{ id: 'linkedin', name: 'LinkedIn', desc: 'Connections + messages', accept: '.zip',
		  help: 'LinkedIn > Settings > Data Privacy > Get a copy of your data. Select "Connections" and "Messages". Download the .zip.' },
		{ id: 'obsidian', name: 'Obsidian', desc: 'Markdown vault', accept: '.zip',
		  help: 'Zip your vault folder (the one with .md files). On Mac: right-click the folder > Compress.' },
	];

	let showHelp = $state<string | null>(null);

	function getSourceCount(id: string): number {
		return stats?.messages?.bySource?.[id === 'portal' ? 'portal' : id] || 0;
	}

	function isConnected(id: string): boolean {
		return getSourceCount(id) > 0;
	}

	// File handling
	async function handleFileDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) await uploadFile(file);
	}

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input?.files?.[0];
		if (file) await uploadFile(file);
		// Reset input so same file can be re-selected
		if (input) input.value = '';
	}

	async function uploadFile(file: File) {
		importing = true;
		importError = null;
		importResult = null;

		try {
			// Check if this is a Mycelium vault export (has manifest.json)
			let isVaultExport = false;
			if (file.name.endsWith('.zip') && importSource === 'mycelium') {
				isVaultExport = true;
			} else if (file.name.endsWith('.zip')) {
				// Auto-detect: peek inside for manifest.json
				try {
					const peekZip = await JSZip.loadAsync(await file.arrayBuffer());
					if (peekZip.files['manifest.json']) {
						const manifest = JSON.parse(await peekZip.files['manifest.json'].async('text'));
						if (manifest.format === 'mycelium-vault-export') isVaultExport = true;
					}
				} catch {}
			}

			if (isVaultExport) {
				// Vault restore: re-auth then upload to /portal/import/vault
				const { startAuthentication } = await import('@simplewebauthn/browser');

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

				const formData = new FormData();
				formData.append('file', file);
				formData.append('exportToken', exportToken);

				const res = await fetch('/portal/import/vault', {
					method: 'POST',
					credentials: 'same-origin',
					body: formData,
				});

				if (!res.ok) {
					const err = await res.json().catch(() => ({ error: `Restore failed (${res.status})` }));
					throw new Error(err.error || 'Vault restore failed');
				}

				const data = await res.json();
				const total = Object.values(data.stats || {}).reduce((s: number, v) => s + (typeof v === 'number' ? v : 0), 0);
				importResult = { type: 'mycelium', imported: total as number, skipped: 0, stats: data.stats };
				showSuccess(`Vault restored: ${Object.entries(data.stats).filter(([,v]) => typeof v === 'number' && v > 0).map(([k,v]) => `${v} ${k}`).join(', ')}`);
				loadStats();
				loadProfile();
				return;
			}

			let prepared = file;
			// Strip media from large ZIPs (>90MB) to fit Cloudflare's 100MB limit
			if (file.size > 90_000_000 && file.name.endsWith('.zip')) {
				const buffer = await file.arrayBuffer();
				const zip = await JSZip.loadAsync(buffer);
				const dataFiles = Object.keys(zip.files).filter(n =>
					(n.endsWith('.json') || n.endsWith('.md') || n.endsWith('.csv')) && !zip.files[n].dir
				);
				if (dataFiles.length === 0) throw new Error('No importable data found in ZIP');
				const newZip = new JSZip();
				for (const name of dataFiles) {
					newZip.file(name, await zip.files[name].async('uint8array'));
				}
				const blob = await newZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
				prepared = new File([blob], file.name, { type: 'application/zip' });
			}

			const formData = new FormData();
			formData.append('file', prepared);

			const res = await apiPostForm<{ importResult?: ImportResult }>('/portal/upload', formData);
			if (res.importResult) {
				importResult = res.importResult;
				showSuccess(`Imported ${res.importResult.imported} items`);
				loadStats();
			}
		} catch (e: any) {
			if (e.name === 'NotAllowedError') {
				importError = 'Passkey verification cancelled';
			} else {
				importError = e instanceof Error ? e.message : 'Import failed';
			}
		} finally {
			importing = false;
			importSource = null;
		}
	}

	function triggerImport(sourceId: string) {
		importSource = sourceId;
		const src = importSources.find(s => s.id === sourceId);
		// Create a temporary file input with the right accept
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = src?.accept || '.zip,.json';
		input.onchange = (e) => handleFileSelect(e);
		input.click();
	}
</script>

<svelte:head>
	<title>Profile - Mycelium</title>
</svelte:head>

<div class="profile-page">
	{#if loading}
		<div class="loading">Loading...</div>
	{:else}
		<!-- Profile Card -->
		{#if profile}
			<div class="card">
				<div class="handle-row">
					{#if editingHandle}
						<div class="handle-edit">
							<span class="handle-at">@</span>
							<input type="text" bind:value={handleInput} oninput={onHandleInput} placeholder="yourhandle" class="handle-input" maxlength="30" pattern="[a-z0-9][a-z0-9_]*" />
							<button onclick={saveHandle} disabled={saving || handleAvailable === false} class="btn-sm btn-primary">Save</button>
							<button onclick={() => { editingHandle = false; handleAvailable = null; }} class="btn-sm btn-ghost">Cancel</button>
						</div>
						{#if handleInput.trim().length >= 3}
							<div style="font-size: 0.7rem; margin-top: 0.25rem; margin-left: 1.5rem;">
								{#if handleChecking}
									<span style="color: var(--color-text-tertiary);">Checking...</span>
								{:else if handleAvailable === true}
									<span style="color: #4ade80;">Available</span>
								{:else if handleAvailable === false}
									<span style="color: #f87171;">Not available</span>
								{/if}
							</div>
						{/if}
					{:else}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="handle-display" onclick={() => { editingHandle = true; handleInput = profile?.handle || ''; }}>
							{#if profile.handle}
								<span class="handle-text">@{profile.handle}</span>
							{:else}
								<span class="handle-placeholder">Set your handle</span>
							{/if}
							<span class="edit-icon">&#9998;</span>
						</div>
					{/if}
				</div>

				<div class="stats-row">
					<span>{profile.territory_count} territories</span>
					<span class="dot">&middot;</span>
					<span>{profile.realm_count} realms</span>
					<span class="dot">&middot;</span>
					<span>{profile.message_count.toLocaleString()} messages</span>
					{#if profile.member_since}
						<span class="dot">&middot;</span>
						<span>since {formatDate(profile.member_since)}</span>
					{/if}
				</div>

				<!-- Thinking Style -->
				<div class="fingerprint">
					<h3 class="section-label">Thinking Style</h3>
					{#each [
						{ key: 'depth', label: 'Depth', score: profile.depth_score },
						{ key: 'breadth', label: 'Breadth', score: profile.breadth_score },
						{ key: 'coherence', label: 'Coherence', score: profile.coherence_score },
						{ key: 'exploration', label: 'Exploration', score: profile.exploration_score },
					] as stat}
						<div class="fp-row">
							<span class="fp-label">{stat.label}</span>
							<div class="fp-track"><div class="fp-fill" style="width: {Math.round(stat.score * 100)}%"></div></div>
							<span class="fp-desc">{scoreDescriptor(stat.key, stat.score)}</span>
						</div>
					{/each}
				</div>

				{#if realms.length > 0}
					<div class="realms">
						<h3 class="section-label">Active Realms</h3>
						<div class="realm-tags">{#each realms as realm}<span class="realm-tag">{realm}</span>{/each}</div>
					</div>
				{/if}

				<!-- Signature -->
				<div class="signature-section">
					<h3 class="section-label">Signature</h3>
					{#if editingSignature}
						<div class="sig-edit">
							<input type="text" bind:value={signatureInput} placeholder="One line about how you think" class="sig-input" maxlength="120" />
							<div class="sig-actions">
								<button onclick={saveSignature} disabled={saving} class="btn-sm btn-primary">Save</button>
								<button onclick={() => editingSignature = false} class="btn-sm btn-ghost">Cancel</button>
							</div>
						</div>
					{:else}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="sig-display" onclick={() => { editingSignature = true; signatureInput = profile?.signature || ''; }}>
							{#if profile.signature}
								<span class="sig-text">"{profile.signature}"</span>
							{:else}
								<span class="sig-placeholder">Add a one-line signature</span>
							{/if}
							<span class="edit-icon">&#9998;</span>
						</div>
					{/if}
				</div>

				<!-- Actions -->
				<div class="profile-actions">
					<button class="btn-sm btn-ghost" onclick={recomputeFingerprint} disabled={recomputing}>
						{recomputing ? 'Recomputing...' : 'Recompute fingerprint'}
					</button>
					{#if profile.handle}
						<button class="btn-sm btn-primary" onclick={shareProfile}>
							{copied ? 'Copied!' : 'Share profile'}
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- AI Chats — drop zone -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="card drop-zone"
			class:dragging
			ondragover={(e) => { e.preventDefault(); dragging = true; }}
			ondragleave={() => dragging = false}
			ondrop={handleFileDrop}
		>
			<h3 class="section-label">AI Chats</h3>
			<p class="drop-hint">
				{#if importing}
					<span class="importing-spinner">&#9696;</span> Importing...
				{:else if dragging}
					Drop to import
				{:else}
					Drag a file anywhere to upload — or pick a source below
				{/if}
			</p>
			{#if importResult}
				<p class="import-result">{importResult.imported} items imported</p>
			{/if}
			{#if importError}
				<p class="import-error">{importError}</p>
			{/if}
		</div>

		<!-- Data Overview -->
		{#if stats}
			<div class="card">
				<h3 class="section-label">Data Overview</h3>
				<div class="data-grid">
					<div class="data-cell">
						<span class="data-value">{formatNumber(stats.messages.total)}</span>
						<span class="data-label">messages</span>
					</div>
					<div class="data-cell">
						<span class="data-value">{formatNumber(stats.contacts.total)}</span>
						<span class="data-label">contacts</span>
					</div>
					<div class="data-cell">
						<span class="data-value">{stats.mindscape.territories}</span>
						<span class="data-label">territories</span>
					</div>
					<div class="data-cell">
						<span class="data-value">{stats.documents.total}</span>
						<span class="data-label">documents</span>
					</div>
					<div class="data-cell">
						<span class="data-value">{stats.attachments.total}</span>
						<span class="data-label">attachments</span>
					</div>
					<div class="data-cell">
						<span class="data-value">{formatNumber(stats.messages.last30Days)}</span>
						<span class="data-label">last 30d</span>
					</div>
				</div>
				{#if stats.messages.dateRange.first}
					<p class="date-range">
						{formatDate(stats.messages.dateRange.first)} — {formatDate(stats.messages.dateRange.last)}
					</p>
				{/if}
			</div>
		{/if}

		<!-- AI Subscriptions -->
		<div class="card">
			<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
				<h3 class="section-label" style="margin-bottom: 0;">AI Subscriptions</h3>
				<button class="btn-sm btn-ghost" onclick={() => showAddProvider = !showAddProvider}>
					{showAddProvider ? 'Cancel' : '+ Add'}
				</button>
			</div>
			<div class="source-list">
				<!-- Claude CLI (OAuth) -->
				<div class="source-row">
					<div class="source-icon">{@html logos.claude || ''}</div>
					<div class="source-info">
						<span class="source-name">Claude Code</span>
						<span class="source-desc">{claudeConnected ? (claudeEmail || 'OAuth') : 'Not connected'}{claudeSubscription ? ` · ${claudeSubscription}` : ''}</span>
					</div>
					<div class="source-right">
						{#if claudeConnected}
							<span class="status-dot connected"></span>
							<button class="btn-disconnect" onclick={disconnectClaude} title="Disconnect">&#10005;</button>
						{:else}
							<span class="status-dot"></span>
						{/if}
					</div>
				</div>
				<!-- DB providers (API keys) -->
				{#each aiProviders as p}
					<div class="source-row">
						<div class="source-icon">{@html logos[p.provider] || ''}</div>
						<div class="source-info">
							<span class="source-name">{p.label || p.provider}</span>
							<span class="source-desc">{p.auth_type === 'oauth' ? 'OAuth' : 'API key'}{p.model_preference ? ` · ${p.model_preference}` : ''}</span>
						</div>
						<div class="source-right">
							{#if p.last_used_at}
								<span class="source-count" style="font-size: 0.65rem; color: var(--color-text-tertiary)">{new Date(p.last_used_at).toLocaleDateString()}</span>
							{/if}
							<span class="status-dot" class:connected={p.is_active && p.status !== 'error'} class:error={p.status === 'error'}></span>
							<button class="btn-disconnect" onclick={() => deleteProvider(p.id)} title="Remove">&#10005;</button>
						</div>
					</div>
				{/each}
			</div>

			<!-- Add provider panel -->
			{#if showAddProvider}
				<div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--color-border);">
					<div style="display: flex; gap: 0.25rem; margin-bottom: 0.75rem;">
						<button class="btn-sm" class:btn-primary={addProviderTab === 'claude'} class:btn-ghost={addProviderTab !== 'claude'} onclick={() => addProviderTab = 'claude'}>Claude Code</button>
						<button class="btn-sm" class:btn-primary={addProviderTab === 'api'} class:btn-ghost={addProviderTab !== 'api'} onclick={() => addProviderTab = 'api'}>API Key</button>
					</div>

					{#if addProviderTab === 'claude'}
						{#if claudeConnected}
							<p style="font-size: 0.8rem; color: #4ade80;">Already connected</p>
						{:else if claudeAuthUrl}
							<div style="font-size: 0.78rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">
								<p>1. Sign in on the page that just opened</p>
								<p>2. Copy the code shown after signing in</p>
								<p>3. Paste it below</p>
							</div>
							<div style="display: flex; gap: 0.5rem;">
								<input type="text" bind:value={claudeAuthCode} placeholder="Paste the code here" autocomplete="off" data-1p-ignore class="provider-input" />
								<button class="btn-sm btn-primary" disabled={!claudeAuthCode || claudeAuthLoading} onclick={submitClaudeCode}>
									{claudeAuthLoading ? '...' : 'Connect'}
								</button>
							</div>
							<p style="font-size: 0.65rem; color: var(--color-text-tertiary); margin-top: 0.35rem;">
								Window didn't open? <a href={claudeAuthUrl} target="_blank" rel="noopener" style="color: var(--color-accent-aurum);">Click here</a>
							</p>
						{:else}
							<p style="font-size: 0.78rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">Use your existing Claude subscription. No API key needed.</p>
							<div style="margin-bottom: 0.5rem;">
								<input type="email" bind:value={claudeLabelInput} placeholder="Claude account email (optional)" autocomplete="email" class="provider-input" style="width: 100%;" />
							</div>
							<button class="btn-sm btn-primary" disabled={claudeAuthLoading} onclick={connectClaude}>
								{claudeAuthLoading ? 'Starting...' : 'Connect with Claude'}
							</button>
						{/if}
						{#if claudeAuthError}
							<p style="font-size: 0.75rem; color: #f87171; margin-top: 0.35rem;">{claudeAuthError}</p>
						{/if}
					{:else}
						<div style="display: flex; gap: 0.25rem; margin-bottom: 0.5rem;">
							<button class="btn-sm" class:btn-primary={apiSubProvider === 'anthropic'} class:btn-ghost={apiSubProvider !== 'anthropic'} onclick={() => apiSubProvider = 'anthropic'}>Anthropic</button>
							<button class="btn-sm" class:btn-primary={apiSubProvider === 'openai'} class:btn-ghost={apiSubProvider !== 'openai'} onclick={() => apiSubProvider = 'openai'}>OpenAI</button>
						</div>
						<p style="font-size: 0.75rem; color: var(--color-text-tertiary); margin-bottom: 0.4rem;">
							{apiSubProvider === 'anthropic' ? 'Get key from console.anthropic.com' : 'Get key from platform.openai.com'}
						</p>
						<div style="display: flex; gap: 0.5rem;">
							<input type="password" bind:value={apiKeyInput} placeholder={apiSubProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...'} autocomplete="off" data-1p-ignore class="provider-input" />
							<button class="btn-sm btn-primary" disabled={!apiKeyInput || apiKeySaving} onclick={saveApiKey}>
								{apiKeySaving ? '...' : 'Save'}
							</button>
						</div>
						{#if apiKeyError}
							<p style="font-size: 0.75rem; color: #f87171; margin-top: 0.35rem;">{apiKeyError}</p>
						{/if}
						{#if apiKeySaved}
							<p style="font-size: 0.75rem; color: #4ade80; margin-top: 0.35rem;">Saved</p>
						{/if}
					{/if}
				</div>
			{/if}
		</div>

		<!-- Data Streams (live connections) -->
		<div class="card">
			<h3 class="section-label">Data Streams</h3>
			<div class="source-list">
				{#each streams as stream}
					<div class="source-row">
						<div class="source-icon">{@html logos[stream.id] || ''}</div>
						<div class="source-info">
							<span class="source-name">{stream.name}</span>
							<span class="source-desc">{stream.desc}</span>
						</div>
						<div class="source-right">
							{#if isConnected(stream.id)}
								<span class="source-count">{formatNumber(getSourceCount(stream.id))}</span>
								<span class="status-dot connected"></span>
							{:else}
								<span class="status-dot"></span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Native Apps -->
		<div class="card">
			<h3 class="section-label">Native Apps</h3>
			<div class="source-list">
				{#each nativeApps as app}
					<div class="source-row">
						<div class="source-icon">{@html logos[app.id] || ''}</div>
						<div class="source-info">
							<span class="source-name">{app.name}</span>
							<span class="source-desc">{app.desc}</span>
						</div>
						<div class="source-right">
							{#if app.id === 'health' && stats?.mindscape?.territories}
								<span class="status-dot connected"></span>
							{:else if app.link}
								<a href={app.link} target="_blank" rel="noopener" class="btn-sm btn-ghost" style="font-size: 0.65rem; padding: 0.2rem 0.5rem;">Get</a>
							{:else}
								<span class="status-dot"></span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Integrations -->
		<div class="card">
			<h3 class="section-label">Integrations</h3>
			<div class="source-list">
				{#each integrations as int}
					<div class="source-row">
						<div class="source-icon">{@html logos[int.id] || ''}</div>
						<div class="source-info">
							<span class="source-name">{int.name}</span>
							<span class="source-desc">{int.desc}</span>
						</div>
						<div class="source-right">
							<span class="status-dot"></span>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Historic Imports -->
		<div class="card">
			<h3 class="section-label">Historic Imports</h3>
			<div class="source-list">
				{#each importSources as src}
					<div class="source-row">
						<div class="source-icon">{@html logos[src.id] || ''}</div>
						<div class="source-info">
							<div class="source-name-row">
								<span class="source-name">{src.name}</span>
								<button class="help-toggle" onclick={() => showHelp = showHelp === src.id ? null : src.id} title="How to export">?</button>
							</div>
							<span class="source-desc">{src.desc}</span>
							{#if showHelp === src.id}
								<p class="source-help">{src.help}</p>
							{/if}
						</div>
						<div class="source-right">
							{#if stats?.messages?.bySource?.imported && src.id === 'linkedin'}
								<span class="source-count">{formatNumber(stats.messages.bySource.imported)}</span>
							{/if}
							<button
								class="btn-sm btn-ghost"
								disabled={importing}
								onclick={() => triggerImport(src.id)}
							>
								{importing && importSource === src.id ? 'Importing...' : 'Import'}
							</button>
						</div>
					</div>
				{/each}
			</div>
		</div>

		{#if error}
			<div class="toast error">{error}</div>
		{/if}
		{#if success}
			<div class="toast success">{success}</div>
		{/if}
	{/if}
</div>

<style>
	.profile-page {
		padding: 2rem;
		max-width: 560px;
		margin: 0 auto;
		height: 100%;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.loading {
		text-align: center;
		padding: 4rem 2rem;
		color: var(--color-text-tertiary);
		font-size: 0.85rem;
	}

	.card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 12px;
		padding: 1.5rem;
	}

	.section-label {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-accent-aurum);
		margin-bottom: 0.75rem;
	}

	/* Handle */
	.handle-row { margin-bottom: 1rem; }
	.handle-display {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
	.handle-text {
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--color-text-emphasis);
		letter-spacing: -0.02em;
	}
	.handle-placeholder { font-size: 1rem; color: var(--color-text-tertiary); }
	.edit-icon {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		opacity: 0;
		transition: opacity 0.15s;
	}
	.handle-display:hover .edit-icon,
	.sig-display:hover .edit-icon { opacity: 1; }
	.handle-edit { display: flex; align-items: center; gap: 0.5rem; }
	.handle-at { font-size: 1.2rem; color: var(--color-text-tertiary); font-weight: 500; }
	.handle-input, .sig-input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.85rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		outline: none;
	}
	.handle-input:focus, .sig-input:focus { border-color: var(--color-accent-aurum); }

	/* Stats row */
	.stats-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 1.5rem;
		font-size: 0.8rem;
		color: var(--color-text-secondary);
	}
	.dot { color: var(--color-text-tertiary); }

	/* Fingerprint */
	.fingerprint { margin-bottom: 1.5rem; }
	.fp-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
	.fp-label { width: 80px; font-size: 0.78rem; color: var(--color-text-secondary); }
	.fp-track { flex: 1; height: 6px; background: var(--color-elevated); border-radius: 3px; overflow: hidden; }
	.fp-fill { height: 100%; background: var(--color-accent-aurum); border-radius: 3px; transition: width 0.6s ease; }
	.fp-desc { width: 90px; font-size: 0.72rem; color: var(--color-text-tertiary); text-align: right; font-family: var(--font-mono); }

	/* Realms */
	.realms { margin-bottom: 1.5rem; }
	.realm-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.realm-tag {
		font-size: 0.72rem;
		padding: 0.25rem 0.6rem;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-secondary);
	}

	/* Signature */
	.signature-section { margin-bottom: 0; }
	.sig-display {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
	.sig-text { font-size: 0.9rem; color: var(--color-text-secondary); line-height: 1.5; }
	.sig-placeholder { font-size: 0.85rem; color: var(--color-text-tertiary); }
	.sig-edit { display: flex; flex-direction: column; gap: 0.5rem; }
	.sig-input { font-family: var(--font-sans); }
	.sig-actions { display: flex; gap: 0.5rem; }

	/* Profile actions */
	.profile-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	/* Drop zone */
	.drop-zone {
		border-style: dashed;
		text-align: center;
		transition: border-color 0.2s, background 0.2s;
		cursor: default;
	}
	.drop-zone.dragging {
		border-color: var(--color-accent-aurum);
		background: var(--color-accent-aurum, #E5B84C)08;
	}
	.drop-hint {
		font-size: 0.8rem;
		color: var(--color-text-tertiary);
	}
	.importing-spinner {
		display: inline-block;
		animation: spin 1s linear infinite;
	}
	@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
	.import-result { font-size: 0.78rem; color: #4ade80; margin-top: 0.5rem; }
	.import-error { font-size: 0.78rem; color: #f87171; margin-top: 0.5rem; }

	/* Data grid */
	.data-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
	}
	.data-cell { text-align: center; }
	.data-value {
		display: block;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-text-emphasis);
		letter-spacing: -0.02em;
	}
	.data-label {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.date-range {
		text-align: center;
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		margin-top: 0.75rem;
		font-family: var(--font-mono);
	}

	/* Source list */
	.source-list { display: flex; flex-direction: column; gap: 0; }
	.source-row {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.6rem 0;
		border-bottom: 1px solid var(--color-border);
	}
	.source-row:last-child { border-bottom: none; }
	.source-info { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }
	.source-name-row { display: flex; align-items: center; gap: 0.4rem; }
	.source-name { font-size: 0.85rem; color: var(--color-text-primary); font-weight: 500; }
	.help-toggle {
		width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--color-border);
		background: transparent; color: var(--color-text-tertiary); font-size: 0.6rem; font-weight: 600;
		cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
		transition: border-color 0.15s;
	}
	.help-toggle:hover { border-color: var(--color-text-secondary); color: var(--color-text-secondary); }
	.source-desc { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.source-help { font-size: 0.7rem; color: var(--color-text-secondary); margin-top: 0.35rem; line-height: 1.5; }
	.source-right { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
	.source-count { font-size: 0.78rem; color: var(--color-text-secondary); font-family: var(--font-mono); }
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-border);
	}
	.status-dot.connected { background: #4ade80; }

	/* Buttons */
	.btn-sm {
		padding: 0.35rem 0.75rem;
		font-size: 0.75rem;
		font-family: var(--font-sans);
		border-radius: 6px;
		cursor: pointer;
		border: none;
		transition: all 0.15s;
	}
	.btn-primary {
		background: var(--color-accent-aurum);
		color: var(--color-bg);
		font-weight: 500;
	}
	.btn-primary:hover { opacity: 0.9; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		background: transparent;
		color: var(--color-text-tertiary);
		border: 1px solid var(--color-border);
	}
	.btn-ghost:hover { color: var(--color-text-secondary); border-color: var(--color-text-tertiary); }

	.source-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: var(--color-text-tertiary);
		opacity: 0.7;
	}
	.source-icon :global(svg) {
		width: 100%;
		height: 100%;
	}

	.btn-disconnect {
		background: none;
		border: none;
		color: var(--color-text-tertiary);
		cursor: pointer;
		font-size: 0.7rem;
		padding: 2px 4px;
		border-radius: 4px;
		opacity: 0;
		transition: opacity 0.15s, color 0.15s;
	}
	.source-row:hover .btn-disconnect { opacity: 1; }
	.btn-disconnect:hover { color: #f87171; }

	.provider-input {
		flex: 1;
		padding: 0.4rem 0.6rem;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		outline: none;
	}
	.provider-input:focus { border-color: var(--color-accent-aurum); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }

	/* Toast */
	.toast {
		position: fixed;
		bottom: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.5rem 1.25rem;
		border-radius: 8px;
		font-size: 0.78rem;
		z-index: 100;
		animation: fadeUp 0.3s ease;
	}
	.toast.error {
		background: rgba(248, 113, 113, 0.15);
		border: 1px solid rgba(248, 113, 113, 0.3);
		color: #f87171;
	}
	.toast.success {
		background: rgba(74, 222, 128, 0.15);
		border: 1px solid rgba(74, 222, 128, 0.3);
		color: #4ade80;
	}
	@keyframes fadeUp {
		from { opacity: 0; transform: translateX(-50%) translateY(8px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}
</style>
