<script lang="ts">
	// PipelineStatus — the ONE overview of "where is my data in the pipeline?" (PIPELINE-
	// TRANSPARENCY-DESIGN-2026-07-19 §"Module shape"). Renders the server's ordered stage machine
	// (import → embed → categorize → cluster → describe → measure) top-to-bottom, from the canonical
	// `pipeline` store — never its own derivation. This is the surface that FILLS THE GAPS:
	//   • measure + describe become VISIBLE, and BEFORE a map exists (they were invisible pre-map).
	//   • `overall` incl. up-to-date / error / skipped renders HERE — the "$generate.error renders in
	//     ZERO places app-wide" silence the design deletes (generate.ts:29-37).
	//   • every block names its REMEDY inline (a labelled action button) — no "empty rail with words".
	//
	// UNIT 4 — the block-action buttons are now LIVE. Each stage's `action.target` (emitted by
	// readiness.js pipeline(): 'intelligence' | 'generate' | 'resume') routes to its EXISTING authed
	// path — no new endpoint, no slice change, no auto-advance (that is Unit 5). The block itself
	// clears on the NEXT readiness poll once its remedy takes (e.g. the drainer is already nudged on
	// model-approval, portal-intelligence.js:265); this component only FIRES the remedy, it does not
	// re-derive the block.
	import { pipeline, type Stage } from '$lib/pipeline';
	import { fmtSeconds, start } from '$lib/generate';
	import { apiPost } from '$lib/api';
	import { goto } from '$app/navigation';

	// A human label per stage key — the ORDER comes from the server array, never re-sorted here.
	const STAGE_LABEL: Record<string, string> = {
		import: 'Import',
		embed: 'Embed',
		categorize: 'Categorize',
		cluster: 'Cluster',
		describe: 'Describe',
		measure: 'Measure',
	};

	// Reason enums → human copy. FIXED strings (never derived from vault text — §1). Covers the
	// blocked reasons AND the two pending reasons (waiting_embed, map_unknown) the slice emits.
	const REASON_TEXT: Record<string, string> = {
		no_model: 'No labeling model approved yet',
		embedder_down: 'The embedding engine isn’t running',
		ollama_down: 'The labeling model isn’t running',
		disk_low: 'Low disk space',
		paused: 'Paused',
		needs_generate: 'Ready to build your map',
		too_few_embedded: 'Not enough embedded yet to build a map',
		waiting_embed: 'Waiting for embedding to finish',
		map_unknown: 'Checking your map…',
	};

	const labelFor = (key: string) => STAGE_LABEL[key] ?? key;
	const reasonText = (reason?: string) => (reason ? REASON_TEXT[reason] ?? reason : '');

	// "3,200 / 76,000" — counts only, localised. Absent total ⇒ a bare done count.
	function countText(c?: { done: number; total?: number }): string {
		if (!c) return '';
		const done = (c.done ?? 0).toLocaleString();
		return c.total != null ? `${done} / ${(c.total).toLocaleString()}` : done;
	}

	// The remedy is LIVE. Every button is enabled and honestly disabled ONLY while its OWN action is
	// in-flight — keyed so co-located buttons (a stage's Stop AND its Restart, or the two stages'
	// controls) guard independently. The busy set is the double-fire guard: a second click while the
	// first is outstanding is dropped, so a POST/start() can never fire twice from one impatient user.
	// A failed action is swallowed here — the next readiness poll re-derives the block and the button
	// simply re-enables; this surface FIRES the remedy, it never owns the outcome.
	let busy = $state<Set<string>>(new Set());
	const isBusy = (key: string) => busy.has(key);

	// The generic blocked-remedy (no_model → Intelligence, too_few/needs_generate → Generate,
	// embedder_down → check). NOT pause/resume — that is the co-located Stop/Resume control below.
	// Keyed `${key}:action` so it guards independently of the same stage's Stop/Restart.
	async function onAction(stage: Stage) {
		const target = stage.action?.target;
		const bkey = `${stage.key}:action`;
		if (!target || busy.has(bkey)) return; // no target, or already in-flight → drop
		busy = new Set(busy).add(bkey);
		try {
			if (target === 'intelligence') {
				// Approve a labeling model / check a runtime → the Intelligence settings screen. The
				// same nav MindscapeDetail uses (goto('/settings?tab=intelligence')). The block clears
				// on the next poll once a model is approved (the drainer is already nudged).
				await goto('/settings?tab=intelligence');
			} else if (target === 'generate') {
				// too_few_embedded / needs_generate → the EXISTING generate lifecycle. start() POSTs
				// /mycelium/generate; we do not re-implement the POST or add auto-advance (Unit 5).
				await start();
			}
		} catch {
			/* the next readiness poll re-derives the block; a failed remedy just re-enables the button */
		} finally {
			busy = new Set([...busy].filter((k) => k !== bkey));
		}
	}

	// Per-stage pause/resume toggle + Restart (QA R2-PIPECTL, R3-PIPESTOP, N9). Each stage's controls
	// hit ITS OWN route — embed → /portal/enrichment/embed/*, categorize → /portal/enrichment/
	// categorize/* — so the two stages pause independently (the whole point of splitting the global
	// toggle). `kind`:
	//   • 'pause'/'resume' → the ONE two-state icon toggle (⏸ running → pause · ▶ paused → resume;
	//                        persisted; drainer honors it mid-run). Not two buttons — a single symbol
	//                        that flips, per the operator's "just stop / continue" intent.
	//   • 'restart'        → re-queue that stage's gave-up rows + nudge (retry-failed, per stage).
	// Keyed `${key}:${kind}` so the toggle and Restart on the same stage guard independently.
	async function onStageControl(stage: Stage, kind: 'pause' | 'resume' | 'restart') {
		const bkey = `${stage.key}:${kind}`;
		if (busy.has(bkey)) return;
		busy = new Set(busy).add(bkey);
		try {
			await apiPost(`/portal/enrichment/${stage.key}/${kind}`, {});
		} catch {
			/* the next readiness poll re-derives the stage; a failed control just re-enables */
		} finally {
			busy = new Set([...busy].filter((k) => k !== bkey));
		}
	}

	// The two on-box stages carry co-located controls; the derived stages (cluster/describe/measure)
	// and import do not. Controls show when there is something to Stop (running) or to Resume/Restart
	// (paused) — never on a down/no-model block (nothing to stop) or a settled/pending stage.
	const CONTROLLED = new Set(['embed', 'categorize']);
	const hasControls = (stage: Stage) =>
		CONTROLLED.has(stage.key) && (stage.state === 'running' || stage.paused === true);
