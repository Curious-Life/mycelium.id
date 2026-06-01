<!--
	Voice / Speech (TTS) settings section.

	Fetches GET /portal/settings/tts on mount. Saves to PUT /portal/settings/tts.
	Plays voice previews via POST /portal/settings/tts/preview (rate-limited
	server-side, 5/min/session).

	Visual style mirrors the Linear / Providers cards in +page.svelte — same
	`card p-5` wrapper, same heading pattern, same input/button utilities.

	State surface is intentionally local (per-component): no stores, no
	cross-page side effects. The settings page just needs to mount this once.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type VoiceCatalog = { id: string; label: string; description: string };
	type ModelCatalog = { id: string; label: string; description: string };
	type TtsState = {
		enabled: boolean;
		provider: string | null;
		openai: { hasKey: boolean; voice: string; model: string; voices: VoiceCatalog[]; models: ModelCatalog[] };
		elevenlabs: { hasKey: boolean; voiceId: string | null; model: string; models: ModelCatalog[] };
	};

	let state = $state<TtsState | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Form state — separate from `state` so unsaved edits don't pollute the
	// canonical view. `Save` flushes form → server → state.
	let formProvider = $state<'openai' | 'elevenlabs' | ''>('');
	let formOpenaiKey = $state('');
	let formOpenaiVoice = $state('onyx');
	let formOpenaiModel = $state('tts-1-hd');
	let formElevenKey = $state('');
	let formElevenVoiceId = $state('');
	let formElevenModel = $state('eleven_turbo_v2_5');

	// Preview playback state.
	let previewLoadingId = $state<string | null>(null);
	let previewError = $state<string | null>(null);
	let previewAudio: HTMLAudioElement | null = null;

	async function loadState() {
		loading = true;
		error = null;
		try {
			const res = await api('/portal/settings/tts');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			state = (await res.json()) as TtsState;
			formProvider = (state.provider as 'openai' | 'elevenlabs' | '' | null) ?? '';
			formOpenaiVoice = state.openai.voice;
			formOpenaiModel = state.openai.model;
			formElevenVoiceId = state.elevenlabs.voiceId ?? '';
			formElevenModel = state.elevenlabs.model;
		} catch (e: any) {
			error = e?.message || 'Failed to load voice settings';
		} finally {
			loading = false;
		}
	}

	onMount(loadState);

	async function save() {
		if (!state) return;
		saving = true;
		error = null;
		try {
			const body: Record<string, unknown> = { provider: formProvider };
			const openai: Record<string, string> = {};
			if (formOpenaiKey.trim().length > 0) openai.apiKey = formOpenaiKey.trim();
			if (formOpenaiVoice !== state.openai.voice) openai.voice = formOpenaiVoice;
			if (formOpenaiModel !== state.openai.model) openai.model = formOpenaiModel;
			if (Object.keys(openai).length > 0) body.openai = openai;

			const elevenlabs: Record<string, string> = {};
			if (formElevenKey.trim().length > 0) elevenlabs.apiKey = formElevenKey.trim();
			if (formElevenVoiceId.trim() !== (state.elevenlabs.voiceId ?? '')) {
				elevenlabs.voiceId = formElevenVoiceId.trim();
			}
			if (formElevenModel !== state.elevenlabs.model) elevenlabs.model = formElevenModel;
			if (Object.keys(elevenlabs).length > 0) body.elevenlabs = elevenlabs;

			const res = await api('/portal/settings/tts', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json?.error || 'Save failed');

			// Wipe pasted keys from form (don't keep plaintext in memory unnecessarily)
			formOpenaiKey = '';
			formElevenKey = '';
			await loadState();
		} catch (e: any) {
			error = e?.message || 'Save failed';
		} finally {
			saving = false;
		}
	}

	async function preview(voiceId: string) {
		previewError = null;
		previewLoadingId = voiceId;
		try {
			const res = await api('/portal/settings/tts/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ voice: voiceId }),
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) {
				if (res.status === 429) throw new Error(`Slow down — wait ${json.retryInSec}s`);
				if (res.status === 503) throw new Error('Save provider + key first');
				if (res.status === 502 && json.code === 'auth') throw new Error('Invalid API key — re-enter and save');
				throw new Error(json?.error || `Preview failed (${res.status})`);
			}
			// Stop any previous playback
			if (previewAudio) {
				previewAudio.pause();
				previewAudio = null;
			}
			const dataUrl = `data:${json.mime || 'audio/ogg'};base64,${json.audio}`;
			previewAudio = new Audio(dataUrl);
			await previewAudio.play().catch(() => {});
		} catch (e: any) {
			previewError = e?.message || 'Preview failed';
		} finally {
			previewLoadingId = null;
		}
	}
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">
		Voice
	</h2>

	{#if loading}
		<div class="text-[0.7rem] text-[var(--color-text-tertiary)]">Loading…</div>
	{:else if !state}
		<div class="text-[0.7rem] text-red-400">{error || 'Failed to load'}</div>
	{:else}
		<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-4">
			Mya can reply with synthesized voice in Telegram. Pick a provider and paste your own API key —
			the key stays encrypted on this VPS, never leaves it.
		</p>

		{#if error}
			<div class="text-xs text-red-400 mb-3 p-2 rounded bg-red-500/10">{error}</div>
		{/if}

		<!-- Provider picker -->
		<div class="mb-5">
			<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Provider</label>
			<div class="flex gap-4">
				{#each [
					{ id: '',           label: 'Off' },
					{ id: 'openai',     label: 'OpenAI' },
					{ id: 'elevenlabs', label: 'ElevenLabs' },
				] as opt (opt.id)}
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="radio" bind:group={formProvider} value={opt.id} class="accent-[var(--color-accent)]" />
						<span class="text-sm text-[var(--color-text-primary)]">{opt.label}</span>
					</label>
				{/each}
			</div>
		</div>

		<!-- OpenAI block -->
		{#if formProvider === 'openai'}
			<div class="mb-5 space-y-4">
				<div>
					<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
						OpenAI API key
						{#if state.openai.hasKey}
							<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>
						{/if}
					</label>
					<input
						type="password"
						bind:value={formOpenaiKey}
						placeholder={state.openai.hasKey ? '••••••••• (leave blank to keep)' : 'sk-…'}
						autocomplete="off"
						data-1p-ignore
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				<div>
					<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Voice</label>
					<div class="space-y-1.5">
						{#each state.openai.voices as v (v.id)}
							<label class="flex items-center gap-3 p-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/50 cursor-pointer transition-colors"
								style:border-color={formOpenaiVoice === v.id ? 'var(--color-accent)' : ''}>
								<input type="radio" bind:group={formOpenaiVoice} value={v.id} class="accent-[var(--color-accent)]" />
								<div class="flex-1 min-w-0">
									<div class="text-sm text-[var(--color-text-primary)]">{v.label}</div>
									<div class="text-[0.62rem] text-[var(--color-text-tertiary)]">{v.description}</div>
								</div>
								{#if state.openai.hasKey && state.provider === 'openai'}
									<button
										type="button"
										onclick={(e) => { e.preventDefault(); preview(v.id); }}
										disabled={previewLoadingId !== null}
										title="Preview this voice"
										class="text-[0.65rem] px-2 py-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] disabled:opacity-40 cursor-pointer"
									>
										{previewLoadingId === v.id ? '…' : '▶'}
									</button>
								{/if}
							</label>
						{/each}
					</div>
				</div>

				<div>
					<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Model</label>
					<select
						bind:value={formOpenaiModel}
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					>
						{#each state.openai.models as m (m.id)}
							<option value={m.id}>{m.label} — {m.description}</option>
						{/each}
					</select>
				</div>
			</div>
		{/if}

		<!-- ElevenLabs block -->
		{#if formProvider === 'elevenlabs'}
			<div class="mb-5 space-y-4">
				<div>
					<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
						ElevenLabs API key
						{#if state.elevenlabs.hasKey}
							<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>
						{/if}
					</label>
					<input
						type="password"
						bind:value={formElevenKey}
						placeholder={state.elevenlabs.hasKey ? '••••••••• (leave blank to keep)' : 'paste your ElevenLabs API key'}
						autocomplete="off"
						data-1p-ignore
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				<div>
					<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
						Voice ID
						<a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener" class="ml-2 text-[0.62rem] text-[var(--color-accent)] hover:underline">find yours →</a>
					</label>
					<input
						type="text"
						bind:value={formElevenVoiceId}
						placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
						autocomplete="off"
						data-1p-ignore
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				<div>
					<label class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Model</label>
					<select
						bind:value={formElevenModel}
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					>
						{#each state.elevenlabs.models as m (m.id)}
							<option value={m.id}>{m.label} — {m.description}</option>
						{/each}
					</select>
				</div>

				{#if state.elevenlabs.hasKey && state.provider === 'elevenlabs' && state.elevenlabs.voiceId}
					<div>
						<button
							type="button"
							onclick={(e) => { e.preventDefault(); preview(state!.elevenlabs.voiceId!); }}
							disabled={previewLoadingId !== null}
							class="text-[0.7rem] px-3 py-1.5 border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] hover:border-[var(--color-accent)] disabled:opacity-40 cursor-pointer"
						>
							{previewLoadingId ? 'Synthesizing…' : '▶ Preview saved voice'}
						</button>
					</div>
				{/if}
			</div>
		{/if}

		{#if previewError}
			<div class="text-[0.7rem] text-red-400 mb-3">{previewError}</div>
		{/if}

		<div class="flex items-center gap-3">
			<button
				onclick={save}
				disabled={saving}
				class="px-4 py-1.5 text-sm font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer"
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
			<span class="text-[0.62rem] text-[var(--color-text-tertiary)]">
				{#if state.enabled}
					TTS active — provider: <span class="text-[var(--color-accent)]">{state.provider}</span>
				{:else}
					TTS not active — pick a provider and add an API key
				{/if}
			</span>
		</div>
	{/if}
</section>
