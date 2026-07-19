<script lang="ts">
	// Renders ONE readiness `models.*` member (src/readiness.js §3.10b) honestly.
	//
	// WHY THIS EXISTS. The `models` slice shipped COMPLETE and SERVED but with **zero
	// consumers in portal-app** (design §3.10 line 571, verified 2026-07-16) — only the
	// verify gates read it. So the report existed and the dormancy it exists to expose was
	// still invisible: a vault that approves Labeling but leaves Enrichment unset ran L2
	// dead and silent, and nothing on screen said so. A report nobody renders is not a
	// surface. This is that surface.
	//
	// ⚠️ SCOPE — this renders THREE of the slice's four members: `embedder`, `labeler`,
	// `enricher` (AISettings.svelte, next to each one's own picker). The fourth,
	// `transcriber`, was ALREADY rendered before this component existed — the Voice
	// transcription lane below the Models lane reads `GET /portal/transcription/status`,
	// which returns `getTranscriberHealth()`: the *same source* `models.transcriber` is a
	// projection of, so the two cannot disagree. That lane also owns whisper's catalog +
	// download rail and its own 2s poll, which readiness has no business carrying — so it
	// keeps its own rendering rather than paying a second fetch to say the same thing.
	// ⇒ design §3.10 line 571's "true of all four members, labeler included" is inaccurate
	// about the transcriber: it was the only member an owner could already see.
	//
	// ⚠️ An earlier version of this note justified that with "for no honesty gained" — FALSE,
	// and an independent review refuted it (2026-07-16): the Voice lane's if-chain had no
	// `down` branch, so a crash-looping engine rendered the not-set-up marketing copy. Honesty
	// WAS on the table. The gap is now fixed in that lane directly (AISettings.svelte), which
	// is the cheaper half of what a reroute would have bought. Do not restate the old claim.
	//
	// ⚠️ THE MEMBERS ARE NOT SYMMETRICAL (§3.10d-c). This component encodes the asymmetry in
	// ONE place so no host screen has to re-derive it:
	//
	//   kind="included"  — the EMBEDDER. Bundled with the app; cannot be declined, cannot be
	//                      downloaded, ~always 'ok'. Rendered as "Included", NEVER as an
	//                      approvable choice. Presenting a non-choice as consent is exactly
	//                      the dishonesty §3.10 exists to remove, so `included` has no
	//                      no_model/paused state to render — it has no off switch to report.
	//   kind="consented" — the labeler and the enricher. The owner approves each one
	//                      SEPARATELY (`taskModels.categorize` and `taskModels.enrich` are
	//                      independent settings; `PUT /providers/task-models` writes exactly
	//                      one task per call), so each gets its OWN member — never a shared
	//                      object, which is how a label approval would silently read as
	//                      enrich consent.
	//
	// ⚠️ 'no_model' AND 'paused' ARE CHOICES, NOT FAULTS — never red, never an error icon.
	// Declining is a supported configuration: the vault still imports, embeds (bundled) and
	// generates its mindscape. It simply has no categories. Rendering a supported config as
	// a fault would train the owner to "fix" their own deliberate choice.
	//
	// ⚠️ 'unknown' IS NOT "BROKEN" either, and today it is genuinely ambiguous — two known
	// open health gaps (2026-07-16): a CAUGHT-UP vault can read 'unknown' rather than 'ok',
	// and a crashing cycle also reads 'unknown'. Until those are closed, `unknown` must
	// render as an honest absence of information ("not started yet"), never as a failure.
	// Guessing 'ok' would fabricate health; guessing 'error' would cry wolf on a healthy vault.
	//
	// The vocabulary is readiness.js's, surfaced verbatim rather than re-invented:
	//   ok | no_model | downloading | loading | paused | unavailable | deps_missing |
	//   down | error | unknown   (+ 'starting'/'installing_deps' from the transcriber's
	//   supervisor, which speaks the same dialect and predates the slice).
	//
	// NO PLAINTEXT (CLAUDE.md §1): a member carries {status, message, detail, model,
	// progress} — counts, enums and model NAMES only. `detail` is a failure hint from a
	// supervisor, never vault content; it is rendered only in the genuine-fault states.

	type Progress = { pct?: number | null } | null;
	export type Health = {
		status?: string | null;
		message?: string | null;
		detail?: string | null;
		model?: string | null;
		progress?: Progress;
	} | null | undefined;

	let {
		health,
		kind = 'consented',
	}: {
		health: Health;
		kind?: 'included' | 'consented';
	} = $props();

	// A MISSING member is not 'ok'. Fail-closed to the same honest absence readiness.js
	// itself degrades to, so a host that forgets to pass one cannot render a fabricated ✓.
	const status = $derived(String(health?.status || 'unknown'));
	const model = $derived(health?.model || null);
	const message = $derived(health?.message || null);
	// A supervisor's failure hint (e.g. "ollama exited 1") — NEVER vault content, and rendered
	// only in the genuine-fault states, where it is the more useful of the two strings.
	const detail = $derived(health?.detail || null);

	// Byte-accurate, straight off ollama's pull stream. A multi-GB model pull is the
	// longest unattended thing this app does — a spinner with no number is why "is it
	// stuck?" is unanswerable. Clamped: a bad number must not paint a bar off its track.
	const pct = $derived(
		typeof health?.progress?.pct === 'number' && Number.isFinite(health.progress.pct)
			? Math.max(0, Math.min(100, health.progress.pct))
			: null,
	);

	const BUSY = new Set(['downloading', 'loading', 'starting', 'installing_deps']);
	const isBusy = $derived(BUSY.has(status));

	// Name the model only when the message has not already named it. The supervisors' own
	// copy usually does ("Enriching with qwen3.5:4b."), and appending it again rendered
	// "Enriching with qwen3.5:4b. · qwen3.5:4b" — which reads like two different models.
	const showModel = $derived(Boolean(model) && !String(message || '').includes(String(model)));