</script>

<!-- ⚠️ ALWAYS MOUNTED, and it must SAY SOMETHING for every overall — the design's core fix is that
     no pipeline state is ever both incomplete and silent. `unknown` is the fresh-process "we could
     not read yet" (held, never a fabricated state). Every other overall has an explicit arm, and a
     DEFAULT arm catches any value a later unit folds in (up-to-date/error/skipped from the generate
     store) so it renders rather than falling through to nothing. -->
<div class="pipe" role="status" aria-label="Pipeline status">
	<div class="pipe-overall" class:err={$pipeline.overall === 'error'} class:done={$pipeline.overall === 'done' || $pipeline.overall === 'up-to-date' || $pipeline.overall === 'skipped'}>
		{#if $pipeline.unknown}
			<span class="pipe-dot"></span>
			<span class="pipe-overall-text">Checking your pipeline…</span>
		{:else if $pipeline.overall === 'error'}
			<span class="pipe-dot err"></span>
			<span class="pipe-overall-text">Something went wrong in the pipeline.</span>
		{:else if $pipeline.overall === 'up-to-date' || $pipeline.overall === 'skipped'}
			<span class="pipe-dot done"></span>
			<span class="pipe-overall-text">Your map is already built.</span>
		{:else if $pipeline.overall === 'done'}
			<span class="pipe-dot done"></span>
			<span class="pipe-overall-text">Your pipeline is up to date.</span>
		{:else if $pipeline.overall === 'blocked'}
			<span class="pipe-dot warn"></span>
			<span class="pipe-overall-text">Waiting on you — {reasonText($pipeline.blockedOn ?? undefined) || 'action needed'}.</span>
		{:else if $pipeline.overall === 'running'}
			<span class="pipe-dot"></span>
			<span class="pipe-overall-text">Processing your data…</span>
		{:else if $pipeline.overall === 'idle'}
			<span class="pipe-dot idle"></span>
			<span class="pipe-overall-text">Waiting for data to arrive.</span>
		{:else}
			<!-- DEFAULT ARM — a value a later unit folds in (never a silent fall-through). -->
			<span class="pipe-dot"></span>
			<span class="pipe-overall-text">Working…</span>
		{/if}
	</div>

	<!-- The ordered stages, top-to-bottom, exactly as the server emits them. -->
	<ol class="pipe-stages">
		{#each $pipeline.stages as stage (stage.key)}
			{@const state = stage.state}
			<li class="pipe-stage" data-key={stage.key} data-state={state}>
				<span class="pipe-stage-icon" data-state={state} aria-hidden="true">
					{#if state === 'done'}✓{:else if state === 'blocked'}!{:else if state === 'running'}<span class="pipe-spin"></span>{:else}·{/if}
				</span>
				<div class="pipe-stage-body">
					<span class="pipe-stage-name">{labelFor(stage.key)}</span>

					{#if state === 'running'}
						<!-- Progress: counts + the reused activity-feed ETA (fmtSeconds). -->
						<span class="pipe-stage-detail running">
							{#if stage.count}{countText(stage.count)}{:else}Working…{/if}{#if stage.etaSeconds != null && stage.etaSeconds > 0} · ~{fmtSeconds(stage.etaSeconds)} left{/if}
						</span>
					{:else if state === 'blocked'}
						<!-- The remedy, inline: the reason text AND the action as a LIVE button (Unit 4).
						     Enabled; disabled ONLY while its own action is in-flight (aria-busy). The
						     GENERIC action (Intelligence/Generate/check) renders for every blocked reason
						     EXCEPT 'paused' — pause/resume is the co-located Stop/Resume control below, so a
						     paused stage shows Resume there, never a duplicate generic button. -->
						<span class="pipe-stage-detail blocked">{reasonText(stage.reason)}</span>
						{#if stage.action && stage.reason !== 'paused'}
							<span class="pipe-action-wrap">
								<button class="pipe-action" type="button" disabled={isBusy(`${stage.key}:action`)} aria-busy={isBusy(`${stage.key}:action`)} onclick={() => onAction(stage)}>{stage.action.label}</button>
							</span>
						{/if}
					{:else if state === 'done'}
						<span class="pipe-stage-detail done">{#if stage.count}{countText(stage.count)}{:else}Done{/if}</span>
					{:else}
						<!-- pending — muted; a pending reason (waiting_embed / map_unknown) says WHY it waits. -->
						<span class="pipe-stage-detail pending">{stage.reason ? reasonText(stage.reason) : 'Waiting'}</span>
					{/if}

					<!-- Co-located per-stage controls (R2/R3/N9): ONE two-state icon toggle (⏸ running → pause ·
					     ▶ paused → resume) + a small Restart icon, for the embed and categorize stages only,
					     whenever there is work to stop or a pause to lift. Each hits ITS OWN route so the two
					     stages pause independently. aria-label names the ACTION the click performs. -->
					{#if hasControls(stage)}
						<span class="pipe-ctrls">
							{#if stage.paused}
								<button class="pipe-ctrl icon" type="button" data-ctrl="resume" title="Resume {labelFor(stage.key)}" aria-label="Resume {labelFor(stage.key)}" disabled={isBusy(`${stage.key}:resume`)} aria-busy={isBusy(`${stage.key}:resume`)} onclick={() => onStageControl(stage, 'resume')}>
									<!-- ▶ play triangle → resume -->
									<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
								</button>
							{:else}
								<button class="pipe-ctrl icon" type="button" data-ctrl="pause" title="Pause {labelFor(stage.key)}" aria-label="Pause {labelFor(stage.key)}" disabled={isBusy(`${stage.key}:pause`)} aria-busy={isBusy(`${stage.key}:pause`)} onclick={() => onStageControl(stage, 'pause')}>
									<!-- ⏸ two-bar pause → pause -->
									<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
								</button>
							{/if}
							<button class="pipe-ctrl icon" type="button" data-ctrl="restart" title="Restart {labelFor(stage.key)}" aria-label="Restart {labelFor(stage.key)}" disabled={isBusy(`${stage.key}:restart`)} aria-busy={isBusy(`${stage.key}:restart`)} onclick={() => onStageControl(stage, 'restart')}>
								<!-- ↻ reload → re-queue gave-up rows -->
								<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
							</button>
						</span>
					{/if}
				</div>
			</li>
		{/each}
	</ol>
</div>

<style>
	.pipe {
		display: flex; flex-direction: column; gap: 0.6rem;
		padding: 0.7rem 0.8rem; border-radius: 10px;
		border: 1px solid var(--glass-border); background: var(--glass-card-bg);
	}

	/* ── The overall summary line ─────────────────────────────────────────────── */
	.pipe-overall { display: flex; align-items: center; gap: 0.5rem; }
	.pipe-overall-text { font-size: 0.74rem; color: var(--color-text-secondary); line-height: 1.4; }
	.pipe-overall.err .pipe-overall-text { color: var(--color-accent-coral, #f87171); }
	.pipe-overall.done .pipe-overall-text { color: var(--color-text-secondary); }
	.pipe-dot {
		width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
		background: var(--color-accent-aurum, #e5b84c); animation: pipe-pulse 1.6s ease-in-out infinite;
	}
	.pipe-dot.done { background: var(--color-accent-jade, #4ade80); animation: none; }
	.pipe-dot.warn { background: var(--color-accent-aurum, #e5b84c); animation: none; }
	.pipe-dot.err { background: var(--color-accent-coral, #f87171); animation: none; }
	.pipe-dot.idle { background: var(--color-text-tertiary); animation: none; }
	@keyframes pipe-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

	/* ── The ordered stage list ───────────────────────────────────────────────── */
	.pipe-stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
	.pipe-stage { display: flex; align-items: flex-start; gap: 0.5rem; }
	.pipe-stage-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.15rem; height: 1.15rem; flex-shrink: 0; margin-top: 0.05rem;
		border-radius: 50%; font-size: 0.66rem; font-family: var(--font-mono, monospace);
		border: 1px solid var(--glass-border); background: var(--glass-card-bg);
		color: var(--color-text-tertiary);
	}
	.pipe-stage-icon[data-state='done'] { color: var(--color-accent-jade, #4ade80); border-color: rgba(74, 222, 128, 0.4); }
	.pipe-stage-icon[data-state='blocked'] { color: var(--color-accent-aurum, #e5b84c); border-color: rgba(229, 184, 76, 0.4); }
	.pipe-stage-body { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
	.pipe-stage-name { font-size: 0.76rem; color: var(--color-text-primary); }
	.pipe-stage-detail { font-size: 0.68rem; line-height: 1.35; color: var(--color-text-secondary); }
	.pipe-stage-detail.pending { color: var(--color-text-tertiary); }
	.pipe-stage-detail.blocked { color: var(--color-accent-aurum, #e5b84c); }
	.pipe-stage-detail.done { color: var(--color-text-tertiary); }

	/* The running spinner — a tiny ring so a running stage reads as active at a glance. */
	.pipe-spin {
		width: 0.66rem; height: 0.66rem; border-radius: 50%;
		border: 2px solid var(--glass-border); border-top-color: var(--color-accent-aurum, #e5b84c);
		animation: pipe-rot 0.8s linear infinite;
	}
	@keyframes pipe-rot { to { transform: rotate(360deg); } }

	/* The inline remedy button — LIVE (Unit 4). Enabled + pointer; muted only while its own action
	   is in-flight (the busy `:disabled` state), then it re-enables. */
	.pipe-action-wrap { display: inline-flex; align-items: center; gap: 0.35rem; align-self: flex-start; margin-top: 0.2rem; }
	.pipe-action {
		padding: 0.2rem 0.6rem;
		border-radius: 6px; border: 1px solid var(--glass-border); background: var(--glass-card-bg);
		color: var(--color-text-primary); font-family: inherit; font-size: 0.68rem; cursor: pointer;
	}
	.pipe-action:hover:not(:disabled) { border-color: var(--color-accent-aurum, #e5b84c); }
	/* In-flight: non-interactive so it cannot double-fire; reads as busy, not broken. */
	.pipe-action:disabled { cursor: default; opacity: 0.55; }

	/* Co-located per-stage controls (R2/R3/N9): ONE two-state icon toggle (⏸/▶) + a small Restart (↻).
	   Icon-only, square, quiet — ongoing controls, not a blocking call to action. */
	.pipe-ctrls { display: inline-flex; align-items: center; gap: 0.3rem; align-self: flex-start; margin-top: 0.2rem; }
	.pipe-ctrl.icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.4rem; height: 1.4rem; padding: 0;
		border-radius: 6px; border: 1px solid var(--glass-border); background: transparent;
		color: var(--color-text-secondary); cursor: pointer;
	}
	.pipe-ctrl.icon svg { display: block; }
	.pipe-ctrl.icon:hover:not(:disabled) { border-color: var(--color-accent-aurum, #e5b84c); color: var(--color-text-primary); }
	.pipe-ctrl.icon:disabled { cursor: default; opacity: 0.55; }
</style>
