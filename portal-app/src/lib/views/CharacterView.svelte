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

	// Decode ANY captured/uploaded audio to a 16-bit PCM mono WAV so the render
	// service always receives a decodable reference sample, whatever the source
	// format (MediaRecorder emits webm/opus; uploads may be anything).
	async function toWavB64(arrayBuffer: ArrayBuffer): Promise<string> {
		const AC = (window.AudioContext || (window as any).webkitAudioContext);
		const ctx = new AC();
		try {
			const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
			const ch = decoded.getChannelData(0); // mono (first channel)
			const rate = decoded.sampleRate;
			const wav = encodeWav(ch, rate);
			let bin = '';
			const bytes = new Uint8Array(wav);
			for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
			return btoa(bin);
		} finally { ctx.close(); }
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

	async function hear() {
		previewBusy = true; previewError = null;
		try {
			const res = await api('/portal/character/voice/preview', { method: 'POST', body: JSON.stringify({ text: 'This is my voice.' }) });
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				if (res.status === 503) throw new Error('Voice engine is starting (or needs Apple Silicon). Try again shortly.');
				if (res.status === 501) throw new Error('Freeze a voice sample first.');
				throw new Error(String(j.error || `HTTP ${res.status}`));
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
	/* The pane body is overflow:hidden, so the view must own its own scroll — matches
	   the AgentsView/SettingsView pattern. Without this a tall character page clips. */
	.page { height: 100%; overflow-y: auto; }
	.character { max-width: 720px; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.25rem; }
	.back { align-self: flex-start; background: transparent; border: 0; color: var(--accent, #9a86e0);
		cursor: pointer; padding: .1rem .1rem; font-size: .85rem; }
	.back:hover { text-decoration: underline; }
	.head { display: flex; align-items: center; gap: 1rem; }
	.avatar { width: 64px; height: 64px; border-radius: 16px; display: grid; place-items: center; font-size: 1.9rem;
		background: linear-gradient(135deg, hsl(var(--hue) 60% 55%), hsl(calc(var(--hue) + 40deg) 55% 42%)); color: #fff; }
	h1 { font-size: 1.4rem; margin: 0; } .sub { margin: .2rem 0 0; opacity: .7; font-size: .9rem; }
	.card { border: 1px solid var(--border, #2a2a33); border-radius: 12px; padding: 1rem 1.15rem; background: var(--surface, #16161c); }
	.card h2 { margin: 0 0 .6rem; font-size: 1.05rem; }
	.row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-top: .6rem; }
	.field { display: flex; flex-direction: column; gap: .25rem; margin: .5rem 0; font-size: .85rem; }
	input[type=text], textarea { width: 100%; padding: .5rem .6rem; border-radius: 8px; border: 1px solid var(--border, #2a2a33);
		background: var(--input, #0e0e12); color: inherit; font: inherit; box-sizing: border-box; }
	textarea { resize: vertical; line-height: 1.5; }
	button { padding: .45rem .8rem; border-radius: 8px; border: 1px solid var(--border, #2a2a33); background: var(--accent, #6b4fbb); color: #fff; cursor: pointer; }
	button:disabled { opacity: .5; cursor: default; }
	button.ghost, button.link { background: transparent; color: var(--accent, #9a86e0); }
	button.link { border: 0; padding: .2rem .4rem; font-size: .82rem; text-decoration: underline; }
	button.rec { background: #b33; } .upload { cursor: pointer; padding: .45rem .8rem; border: 1px solid var(--border, #2a2a33); border-radius: 8px; }
	.mic-select { padding: .45rem .6rem; border-radius: 8px; border: 1px solid var(--border, #2a2a33); background: var(--glass-input-bg, transparent); color: var(--color-text-primary, inherit); font-size: .82rem; max-width: 220px; cursor: pointer; }
	.meta { display: flex; justify-content: space-between; gap: 1rem; font-size: .8rem; opacity: .75; margin-top: .4rem; flex-wrap: wrap; }
	.meta .over { color: #e6a23c; } .muted { opacity: .65; font-size: .88rem; } .note { font-size: .78rem; opacity: .6; margin-top: .5rem; }
	.set { font-weight: 600; } .ready { color: #4caf82; font-size: .85rem; }
	.sep { border: 0; border-top: 1px solid var(--border, #2a2a33); margin: .8rem 0; }
	.err { color: #e06c75; font-size: .85rem; margin-top: .4rem; } .warn { color: #e6a23c; font-size: .85rem; }
	.history { margin-left: auto; font-size: .85rem; } .history ul { list-style: none; padding: 0; margin: .4rem 0 0; }
	.history li { display: flex; gap: .5rem; align-items: center; padding: .15rem 0; }
	.diff { margin-top: .7rem; border: 1px solid var(--border, #2a2a33); border-radius: 8px; overflow: auto; }
	.diff-head { padding: .4rem .6rem; font-size: .82rem; display: flex; justify-content: space-between; border-bottom: 1px solid var(--border, #2a2a33); }
	.diff pre { margin: 0; padding: .5rem .6rem; font-size: .8rem; line-height: 1.45; white-space: pre-wrap; }
	.diff .add { color: #4caf82; } .diff .del { color: #e06c75; } .diff .omitted { opacity: .6; font-style: italic; }
</style>