</script>

<div class="mh" class:mh-busy={isBusy}>
	{#if kind === 'included'}
		<!-- The embedder: a fait accompli, not a choice (§3.10d-c). It gets no Off state and no
		     approve control. But "not approvable" is NOT "never reported" — it still has real
		     faults, and it still has an "I don't know" that must not be dressed up as health. -->
		{#if status === 'ok'}
			<span class="mh-dot ok"></span>
			<span class="mh-text">Included with the app · runs on your device</span>
		{:else if status === 'down' || status === 'error' || status === 'unavailable'}
			<span class="mh-dot bad"></span>
			<span class="mh-text bad-text">{detail || message || 'Search indexing is not running.'}</span>
		{:else if status === 'deps_missing'}
			<!-- Actionable, and the SAME status the consented lane calls a warning. It used to fall
			     to the busy branch below and paint blue — i.e. a setup step the owner must take read
			     as work already in progress (independent review, 2026-07-16). -->
			<span class="mh-dot warn"></span>
			<span class="mh-text warn-text">{message || 'The search engine needs setup.'}</span>
		{:else if BUSY.has(status)}
			<span class="mh-dot busy"></span>
			<span class="mh-text muted">{message || 'Starting…'}</span>
		{:else}
			<!-- 'unknown', or an ABSENT member (a readiness outage leaves the host with nothing to
			     pass). The TEXT stays true — it is bundled, and it does run on your device, whatever
			     the supervisor has said — but the dot must NOT be green. It used to be: `status ===
			     'ok' || status === 'unknown'` painted the ok dot, so an embedder nothing had
			     reported on rendered as a healthy ✓, which is the fabricated liveness this whole
			     slice exists to remove (independent review, 2026-07-16). -->
			<span class="mh-dot idle"></span>
			<span class="mh-text muted">Included with the app · runs on your device</span>
		{/if}
	{:else if status === 'ok'}
		<span class="mh-dot ok"></span>
		<span class="mh-text">{message || 'Running on your device'}{#if showModel}{' · '}<span class="mono">{model}</span>{/if}</span>
	{:else if status === 'no_model'}
		<!-- A CHOICE, not a fault. Muted, no icon of alarm — and it names the remedy without
		     implying anything is wrong. -->
		<span class="mh-dot off"></span>
		<span class="mh-text muted">Off · not running on your device</span>
	{:else if status === 'paused'}
		<span class="mh-dot off"></span>
		<span class="mh-text muted">Paused{#if model}{' · '}<span class="mono">{model}</span>{/if}</span>
	{:else if status === 'downloading'}
		<div class="mh-dl">
			<span class="mh-text muted pulse">
				Downloading{#if model}{' '}<span class="mono">{model}</span>{/if}{#if pct !== null}{' · '}{pct}%{/if}
			</span>
			<!-- Indeterminate when the stream has given us no number yet — an empty bar at 0%
			     for a 3.4GB pull reads as "stuck", which is the question this is here to answer. -->
			<div class="mh-bar" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin="0" aria-valuemax="100">
				<div class="mh-fill" class:indeterminate={pct === null} style={pct !== null ? `width:${pct}%` : undefined}></div>
			</div>
		</div>
	{:else if BUSY.has(status)}
		<span class="mh-dot busy"></span>
		<span class="mh-text muted pulse">{message || 'Preparing…'}</span>
	{:else if status === 'deps_missing'}
		<span class="mh-dot warn"></span>
		<span class="mh-text warn-text">{message || 'Missing dependencies.'}</span>
	{:else if status === 'down' || status === 'error' || status === 'unavailable'}
		<!-- The only genuinely red states. The `message` now LEADS: the drainer classifies the
		     fault (runtime down vs download failed vs disk full) and sends an accurate, actionable
		     line, so it is the useful one — the old code showed `detail` first, back when `message`
		     was a hardcoded "runtime not reachable" for every cause. `detail` is ollama's own hint
		     (never vault content) and rides underneath, muted, for the technically-inclined. -->
		<span class="mh-dot bad"></span>
		<div class="mh-fault">
			<span class="mh-text bad-text">{message || detail || 'Not running.'}</span>
			{#if detail && detail !== message}<span class="mh-hint muted" title={detail}>{detail}</span>{/if}
		</div>
	{:else}
		<!-- 'unknown' — an honest absence, NOT a fault. See the header: a caught-up vault and
		     a crashing cycle currently both land here, so this must not claim either. -->
		<span class="mh-dot idle"></span>
		<span class="mh-text muted">{message || 'Not started yet'}</span>
	{/if}
</div>

<style>
	.mh { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; min-width: 0; }
	.mh-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--color-text-muted, #888); }
	.mh-dot.ok { background: var(--color-good, #3fa46a); }
	.mh-dot.off, .mh-dot.idle { background: var(--color-text-muted, #999); opacity: 0.55; }
	.mh-dot.busy { background: var(--color-accent, #4a90d9); }
	.mh-dot.warn { background: var(--color-warn, #d99a2b); }
	.mh-dot.bad { background: var(--color-bad, #d95c5c); }
	.mh-text { min-width: 0; overflow-wrap: anywhere; }
	.muted { color: var(--color-text-muted, #888); }
	.warn-text { color: var(--color-warn, #b8791a); }
	.bad-text { color: var(--color-bad, #c04a4a); }
	.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.95em; }
	.mh-fault { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
	.mh-hint { font-size: 0.85em; overflow-wrap: anywhere; opacity: 0.85; }
	.mh-dl { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; flex: 1; }
	.mh-bar { height: 4px; border-radius: 2px; background: var(--color-surface-2, #e6e6e6); overflow: hidden; }
	.mh-fill { height: 100%; background: var(--color-accent, #4a90d9); transition: width 0.3s ease; }
	.mh-fill.indeterminate { width: 35%; animation: mh-slide 1.2s ease-in-out infinite; }
	@keyframes mh-slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
	.pulse { animation: mh-pulse 1.6s ease-in-out infinite; }
	@keyframes mh-pulse { 50% { opacity: 0.55; } }
	@media (prefers-reduced-motion: reduce) {
		.pulse, .mh-fill.indeterminate { animation: none; }
	}
</style>
