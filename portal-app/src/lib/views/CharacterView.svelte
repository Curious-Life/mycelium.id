<script lang="ts">
	// CharacterView — the per-agent character page (design §5, "like a video game").
	// Three parts: a derived AVATAR placeholder, the VOICE (capture → freeze → hear),
	// and BEING (mind/self.md) with authorship + diff + revert (the V12 guardrail).
	// Lives entirely OUTSIDE the Intelligence screen (decision V6) — one thought,
	// one place: "my agent's voice", never "my TTS provider".
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { workspace } from '$lib/workspace/store';

	let { id = 'personal-agent' }: { id?: string } = $props();

	// ── BEING (self.md) ────────────────────────────────────────────────────────
	let being = $state('');
	let beingForm = $state('');
	let tokens = $state(0);
	let tokenCap = $state(1200);
	let author = $state<string | null>(null);
	let changedAt = $state<string | null>(null);
	let stale = $state(false);
	let undecryptable = $state(false);
	let snapshots = $state<string[]>([]);
	let beingLoading = $state(true);
	let beingSaving = $state(false);
	let beingError = $state<string | null>(null);
	let beingSaved = $state(false);

	// ── diff / revert ───────────────────────────────────────────────────────────
	let diffOpen = $state(false);
	let diffDate = $state<string | null>(null);
	let diffOps = $state<{ type: string; text: string }[]>([]);
	let diffBusy = $state(false);

	// ── VOICE ─────────────────────────────────────────────────────────────────
	let hasSample = $state(false);
	let sampleText = $state('');
	let voiceDesc = $state(''); // the character sheet (design §3)
	let voiceDescForm = $state('');
	let voiceDescSaving = $state(false);
	let voiceLoading = $state(true);
	let voiceBusy = $state(false);
	let voiceError = $state<string | null>(null);
	let recording = $state(false);
	let capturedWavB64 = $state<string | null>(null);
	let captureTranscript = $state('The quick brown fox jumps over the lazy dog.');
	let previewBusy = $state(false);
	let previewError = $state<string | null>(null);
	let mediaRecorder: MediaRecorder | null = null;
	let recChunks: Blob[] = [];
	let micDevices = $state<{ deviceId: string; label: string }[]>([]);
	let selectedMicId = $state<string>('');

	const dirty = $derived(beingForm !== being);
	const overCap = $derived(tokens > tokenCap);

	onMount(() => {
		loadBeing(); loadVoice(); refreshMics();
		navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
	});

	async function refreshMics() {
		try {
			const devs = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
			micDevices = devs
				.filter((d) => d.kind === 'audioinput' && d.deviceId)
				.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
			if (selectedMicId && !micDevices.some((m) => m.deviceId === selectedMicId)) selectedMicId = '';
		} catch { /* enumeration unsupported — the default mic still works */ }
	}

	async function loadBeing() {
		beingLoading = true; beingError = null;
		try {
			const res = await api('/portal/character/being');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const j = await res.json();
			being = j.content || ''; beingForm = being;
			tokens = j.tokens || 0; tokenCap = j.tokenCap || 1200;
			author = j.author; changedAt = j.changedAt; stale = !!j.stale; undecryptable = !!j.undecryptable;
			snapshots = j.snapshots || [];
		} catch (e) { beingError = e instanceof Error ? e.message : 'load failed'; }
		finally { beingLoading = false; }
	}

	async function saveBeing() {
		if (beingSaving) return;
		beingSaving = true; beingError = null;
		try {
			const res = await api('/portal/character/being', { method: 'PUT', body: JSON.stringify({ content: beingForm }) });
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error === undefined ? `HTTP ${res.status}` : String(j.error));
			}
			beingSaved = true; setTimeout(() => (beingSaved = false), 1500);
			await loadBeing();
		} catch (e) { beingError = e instanceof Error ? e.message : 'save failed'; }
		finally { beingSaving = false; }
	}

	async function openDiff(date: string) {
		diffBusy = true; diffDate = date;
		try {
			const res = await api(`/portal/character/being/diff?date=${encodeURIComponent(date)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const j = await res.json();
			diffOps = j.ops || []; diffOpen = true;
		} catch (e) { beingError = e instanceof Error ? e.message : 'diff failed'; }
		finally { diffBusy = false; }
	}

	async function revert(date: string) {
		if (!confirm(`Revert your agent's character to the ${date} version? (This is itself undoable.)`)) return;
		diffBusy = true;
		try {
			const res = await api('/portal/character/being/revert', { method: 'POST', body: JSON.stringify({ date }) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			diffOpen = false; await loadBeing();
		} catch (e) { beingError = e instanceof Error ? e.message : 'revert failed'; }
		finally { diffBusy = false; }
	}

	async function loadVoice() {
		voiceLoading = true; voiceError = null;
		try {
			const res = await api('/portal/character/voice');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const j = await res.json();
			hasSample = !!j.hasSample; sampleText = j.sampleText || '';
			voiceDesc = j.description || ''; voiceDescForm = voiceDesc;
		} catch (e) { voiceError = e instanceof Error ? e.message : 'load failed'; }
		finally { voiceLoading = false; }
	}

	async function saveVoiceDesc() {
		if (voiceDescSaving) return;
		voiceDescSaving = true; voiceError = null;
		try {
			const res = await api('/portal/character/voice/description', {
				method: 'PUT', body: JSON.stringify({ description: voiceDescForm.trim() || null }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const j = await res.json(); voiceDesc = j.description || ''; voiceDescForm = voiceDesc;
		} catch (e) { voiceError = e instanceof Error ? e.message : 'save failed'; }
		finally { voiceDescSaving = false; }
	}

	// A voice reference only needs to carry speaker identity, so we NORMALIZE it to
	// keep the base64 payload small: a native 48 kHz full-length clip is what
	// overflowed the loopback render body (render-upstream-413). Target the render
	// service's own 24 kHz domain (speech is < 12 kHz ⇒ transparent for a voice
	// reference) and cap the duration to a short clip.
	const REF_TARGET_RATE = 24000;
	const REF_MAX_SECONDS = 30;

	// Decode ANY captured/uploaded audio to a 16-bit PCM mono WAV so the render
	// service always receives a decodable reference sample, whatever the source
	// format (MediaRecorder emits webm/opus; uploads may be anything). Downmix to
	// mono, trim to REF_MAX_SECONDS, and downsample to REF_TARGET_RATE. The
	// downsample falls back to the native-rate trimmed clip if the browser can't
	// resample — the raised service body cap still accepts it.
	async function toWavB64(arrayBuffer: ArrayBuffer): Promise<string> {
		const AC = (window.AudioContext || (window as any).webkitAudioContext);
		const ctx = new AC();
		let decoded: AudioBuffer;
		try { decoded = await ctx.decodeAudioData(arrayBuffer.slice(0)); }
		finally { ctx.close(); }

		const srcRate = decoded.sampleRate;
		const trimFrames = Math.min(decoded.length, Math.ceil(REF_MAX_SECONDS * srcRate));
		const mono = decoded.getChannelData(0).subarray(0, trimFrames); // first channel

		let samples: Float32Array = mono;
		let rate = srcRate;
		if (srcRate > REF_TARGET_RATE && trimFrames > 0) {
			try {
				const OAC = (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext);
				const outFrames = Math.max(1, Math.round((trimFrames / srcRate) * REF_TARGET_RATE));
				const off = new OAC(1, outFrames, REF_TARGET_RATE);
				const buf = off.createBuffer(1, trimFrames, srcRate); // buffer keeps its own rate; the graph resamples
				buf.getChannelData(0).set(mono);
				const node = off.createBufferSource();
				node.buffer = buf; node.connect(off.destination); node.start();
				const rendered = await off.startRendering();
				samples = rendered.getChannelData(0);
				rate = REF_TARGET_RATE;
			} catch { /* keep native-rate trimmed samples — the raised render cap accepts them */ }
		}

		const wav = encodeWav(samples, rate);
		let bin = '';
		const bytes = new Uint8Array(wav);
		for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}

	function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
		const buf = new ArrayBuffer(44 + samples.length * 2);
		const v = new DataView(buf);
		const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
		w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
		w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
		v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
		w(36, 'data'); v.setUint32(40, samples.length * 2, true);
		let o = 44;
		for (let i = 0; i < samples.length; i++, o += 2) {
			const s = Math.max(-1, Math.min(1, samples[i]));
			v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
		return buf;
	}

	async function startRecording() {
		voiceError = null;
		if (!navigator.mediaDevices?.getUserMedia) {
			voiceError = 'This app build can’t access a microphone — upload a clip instead.';
			return;
		}
		try {
			const audio: MediaTrackConstraints | boolean = selectedMicId ? { deviceId: { exact: selectedMicId } } : true;
			const stream = await navigator.mediaDevices.getUserMedia({ audio });
			refreshMics();
			recChunks = [];
			mediaRecorder = new MediaRecorder(stream);
			mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
			mediaRecorder.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop());
				try {
					const blob = new Blob(recChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
					capturedWavB64 = await toWavB64(await blob.arrayBuffer());
				} catch (e) { voiceError = 'Could not decode the recording — try uploading a WAV.'; }
			};
			mediaRecorder.start();
			recording = true;
		} catch (e: any) {
			const name = e?.name || '';
			if (name === 'NotAllowedError' || name === 'SecurityError')
				voiceError = 'Microphone permission was denied. Allow microphone access for Mycelium in System Settings → Privacy & Security → Microphone, then try again.';
			else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError')
				voiceError = 'No microphone found — connect one (or pick another device), then try again.';
			else if (name === 'NotReadableError')
				voiceError = 'Your microphone is in use by another app. Close it and try again.';
			else
				voiceError = `Couldn’t start the microphone${e?.message ? ` — ${e.message}` : '.'}`;
		}
	}
	function stopRecording() { recording = false; mediaRecorder?.stop(); }

	async function onFilePick(ev: Event) {
		const file = (ev.target as HTMLInputElement).files?.[0];
		if (!file) return;
		voiceError = null;
		try { capturedWavB64 = await toWavB64(await file.arrayBuffer()); }
		catch { voiceError = 'Could not decode that audio file.'; }
	}

	async function freezeSample() {
		if (!capturedWavB64 || !captureTranscript.trim()) return;
		voiceBusy = true; voiceError = null;
		try {
			const res = await api('/portal/character/voice/sample', {
				method: 'POST', body: JSON.stringify({ wavB64: capturedWavB64, sampleText: captureTranscript.trim() }),
			});
			if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(String(j.error || `HTTP ${res.status}`)); }
			capturedWavB64 = null; await loadVoice();
		} catch (e) { voiceError = e instanceof Error ? e.message : 'freeze failed'; }
		finally { voiceBusy = false; }
	}

	async function clearSample() {
		if (!confirm("Clear this voice? You'll capture a new one.")) return;
		voiceBusy = true; voiceError = null;
		try { await api('/portal/character/voice', { method: 'DELETE' }); await loadVoice(); }
		catch (e) { voiceError = e instanceof Error ? e.message : 'clear failed'; }
		finally { voiceBusy = false; }
	}

	// ── Honest audition errors (D-003 ↻2) ────────────────────────────────────
	// This used to map EVERY 503 to "Voice engine is starting (or needs Apple
	// Silicon). Try again shortly." — a transient-sounding sentence over a condition
	// that, on the operator's box, never changed. Three QA cycles in a row the
	// answer to "how long is shortly?" was "forever".
	//
	// So: the reason token decides the sentence, and `terminal` decides whether
	// "try again" is even offered. A named remedy always comes with it (the QA6 bar:
	// every break has a remedy the user can execute). The server's `detail` is
	// already sanitized (src/tts/voice-render.js) and is appended so the operator's
	// smoke captures the true cause instead of a generic 500.
	const VOICE_REASON_TEXT: Record<string, string> = {
		'voice-sample-pending': 'No voice sample yet — record and freeze one above.',
		'voice-runtime-missing':
			'This Mac cannot run the on-device voice engine — it needs Apple Silicon with mlx-audio. Reinstall the voice runtime in Settings → Voice.',
		'model-unavailable':
			'The voice model could not be loaded. Re-download it in Settings → Voice.',
		'synth-failed':
			'The voice engine failed while speaking. Try again; if it repeats, re-record the voice sample above.',
		'bad-ref-audio': 'That voice sample couldn’t be read — re-record and freeze it again.',
		'bad-length': 'That voice sample is too large — record a shorter clip (under ~30s) and freeze it again.',
		'render-service-unreachable':
			'The on-device voice engine isn’t answering yet. If this doesn’t clear, check Settings → Voice.',
		'non-loopback-render-url': 'The voice engine address is misconfigured — it must stay on this machine.',
		'rate-limited': 'Too many auditions in a row — wait a moment.',
	};

	// Reasons decided BEFORE any network call. These are about THIS request, not about
	// the engine, so they must beat the supervisor's verdict — otherwise "record a voice
	// sample first" (a ten-second fix, decided in voice-render.js before a socket is
	// opened) gets overwritten by "reinstall the voice runtime" whenever the engine
	// happens to be unhealthy. Sending the owner to the wrong remedy is how a defect
	// survives a QA cycle.
	const REQUEST_LOCAL_REASONS = new Set([
		'voice-sample-pending',
		'bad-ref-audio',
		'bad-length',
		'non-loopback-render-url',
		'rate-limited',
	]);

	function previewErrorText(j: any, status: number): string {
		const code = typeof j?.error === 'string' ? j.error : '';
		if (REQUEST_LOCAL_REASONS.has(code) && VOICE_REASON_TEXT[code]) return VOICE_REASON_TEXT[code];
		// Otherwise the SUPERVISOR's verdict wins when it is terminal: it knows things a
		// single render attempt cannot (halted after a crash-loop, port held, runtime
		// absent), and it carries the remedy.
		const svc = j?.service;
		if (svc?.state === 'failed' || svc?.state === 'degraded') {
			if (svc.remedy) return String(svc.remedy);
		}
		let msg = VOICE_REASON_TEXT[code];
		if (!msg) {
			msg = j?.terminal
				? 'The voice engine cannot render right now.'
				: status === 503
					? 'The on-device voice engine isn’t ready yet.'
					: 'Voice render failed.';
		}
		const detail = typeof j?.detail === 'string' && j.detail ? ` (${j.detail})` : '';
		return `${msg}${detail}`;
	}

	async function hear() {
		previewBusy = true; previewError = null;
		try {
			const res = await api('/portal/character/voice/preview', { method: 'POST', body: JSON.stringify({ text: 'This is my voice.' }) });
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(previewErrorText(j, res.status));
			}
			const buf = await res.arrayBuffer();
			const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
			await new Audio(url).play();
		} catch (e) { previewError = e instanceof Error ? e.message : 'preview failed'; }
		finally { previewBusy = false; }
	}

	// ── Avatar — derived placeholder (design §5.4a): deterministic gradient+glyph
	//    from the agent id. Zero storage, no upload; looks intentional.
	function hashStr(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
	const avatarHue = $derived(hashStr(id) % 360);
	const avatarGlyph = $derived(String.fromCodePoint(0x1f331 + (hashStr(id) % 8))); // a small spread of nature glyphs
	function fmtWhen(iso: string | null): string { if (!iso) return ''; try { return new Date(iso).toLocaleDateString(); } catch { return iso; } }
</script>

<div class="page">
<div class="character">
	<button type="button" class="back" onclick={() => workspace.openFromRoute('agents')} aria-label="Back to Agents">← Agents</button>
	<header class="head">
		<div class="avatar" style="--hue:{avatarHue}deg" aria-hidden="true">{avatarGlyph}</div>
		<div>
			<h1>Your agent</h1>
			<p class="sub">Roll a voice, describe who they are — this is where your agent becomes someone.</p>
		</div>
	</header>

	<!-- VOICE -->
	<section class="card">
		<h2>Voice</h2>
		{#if !voiceLoading}
			<label class="field"><span>Describe the voice <span class="muted">(the character sheet — how it should sound)</span></span>
				<textarea bind:value={voiceDescForm} rows="2" maxlength="500"
					placeholder="A deep, resonant voice with the weight of age. A witty old master — dry humour underneath."></textarea>
			</label>
			{#if voiceDescForm.trim() !== voiceDesc}
				<div class="row"><button class="ghost" onclick={saveVoiceDesc} disabled={voiceDescSaving}>{voiceDescSaving ? 'Saving…' : 'save description'}</button></div>
			{/if}
			<hr class="sep" />
		{/if}
		{#if voiceLoading}
			<p class="muted">Loading…</p>
		{:else if hasSample}
			<p class="set">● Voice locked. <span class="muted">Sample: "{sampleText}"</span></p>
			<div class="row">
				<button onclick={hear} disabled={previewBusy}>{previewBusy ? 'Rendering…' : '▶ hear'}</button>
				<button class="ghost" onclick={clearSample} disabled={voiceBusy}>capture a new voice</button>
			</div>
			{#if previewError}<p class="err">{previewError}</p>{/if}
			<p class="note">Channel voice (Telegram/Discord) in this cloned voice is coming soon; the audition above runs locally on Apple Silicon.</p>
		{:else}
			<p class="muted">Capture a short reference clip — its sound becomes your agent's voice (a described voice isn't reproducible; a captured one is).</p>
			<label class="field"><span>What you'll say (the transcript)</span>
				<input type="text" bind:value={captureTranscript} maxlength="200" />
			</label>
			<div class="row">
				{#if recording}
					<button class="rec" onclick={stopRecording}>■ stop</button>
				{:else}
					<button onclick={startRecording}>● record</button>
				{/if}
					{#if micDevices.length > 1}
						<select class="mic-select" bind:value={selectedMicId} title="Microphone" aria-label="Microphone">
							<option value="">Default microphone</option>
							{#each micDevices as m (m.deviceId)}<option value={m.deviceId}>{m.label}</option>{/each}
						</select>
					{/if}
				<label class="upload">upload a clip<input type="file" accept="audio/*" onchange={onFilePick} hidden /></label>
			</div>
			{#if capturedWavB64}
				<div class="row">
					<span class="ready">✓ clip ready</span>
					<button onclick={freezeSample} disabled={voiceBusy || !captureTranscript.trim()}>{voiceBusy ? 'Freezing…' : 'this is the voice → lock'}</button>
				</div>
			{/if}
			{#if voiceError}<p class="err">{voiceError}</p>{/if}
		{/if}
	</section>

	<!-- BEING (self.md) -->
	<section class="card">
		<h2>Being</h2>
		{#if beingLoading}
			<p class="muted">Loading…</p>
		{:else}
			{#if undecryptable}
				<p class="warn">⚠ This character couldn't be decrypted — don't overwrite it blindly. Check your vault key.</p>
			{/if}
			<textarea bind:value={beingForm} rows="10" placeholder="Warm but doesn't flatter. Asks the question under the question. Doesn't perform enthusiasm."></textarea>
			<div class="meta">
				<span class:over={overCap}>{tokens} / ~{tokenCap} tokens</span>
				{#if author}
					<span class="auth">last changed by {author === 'agent' ? 'your agent' : 'you'} {changedAt ? '· ' + fmtWhen(changedAt) : ''}{stale ? ' · ⚠ may be out of date' : ''}</span>
				{/if}
			</div>
			<div class="row">
				<button onclick={saveBeing} disabled={!dirty || beingSaving}>{beingSaved ? 'Saved ✓' : beingSaving ? 'Saving…' : 'Save'}</button>
				{#if snapshots.length}
					<details class="history">
						<summary>history ({snapshots.length})</summary>
						<ul>
							{#each snapshots as d}
								<li><span>{d}</span>
									<button class="link" onclick={() => openDiff(d)} disabled={diffBusy}>see what changed</button>
									<button class="link" onclick={() => revert(d)} disabled={diffBusy}>revert</button>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</div>
			{#if beingError}<p class="err">{beingError}</p>{/if}
			{#if diffOpen}
				<div class="diff">
					<div class="diff-head">Changes since {diffDate} <button class="link" onclick={() => (diffOpen = false)}>close</button></div>
					<pre>{#each diffOps as op}<span class={op.type}>{op.type === 'add' ? '+ ' : op.type === 'del' ? '- ' : op.type === 'omitted' ? '' : '  '}{op.text}
</span>{/each}</pre>
				</div>
			{/if}
		{/if}
	</section>
</div>
</div>

<style>
	/*
	 * D-024 — "agent character page elements need to adapt to light vs dark mode,
	 * the boxes there are all dark mode even in white" (operator, v0.1.12 QA).
	 *
	 * ROOT CAUSE: this stylesheet referenced tokens that DO NOT EXIST — `--border`,
	 * `--surface`, `--input`, `--accent`. The app's design system (src/lib/styles/
	 * tokens.css) names them `--color-border`, `--color-surface`, `--color-elevated`
	 * and `--color-accent`, and re-declares each under `[data-theme="light"]`. Because
	 * the short names were never declared anywhere, EVERY `var(--border, #2a2a33)`
	 * silently resolved to its hardcoded DARK fallback — in both themes. The page was
	 * not "ignoring" light mode; it was never wired to the theme at all.
	 *
	 * FIX: use the real semantic tokens, with no hex fallbacks that could mask a
	 * future rename the same way. This is the EXISTING mechanism (the `data-theme`
	 * attribute the theme store stamps on <html>) — no new theming machinery.
	 * Verified by scripts/verify-character-theme.mjs, which fails if an undeclared
	 * custom property reappears here.
	 */
	/* The pane body is overflow:hidden, so the view must own its own scroll — matches
	   the AgentsView/SettingsView pattern. Without this a tall character page clips. */
	.page { height: 100%; overflow-y: auto; }
	.character { max-width: 720px; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.25rem; }
	.back { align-self: flex-start; background: transparent; border: 0; color: var(--color-accent);
		cursor: pointer; padding: .1rem .1rem; font-size: .85rem; }
	.back:hover { text-decoration: underline; }
	.head { display: flex; align-items: center; gap: 1rem; }
	/* The avatar is a deliberate saturated gradient in BOTH themes (it is an identity
	   mark, not a surface), so white glyph text on it stays correct either way. */
	.avatar { width: 64px; height: 64px; border-radius: 16px; display: grid; place-items: center; font-size: 1.9rem;
		background: linear-gradient(135deg, hsl(var(--hue) 60% 55%), hsl(calc(var(--hue) + 40deg) 55% 42%)); color: #fff; }
	h1 { font-size: 1.4rem; margin: 0; color: var(--color-text-emphasis); }
	.sub { margin: .2rem 0 0; opacity: .7; font-size: .9rem; color: var(--color-text-secondary); }
	.card { border: 1px solid var(--color-border); border-radius: 12px; padding: 1rem 1.15rem;
		background: var(--color-surface); color: var(--color-text-primary); }
	.card h2 { margin: 0 0 .6rem; font-size: 1.05rem; color: var(--color-text-primary); }
	.row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-top: .6rem; }
	.field { display: flex; flex-direction: column; gap: .25rem; margin: .5rem 0; font-size: .85rem; }
	input[type=text], textarea { width: 100%; padding: .5rem .6rem; border-radius: 8px; border: 1px solid var(--color-border);
		background: var(--color-bg); color: var(--color-text-primary); font: inherit; box-sizing: border-box; }
	input[type=text]::placeholder, textarea::placeholder { color: var(--color-text-tertiary); }
	input[type=text]:focus, textarea:focus { outline: none; border-color: var(--color-accent); }
	textarea { resize: vertical; line-height: 1.5; }
	/* The filled button keeps its contrast in both themes by painting the app
	   background as its LABEL colour (the same pairing the settings buttons use),
	   instead of a fixed #fff that vanished on the light accent. */
	button { padding: .45rem .8rem; border-radius: 8px; border: 1px solid transparent;
		background: var(--color-accent); color: var(--color-bg); cursor: pointer; }
	button:disabled { opacity: .5; cursor: default; }
	button.ghost, button.link { background: transparent; color: var(--color-accent); border-color: var(--color-border); }
	button.link { border: 0; padding: .2rem .4rem; font-size: .82rem; text-decoration: underline; }
	button.rec { background: var(--color-accent-coral); color: var(--color-bg); }
	.upload { cursor: pointer; padding: .45rem .8rem; border: 1px solid var(--color-border); border-radius: 8px;
		color: var(--color-text-secondary); }
	.mic-select { padding: .45rem .6rem; border-radius: 8px; border: 1px solid var(--color-border); background: var(--glass-input-bg); color: var(--color-text-primary); font-size: .82rem; max-width: 220px; cursor: pointer; }
	.meta { display: flex; justify-content: space-between; gap: 1rem; font-size: .8rem; opacity: .75; margin-top: .4rem; flex-wrap: wrap;
		color: var(--color-text-secondary); }
	.meta .over { color: var(--color-accent-aurum); }
	.muted { opacity: .65; font-size: .88rem; color: var(--color-text-secondary); }
	.note { font-size: .78rem; opacity: .6; margin-top: .5rem; color: var(--color-text-tertiary); }
	.set { font-weight: 600; } .ready { color: var(--color-accent-jade); font-size: .85rem; }
	.sep { border: 0; border-top: 1px solid var(--color-border); margin: .8rem 0; }
	.err { color: var(--color-accent-coral); font-size: .85rem; margin-top: .4rem; }
	.warn { color: var(--color-accent-aurum); font-size: .85rem; }
	.history { margin-left: auto; font-size: .85rem; } .history ul { list-style: none; padding: 0; margin: .4rem 0 0; }
	.history li { display: flex; gap: .5rem; align-items: center; padding: .15rem 0; }
	.diff { margin-top: .7rem; border: 1px solid var(--color-border); border-radius: 8px; overflow: auto;
		background: var(--color-bg); }
	.diff-head { padding: .4rem .6rem; font-size: .82rem; display: flex; justify-content: space-between; border-bottom: 1px solid var(--color-border); }
	.diff pre { margin: 0; padding: .5rem .6rem; font-size: .8rem; line-height: 1.45; white-space: pre-wrap; }
	.diff .add { color: var(--color-accent-jade); } .diff .del { color: var(--color-accent-coral); } .diff .omitted { opacity: .6; font-style: italic; }
</style>
