<!--
	Version / About section (Settings → General).

	Shows the running app version and — in the desktop (Tauri) app only — a manual
	"Check for updates" control that wraps the SAME signature-verified updater the
	background auto-updater uses (Rust commands check_for_update / install_update in
	src-tauri/src/main.rs). check_for_update bypasses the 6h throttle (the user asked)
	but stays production-only + real-pubkey-gated + minisign-verified; install_update
	downloads the verified update and relaunches. In the web build (:8787, no Tauri
	IPC) there is nothing to update, so only the version is shown — no update controls,
	and `invoke` is never called where it does not exist.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	type UpdateState = 'uptodate' | 'available' | 'unsupported' | 'error';
	type UpdateStatus = { state: UpdateState; version?: string; notes?: string; error?: string };

	// Build-time version (baked by vite ← root package.json). The web build's only
	// source, and the Tauri fallback until the runtime version resolves.
	let version = $state<string>(__APP_VERSION__);
	let isTauri = $state(false);
	let checking = $state(false);
	let installing = $state(false);
	let status = $state<UpdateStatus | null>(null);

	// Raw invoke — the webview is a remote origin with no bundled @tauri-apps/api, so we
	// reach the IPC directly (same pattern as Sidebar/DataSection). null in the browser.
	function tauriInvoke(): ((cmd: string) => Promise<unknown>) | null {
		if (!browser) return null;
		const inv = (window as any).__TAURI_INTERNALS__?.invoke;
		return typeof inv === 'function' ? inv : null;
	}

	onMount(async () => {
		const invoke = tauriInvoke();
		isTauri = !!invoke;
		if (!invoke) return;
		// Prefer the runtime version (accurate to the installed binary).
		try {
			const v = await invoke('app_version');
			if (typeof v === 'string' && v) version = v;
		} catch {
			/* keep the build-time fallback */
		}
	});

	async function checkForUpdate() {
		const invoke = tauriInvoke();
		if (!invoke || checking || installing) return;
		checking = true;
		status = null;
		try {
			const s = (await invoke('check_for_update')) as UpdateStatus;
			status = s && typeof s.state === 'string' ? s : { state: 'error', error: 'unexpected response' };
		} catch (e: any) {
			status = { state: 'error', error: e?.message || 'check failed' };
		} finally {
			checking = false;
		}
	}

	async function installUpdate() {
		const invoke = tauriInvoke();
		if (!invoke || installing) return;
		installing = true;
		// install_update downloads + verifies the signature + relaunches on success; on
		// failure it throws and we re-enable the button.
		try {
			await invoke('install_update');
		} catch {
			installing = false;
		}
	}
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">About</h2>
	<div class="flex items-center justify-between gap-3">
		<div>
			<p class="text-sm text-[var(--color-text-primary)]">Mycelium</p>
			<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">Version {version}</p>
		</div>
		{#if isTauri}
			<button
				onclick={checkForUpdate}
				disabled={checking || installing}
				aria-label="Check for updates"
				class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)] disabled:opacity-50 whitespace-nowrap"
			>
				{checking ? 'Checking…' : 'Check for updates'}
			</button>
		{/if}
	</div>

	{#if isTauri && status}
		<div class="mt-4">
			{#if status.state === 'uptodate'}
				<p class="text-sm text-jade">You're on the latest version.</p>
			{:else if status.state === 'available'}
				<div class="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-3">
					<p class="text-sm font-medium text-[var(--color-text-primary)]">Update available: v{status.version}</p>
					{#if status.notes}
						<p class="mt-1 text-xs text-[var(--color-text-secondary)] whitespace-pre-line">{status.notes}</p>
					{/if}
					<button
						onclick={installUpdate}
						disabled={installing}
						aria-label="Download and install update"
						class="mt-3 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
					>
						{installing ? 'Downloading…' : 'Download & install'}
					</button>
					{#if installing}
						<p class="mt-2 text-xs text-[var(--color-text-tertiary)]">The app will restart once the update is installed.</p>
					{/if}
				</div>
			{:else if status.state === 'unsupported'}
				<p class="text-sm text-[var(--color-text-secondary)]">Updates are delivered automatically to release builds.</p>
			{:else}
				<p class="text-sm text-coral">Couldn't check for updates{status.error ? ` — ${status.error}` : ''}. Please try again.</p>
			{/if}
		</div>
	{/if}
</section>
