<script lang="ts">
	// The ONE place that shows every on-device model together (operator ask, 2026-07-18):
	// the four local models — Search (Nomic, bundled), Understanding (qwen3.5:4b),
	// Transcription (Whisper), Voice (Qwen3-TTS) — each with its honest health, its size,
	// and a single download/manage action. Before this, install/health state was scattered
	// across OnboxTaskSelect, TranscriptionSetup and VoiceSection with no unified view, and
	// the purpose-built ModelHealth renderer was mounted NOWHERE (an orphan). This composes
	// shipped parts: it renders each member through ModelHealth (the canonical, honest per-
	// model renderer) and delegates every download to the route that already owns it — no new
	// download path, no forked consent (§3.10d "point, don't re-implement").
	//
	// PRESENTATIONAL: it holds no fetch and no state. The parent (IntelligenceFlow) passes the
	// already-loaded facts (readiness `models` slice + tts state + bundle sizes) mapped into
	// rows, and handles the download action. So this cannot disagree with the summary above it —
	// same source, one fetch (the single-source discipline §3.8).
	//
	// §1 ZERO-PLAINTEXT: every string is a model identifier, a status word, or a size. No vault
	// content is reachable here.
	import ModelHealth from './ModelHealth.svelte';

	// The ModelHealth-shaped health object (kept local to avoid a cross-component type import
	// that the mount compiler would have to strip — status + the optional detail/model/progress).
	type Health = { status?: string | null; message?: string | null; detail?: string | null; model?: string | null; progress?: { pct?: number | null } | null } | null | undefined;

	// One row per local model. `action` is what the button offers; the parent owns the click.
	export type LocalModelRow = {
		key: 'search' | 'understanding' | 'transcription' | 'voice';
		label: string;              // human function name ("Understanding")
		sub: string;                // one-line what-it-does ("labels + entities")
		health: Health;             // ModelHealth-shaped — the honest status line
		kind: 'included' | 'consented';
		sizeGb?: number | null;     // download size when there is something to fetch (else null)
		// The action the button offers for THIS row's current state:
		//   'none'        — bundled / already running / mid-download (no button)
		//   'retry'       — a bundled model whose download/load FAILED (the embedder's HF weights):
		//                   not a fresh download, a re-attempt of the bundled model (→ the parent
		//                   routes it to POST /portal/embed/retry). Distinct from 'download' so the
		//                   copy is honest ("Retry", not "Download") and the size line stays absent.
		//   'download'    — offer a one-tap download of the recommended model
		//   'add-sample'  — downloaded but not usable until the user does a one-tap setup
		//                   step ON ANOTHER PAGE (voice: record/upload a reference sample on
		//                   the character page). A clickable button that ROUTES there — never a
		//                   dead note (R2-VOICEBTN: the 'add a voice sample' message had no button).
		//   'retry-runtime' — the model file is fine but its RUNTIME failed (Ollama not
		//                   reachable for Understanding; the whisper engine crash-looping for
		//                   Transcription). Offers "Retry connection", which pokes that
		//                   service's OWN retry route and renders the re-read health — the
		//                   QA6 §1 un-strand. Distinct from 'retry' (a bundled-model re-load)
		//                   so the copy is "Retry connection", not "Retry", and it routes to
		//                   the daemon/supervisor, not the model download.
		//   'blocked'     — a real reason it can't be offered at all (content-free note, no route)
		action: 'none' | 'download' | 'retry' | 'retry-runtime' | 'add-sample' | 'blocked';
		actionLabel?: string | null; // override the button copy — 'add-sample' ("Add a voice sample")
		                             // or a 'download' variant ("Finish install" for needs-runtime)
		blockedNote?: string | null; // the reason, when action === 'blocked' (content-free)
		busy?: boolean;             // a download this pane started is in flight
	};

	let { models, ondownload, onsample, onretryruntime, machineNoun = 'device' }: {
		models: LocalModelRow[];
		ondownload: (key: string) => void;
		onsample?: (key: string) => void;         // route to the on-another-page setup step ('add-sample')
		onretryruntime?: (key: string) => void;   // re-attempt the model's RUNTIME ('retry-runtime')
		machineNoun?: string;
	} = $props();

	const fmtGb = (n: number | null | undefined) =>
		typeof n === 'number' && Number.isFinite(n) && n > 0 ? `${Math.round(n * 10) / 10} GB` : null;
</script>

