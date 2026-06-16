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
	type KokoroModel = { phase: 'absent' | 'installing' | 'downloading' | 'ready' | 'error'; progress: number; error: string | null; sizeMB: number };
	type TtsState = {
		enabled: boolean;
		provider: string | null;
		kokoro: { enabled: boolean; voice: string; voices: VoiceCatalog[]; model: KokoroModel };
		openai: { hasKey: boolean; voice: string; model: string; voices: VoiceCatalog[]; models: ModelCatalog[] };
		elevenlabs: { hasKey: boolean; voiceId: string | null; model: string; models: ModelCatalog[] };
	};

	let tts = $state<TtsState | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Kokoro local-model download state (polled while provisioning).
	let kModel = $state<KokoroModel | null>(null);
	let downloading = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// Form fields — separate from the canonical `tts` so unsaved edits don't
	// pollute the canonical view. `Save` flushes form → server → tts.
	let formProvider = $state<'kokoro' | 'openai' | 'elevenlabs' | ''>('');
	let formKokoroVoice = $state('af_heart');
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
			tts = (await res.json()) as TtsState;
			formProvider = (tts.provider as 'kokoro' | 'openai' | 'elevenlabs' | '' | null) ?? '';
			formKokoroVoice = tts.kokoro?.voice ?? 'af_heart';
			kModel = tts.kokoro?.model ?? null;
			if (kModel && (kModel.phase === 'downloading' || kModel.phase === 'installing')) startPolling();
			formOpenaiVoice = tts.openai.voice;
			formOpenaiModel = tts.openai.model;
			formElevenVoiceId = tts.elevenlabs.voiceId ?? '';
			formElevenModel = tts.elevenlabs.model;
		} catch (e: any) {
			error = e?.message || 'Failed to load voice settings';
		} finally {
			loading = false;
		}
	}

	onMount(loadState);
	$effect(() => () => { if (pollTimer) clearInterval(pollTimer); });

	function startPolling() {
		if (pollTimer) return;
		pollTimer = setInterval(async () => {
			try {
				const res = await api('/portal/settings/tts/kokoro/model');
				if (res.ok) {
					kModel = (await res.json()) as KokoroModel;
					if (kModel.phase === 'ready' || kModel.phase === 'error' || kModel.phase === 'absent') {
						if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
						downloading = false;
					}
				}
			} catch { /* keep polling */ }
		}, 1500);
	}

	async function downloadModel() {
		downloading = true;
		error = null;
		try {
			const res = await api('/portal/settings/tts/kokoro/download', { method: 'POST' });
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json?.error || 'Download failed to start');
			kModel = json as KokoroModel;
			startPolling();
		} catch (e: any) {
			error = e?.message || 'Download failed';
			downloading = false;
		}
	}

	async function save() {
		if (!tts) return;
		saving = true;
		error = null;
		try {
			const body: Record<string, unknown> = { provider: formProvider };
			if (formProvider === 'kokoro' || formKokoroVoice !== tts.kokoro?.voice) {
				body.kokoro = { voice: formKokoroVoice, ...(formProvider === 'kokoro' ? { enabled: true } : {}) };
			}
			const openai: Record<string, string> = {};
			if (formOpenaiKey.trim().length > 0) openai.apiKey = formOpenaiKey.trim();
			if (formOpenaiVoice !== tts.openai.voice) openai.voice = formOpenaiVoice;
			if (formOpenaiModel !== tts.openai.model) openai.model = formOpenaiModel;
			if (Object.keys(openai).length > 0) body.openai = openai;

			const elevenlabs: Record<string, string> = {};
			if (formElevenKey.trim().length > 0) elevenlabs.apiKey = formElevenKey.trim();
			if (formElevenVoiceId.trim() !== (tts.elevenlabs.voiceId ?? '')) {
				elevenlabs.voiceId = formElevenVoiceId.trim();
			}
			if (formElevenModel !== tts.elevenlabs.model) elevenlabs.model = formElevenModel;
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
	{:else if !tts}
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
			<span class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Provider</span>
			<div class="flex gap-4">
				{#each [
					{ id: '',           label: 'Off' },
					{ id: 'kokoro',     label: 'Local (Kokoro)' },
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

		<!-- Local (Kokoro) block -->
		{#if formProvider === 'kokoro'}
			{@const m = kModel ?? tts.kokoro.model}
			<div class="mb-5 space-y-4">
				<p class="text-[0.7rem] text-[var(--color-text-tertiary)]">
					Runs fully on-device — no API key, no cloud, audio never leaves this machine. One-time ~340&nbsp;MB model download.
				</p>

				<!-- Model status / download -->
				<div class="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
					{#if m.phase === 'ready'}
						<div class="text-sm text-[var(--color-accent)]">Model ready ✓</div>
						<div class="text-[0.62rem] text-[var(--color-text-tertiary)] mt-0.5">Kokoro-82M installed locally.</div>
					{:else if m.phase === 'installing' || m.phase === 'downloading'}
						<div class="text-sm text-[var(--color-text-primary)] mb-2">
							{m.phase === 'installing' ? 'Installing kokoro-onnx…' : `Downloading model… ${m.progress}%`}
						</div>
						<div class="h-1.5 w-full rounded-full bg-[var(--color-border)] overflow-hidden">
							<div class="h-full bg-[var(--color-accent)] transition-all" style:width={`${Math.max(3, m.progress)}%`}></div>
						</div>
					{:else}
						<div class="flex items-center justify-between gap-3">
							<div>
								<div class="text-sm text-[var(--color-text-primary)]">Model not installed</div>
								<div class="text-[0.62rem] text-[var(--color-text-tertiary)]">Downloads Kokoro-82M (~340 MB) to this machine.</div>
								{#if m.phase === 'error' && m.error}
									<div class="text-[0.62rem] text-red-400 mt-1">{m.error}</div>
								{/if}
							</div>
							<button
								type="button"
								onclick={(e) => { e.preventDefault(); downloadModel(); }}
								disabled={downloading}
								class="shrink-0 px-3 py-1.5 text-[0.7rem] font-medium bg-[var(--color-accent)] text-[var(--color-bg)] rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer"
							>
								{downloading ? 'Starting…' : (m.phase === 'error' ? 'Retry download' : 'Download model')}
							</button>
						</div>
					{/if}
				</div>

				<!-- Voice -->
				<div>
					<span class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Voice</span>
					<div class="space-y-1.5">
						{#each tts.kokoro.voices as v (v.id)}
							<label class="flex items-center gap-3 p-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/50 cursor-pointer transition-colors"
								style:border-color={formKokoroVoice === v.id ? 'var(--color-accent)' : ''}>
								<input type="radio" bind:group={formKokoroVoice} value={v.id} class="accent-[var(--color-accent)]" />
								<div class="flex-1 min-w-0">
									<div class="text-sm text-[var(--color-text-primary)]">{v.label}</div>
									<div class="text-[0.62rem] text-[var(--color-text-tertiary)]">{v.description}</div>
								</div>
							</label>
						{/each}
					</div>
				</div>
			</div>
		{/if}

		<!-- OpenAI block -->
		{#if formProvider === 'openai'}
			<div class="mb-5 space-y-4">
				<div>
					<label for="tts-openai-key" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
						OpenAI API key
						{#if tts.openai.hasKey}
							<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>
						{/if}
					</label>
					<input
						id="tts-openai-key"
						type="password"
						bind:value={formOpenaiKey}
						placeholder={tts.openai.hasKey ? '••••••••• (leave blank to keep)' : 'sk-…'}
						autocomplete="off"
						data-1p-ignore
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				<div>
					<span class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-2">Voice</span>
					<div class="space-y-1.5">
						{#each tts.openai.voices as v (v.id)}
							<label class="flex items-center gap-3 p-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]/50 cursor-pointer transition-colors"
								style:border-color={formOpenaiVoice === v.id ? 'var(--color-accent)' : ''}>
								<input type="radio" bind:group={formOpenaiVoice} value={v.id} class="accent-[var(--color-accent)]" />
								<div class="flex-1 min-w-0">
									<div class="text-sm text-[var(--color-text-primary)]">{v.label}</div>
									<div class="text-[0.62rem] text-[var(--color-text-tertiary)]">{v.description}</div>
								</div>
								{#if tts.openai.hasKey && tts.provider === 'openai'}
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
					<label for="tts-openai-model" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Model</label>
					<select
						id="tts-openai-model"
						bind:value={formOpenaiModel}
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					>
						{#each tts.openai.models as m (m.id)}
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
					<label for="tts-eleven-key" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
						ElevenLabs API key
						{#if tts.elevenlabs.hasKey}
							<span class="ml-2 text-[var(--color-accent)]">configured ✓</span>
						{/if}
					</label>
					<input
						id="tts-eleven-key"
						type="password"
						bind:value={formElevenKey}
						placeholder={tts.elevenlabs.hasKey ? '••••••••• (leave blank to keep)' : 'paste your ElevenLabs API key'}
						autocomplete="off"
						data-1p-ignore
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				<div>
					<label for="tts-eleven-voice-id" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">
						Voice ID
						<a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener" class="ml-2 text-[0.62rem] text-[var(--color-accent)] hover:underline">find yours →</a>
					</label>
					<input
						id="tts-eleven-voice-id"
						type="text"
						bind:value={formElevenVoiceId}
						placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
						autocomplete="off"
						data-1p-ignore
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				<div>
					<label for="tts-eleven-model" class="text-[0.7rem] text-[var(--color-text-secondary)] block mb-1">Model</label>
					<select
						id="tts-eleven-model"
						bind:value={formElevenModel}
						class="w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					>
						{#each tts.elevenlabs.models as m (m.id)}
							<option value={m.id}>{m.label} — {m.description}</option>
						{/each}
					</select>
				</div>

				{#if tts.elevenlabs.hasKey && tts.provider === 'elevenlabs' && tts.elevenlabs.voiceId}
					<div>
						<button
							type="button"
							onclick={(e) => { e.preventDefault(); preview(tts!.elevenlabs.voiceId!); }}
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
				{#if tts.enabled}
					TTS active — provider: <span class="text-[var(--color-accent)]">{tts.provider}</span>
				{:else}
					TTS not active — pick a provider and add an API key
				{/if}
			</span>
		</div>
	{/if}
</section>
