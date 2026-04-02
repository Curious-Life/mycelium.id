<script lang="ts">
	import { onMount } from 'svelte';
	import { theme } from '$lib/stores/theme';
	import { auth } from '$lib/stores/auth';
	import { api } from '$lib/api';

	interface Settings {
		timezone: string;
	}

	let settings = $state<Settings>({ timezone: 'UTC' });
	let loading = $state(true);
	let saving = $state(false);
	let saved = $state(false);
	let exporting = $state(false);
	let exportError = $state<string | null>(null);

	const timezones = [
		'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
		'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
		'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney',
	];

	onMount(async () => {
		try {
			const res = await api('/portal/settings');
			if (res.ok) {
				const data = await res.json();
				settings = data.settings || settings;
			}
		} catch {}
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

	async function handleExport() {
		exporting = true;
		exportError = null;
		try {
			const res = await api('/portal/export');
			if (!res.ok) throw new Error(`Export failed (${res.status})`);
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `mycelium-export-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exporting = false;
		}
	}

	async function handleLogout() {
		await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
		auth.logout();
		window.location.href = '/login';
	}
</script>

<svelte:head>
	<title>Settings - Mycelium</title>
</svelte:head>

<div class="max-w-2xl mx-auto px-8 py-8">
	<h1 class="text-xl font-medium text-[var(--color-text-emphasis)] mb-2">Settings</h1>
	<p class="text-sm text-[var(--color-text-secondary)] mb-8">Configure your Mycelium instance</p>

	{#if loading}
		<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading...</div>
	{:else}
		<div class="space-y-6">
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
						<p class="text-xs text-[var(--color-text-tertiary)] mt-0.5">Download all your messages, documents, and folders as JSON</p>
					</div>
					<button
						onclick={handleExport}
						disabled={exporting}
						class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-sm text-[var(--color-text-primary)]"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
						</svg>
						{exporting ? 'Exporting...' : 'Download'}
					</button>
				</div>
				{#if exportError}
					<p class="text-xs text-coral mt-2">{exportError}</p>
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

<style>
	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.animate-fade-in {
		animation: fade-in 0.2s ease-out;
	}
</style>