<section class="odm" aria-label="On-device models">
	<div class="odm-head">
		<h3 class="odm-title">On-device models</h3>
		<p class="odm-sub">What runs locally on your {machineNoun} — nothing here leaves your computer.</p>
	</div>
	<ul class="odm-list">
		{#each models as m (m.key)}
			<li class="odm-row" data-testid="odm-row" data-key={m.key}>
				<div class="odm-id">
					<span class="odm-label">{m.label}</span>
					<span class="odm-what">{m.sub}</span>
				</div>
				<div class="odm-status">
					<ModelHealth health={m.health} kind={m.kind} />
				</div>
				<div class="odm-meta">
					{#if fmtGb(m.sizeGb)}<span class="odm-size" title="Download size">{fmtGb(m.sizeGb)}</span>{/if}
					{#if m.action === 'download'}
						<button
							class="odm-btn"
							data-testid="odm-download"
							disabled={m.busy}
							onclick={() => ondownload(m.key)}
						>{m.busy ? 'Downloading…' : (m.actionLabel || 'Download')}</button>
					{:else if m.action === 'retry'}
						<!-- A bundled model whose download/load failed (the embedder's HF weights). A re-attempt,
						     not a fresh download — the parent routes it to POST /portal/embed/retry. -->
						<button
							class="odm-btn"
							data-testid="odm-retry"
							disabled={m.busy}
							onclick={() => ondownload(m.key)}
						>{m.busy ? 'Retrying…' : (m.actionLabel || 'Retry')}</button>
					{:else if m.action === 'retry-runtime'}
						<!-- The model is fine; its RUNTIME failed (Ollama unreachable / whisper engine
						     down). "Retry connection" pokes that service's own retry route and shows the
						     re-read health — the QA6 §1 escape hatch. Never a fresh download; no size line. -->
						<button
							class="odm-btn"
							data-testid="odm-retry-runtime"
							disabled={m.busy}
							onclick={() => onretryruntime?.(m.key)}
						>{m.actionLabel || 'Retry connection'}</button>
					{:else if m.action === 'add-sample'}
						<!-- Downloaded, but one setup step remains ON ANOTHER PAGE. A real button that
						     routes there (parent owns the nav) — the fix for the message that named the
						     next step but gave no way to take it (R2-VOICEBTN). -->
						<button
							class="odm-btn"
							data-testid="odm-add-sample"
							onclick={() => onsample?.(m.key)}
						>{m.actionLabel || 'Set up'}</button>
					{:else if m.action === 'blocked'}
						<!-- A real, honest reason it can't be one-tapped yet — never a dead button. -->
						<span class="odm-blocked" data-testid="odm-blocked" title={m.blockedNote || ''}>{m.blockedNote || 'Not available yet'}</span>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
</section>

<style>
	.odm { display: flex; flex-direction: column; gap: 0.5rem; }
	.odm-head { display: flex; flex-direction: column; gap: 0.1rem; }
	.odm-title { font-size: 0.8rem; font-weight: 600; margin: 0; }
	.odm-sub { font-size: 0.72rem; color: var(--color-text-tertiary, #999); margin: 0; }
	.odm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
	.odm-row {
		display: grid;
		grid-template-columns: minmax(9rem, 1.2fr) minmax(0, 1.6fr) auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--color-border, #eee);
	}
	.odm-row:first-child { border-top: none; }
	.odm-id { display: flex; flex-direction: column; min-width: 0; }
	.odm-label { font-size: 0.8rem; }
	.odm-what { font-size: 0.68rem; color: var(--color-text-tertiary, #999); }
	.odm-status { min-width: 0; }
	.odm-meta { display: flex; align-items: center; gap: 0.6rem; justify-content: flex-end; }
	.odm-size { font-size: 0.7rem; color: var(--color-text-tertiary, #999); font-variant-numeric: tabular-nums; }
	.odm-blocked { font-size: 0.68rem; color: var(--color-warn, #b8791a); }
	.odm-btn {
		font-size: 0.72rem; padding: 0.2rem 0.6rem; border-radius: 0.35rem;
		border: 1px solid var(--color-border, #ddd); background: var(--color-surface-2, transparent);
		color: var(--color-text-secondary, #444); cursor: pointer; white-space: nowrap;
	}
	.odm-btn:hover:not(:disabled) { border-color: var(--color-text-tertiary, #999); color: var(--color-text-primary, #111); }
	.odm-btn:disabled { opacity: 0.55; cursor: default; }
	@media (max-width: 560px) {
		.odm-row { grid-template-columns: 1fr auto; grid-template-areas: 'id meta' 'status status'; }
		.odm-id { grid-area: id; }
		.odm-meta { grid-area: meta; }
		.odm-status { grid-area: status; }
	}
</style>
