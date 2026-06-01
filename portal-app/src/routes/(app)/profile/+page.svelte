<script lang="ts">
	import { browser } from '$app/environment';
	import { api, apiGet, apiPut } from '$lib/api';

	interface Profile {
		handle: string | null;
		display_name: string | null;
		avatar_url: string | null;
		exlibris_url: string | null;
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


	let profile = $state<Profile | null>(null);
	let stats = $state<Stats | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);

	// Edit state
	// Avatar
	let uploadingAvatar = $state(false);
	let uploadingExlibris = $state(false);

	async function uploadAvatar(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (file.size > 5 * 1024 * 1024) { showError('Image too large (max 5MB)'); return; }
		if (!file.type.startsWith('image/')) { showError('Please select an image'); return; }

		uploadingAvatar = true;
		try {
			const reader = new FileReader();
			const base64 = await new Promise<string>((resolve, reject) => {
				reader.onload = () => {
					const result = reader.result as string;
					resolve(result.split(',')[1]); // strip data:image/...;base64,
				};
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});

			const res = await api('/portal/avatar', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: base64 }),
			});
			if (res.ok) {
				const data = await res.json();
				if (profile) profile.avatar_url = data.avatarUrl + '?t=' + Date.now();
				showSuccess('Avatar updated');
			} else {
				showError('Upload failed');
			}
		} catch {
			showError('Upload failed');
		} finally {
			uploadingAvatar = false;
			input.value = '';
		}
	}

	async function uploadExlibris(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (file.size > 5 * 1024 * 1024) { showError('Image too large (max 5MB)'); return; }
		if (!file.type.startsWith('image/')) { showError('Please select an image'); return; }

		uploadingExlibris = true;
		try {
			const reader = new FileReader();
			const base64 = await new Promise<string>((resolve, reject) => {
				reader.onload = () => {
					const result = reader.result as string;
					resolve(result.split(',')[1]);
				};
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});

			const res = await api('/portal/exlibris', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: base64 }),
			});
			if (res.ok) {
				const data = await res.json();
				if (profile) profile.exlibris_url = data.exlibrisUrl + '?t=' + Date.now();
				showSuccess('Ex libris updated');
			} else {
				showError('Upload failed');
			}
		} catch {
			showError('Upload failed');
		} finally {
			uploadingExlibris = false;
			input.value = '';
		}
	}

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


	$effect(() => {
		if (browser) {
			loadProfile();
			loadStats();
		}
	});


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

	function showError(msg: string) {
		error = msg;
		setTimeout(() => error = null, 5000);
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
				<!-- Avatar -->
				<div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem;">
					<label style="cursor: pointer; position: relative; flex-shrink: 0;">
						{#if profile.avatar_url}
							<img src={profile.avatar_url} alt="Avatar" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid var(--color-border);" />
						{:else}
							<div style="width: 56px; height: 56px; border-radius: 50%; background: var(--color-elevated); border: 2px dashed var(--color-border); display: flex; align-items: center; justify-content: center;">
								<svg style="width: 20px; height: 20px; color: var(--color-text-tertiary);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
							</div>
						{/if}
						{#if uploadingAvatar}
							<div style="position: absolute; inset: 0; border-radius: 50%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;">
								<div style="width: 16px; height: 16px; border: 2px solid var(--color-border); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
							</div>
						{/if}
						<input type="file" accept="image/*" onchange={uploadAvatar} style="display: none;" />
					</label>
					<div>
						<p style="font-size: 0.82rem; font-weight: 500; color: var(--color-text-primary);">{profile.display_name || 'User'}</p>
						<p style="font-size: 0.65rem; color: var(--color-text-tertiary);">Click photo to change</p>
					</div>
				</div>

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

				<!-- Ex Libris -->
				<div style="margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--color-border);">
					<p style="font-size: 0.65rem; font-weight: 500; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.75rem;">Ex Libris</p>
					<label style="cursor: pointer; display: inline-block; position: relative;">
						{#if profile.exlibris_url}
							<img src={profile.exlibris_url} alt="Ex Libris" style="width: 120px; height: 120px; border-radius: 8px; object-fit: cover; border: 1px solid var(--color-border);" />
						{:else}
							<div style="width: 120px; height: 120px; border-radius: 8px; background: var(--color-elevated); border: 2px dashed var(--color-border); display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 0.25rem;">
								<svg style="width: 24px; height: 24px; color: var(--color-text-tertiary);" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
								<span style="font-size: 0.6rem; color: var(--color-text-tertiary);">Upload seal</span>
							</div>
						{/if}
						{#if uploadingExlibris}
							<div style="position: absolute; inset: 0; border-radius: 8px; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;">
								<div style="width: 16px; height: 16px; border: 2px solid var(--color-border); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
							</div>
						{/if}
						<input type="file" accept="image/*" onchange={uploadExlibris} style="display: none;" />
					</label>
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
