export const meta = {
  name: 'autonomous-build-loop',
  description:
    'Concurrency-aware plan→build→gate→adversarial+security review→loop-till-green→land for Mycelium V1, per docs/AUTONOMOUS-ROUTINE.md. Surveys in-flight work, coexists with other sessions, runs in its own claude/auto-loop/* branch namespace, never touches the main checkout. Opt-in; returns recommendations, never merges directly.',
  phases: [
    { title: 'Survey', detail: 'read-only world state: branches, worktrees, dirty files, handoff in-progress' },
    { title: 'Resume', detail: 'finish the loop’s own unmerged work before starting anything new' },
    { title: 'Plan', detail: 'recon each picked unit; declare files; re-check for collisions' },
    { title: 'Build', detail: 'one isolated worktree per unit off the committed base (parallel)' },
    { title: 'Gate', detail: 'npm run verify must be all GO' },
    { title: 'Review', detail: 'adversarial refuters x {correctness, security, reproduce}' },
    { title: 'Converge', detail: 'fix → re-gate → re-review until one clean round' },
    { title: 'Land', detail: 'own claude/auto-loop/<unit> branch + PR + eligibility recommendation' },
  ],
}

// --- Options (object OR JSON string; the runtime may hand args through either) -
const OPTS = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : args || {}
const MAX_UNITS = Number(OPTS.maxUnits) || 4
const MAX_CONVERGE_ROUNDS = 3
const REFUTERS_PER_LENS = Number(OPTS.refutersPerLens) || 1 // bump to 2–3 for an audit-grade pass
const REVIEW_LENSES = ['correctness', 'security', 'reproduce']
const LOOP_NS = 'claude/auto-loop' // this loop owns this branch namespace
const SECURITY_SURFACES =
  'crypto/keys, auth/OAuth, the encryption adapter or ENCRYPTED_FIELDS, RLS/tenant scoping, egress chokepoints, DB migrations'

// The gate is "no NEW failures beyond the environmental baseline", NOT "all 234
// suites green". Many verify:* suites fail in a dev box because Ollama / the
// embed-service (:8091) / onnxruntime are not running — those are pre-existing
// and not a unit's fault. green=true iff the unit introduces ZERO regressions
// AND its own new check passes. Reused by the build gate, the re-gate, and resume.
const GATE_INSTRUCTION = `Run the targeted verify:* for the changed surface, then the FULL suite: npm run verify.
   Classify EVERY failing suite as one of:
     - ENVIRONMENTAL: fails only because Ollama / embed-service (:8091) / onnxruntime are unavailable
       (ECONNREFUSED, "Ollama", model-load errors) — pre-existing, NOT caused by this unit.
     - REGRESSION: this unit broke a suite that passes on the committed base, OR the unit's OWN new
       verify check fails.
   green=true ONLY if there are ZERO regressions AND the unit's own new verify check passes.
   Environmental failures do NOT block. List failingSuites split into envGatedFailures vs regressions,
   each with the evidence line. Never edit code in this step.`

// --- Schemas --------------------------------------------------------------
const WORLD = {
  type: 'object',
  required: ['baseRef', 'baseBranch', 'claimedFiles', 'candidates'],
  properties: {
    baseRef: { type: 'string', description: 'committed SHA to build from (current branch HEAD; NOT the dirty working tree)' },
    baseBranch: { type: 'string', description: 'integration branch units PR into (default: the current branch)' },
    currentBranch: { type: 'string' },
    headVsOrigin: { type: 'string', description: 'ahead/behind/equal' },
    dirtyMainFiles: { type: 'array', items: { type: 'string' }, description: 'uncommitted files in the main checkout (another session’s WIP — never touch)' },
    concurrentStreams: {
      type: 'array',
      description: 'active work elsewhere: dirty-main groups, other recently-active branches, other worktrees',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['dirty-main', 'branch', 'worktree'] },
          branch: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
    },
    claimedFiles: { type: 'array', items: { type: 'string' }, description: 'union of files under active concurrent work — avoid these' },
    inProgressUnits: {
      type: 'array',
      description: 'units other sessions are mid-way on, from the handoff doc (do not duplicate)',
      items: { type: 'object', properties: { id: { type: 'string' }, owner: { type: 'string' }, note: { type: 'string' } } },
    },
    resumable: {
      type: 'array',
      description: 'THIS loop’s own unfinished work: claude/auto-loop/* branches or worktrees with unmerged commits',
      items: {
        type: 'object',
        required: ['id', 'location'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string', description: 'branch name or worktree path' },
          state: { type: 'string', description: 'committed-unmerged | uncommitted | gated' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'buildable', 'envGated', 'securitySensitive', 'files', 'collides'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          buildable: { type: 'boolean' },
          envGated: { type: 'boolean' },
          securitySensitive: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' }, description: 'best-effort target files' },
          collides: { type: 'boolean', description: 'true if files overlap claimedFiles or inProgressUnits' },
        },
      },
    },
  },
}
const PLAN = {
  type: 'object',
  required: ['unitId', 'approach', 'gate', 'files'],
  properties: {
    unitId: { type: 'string' },
    approach: { type: 'string' },
    gate: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'the actual files this unit will touch (refined from recon)' },
  },
}
const BUILD = {
  type: 'object',
  required: ['unitId', 'worktree', 'committed', 'summary'],
  properties: {
    unitId: { type: 'string' },
    worktree: { type: 'string' },
    committed: { type: 'boolean' },
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
  },
}
const GATE = {
  type: 'object',
  required: ['unitId', 'green'],
  properties: {
    unitId: { type: 'string' },
    green: { type: 'boolean', description: 'zero regressions AND the unit’s own new check passes (environmental failures excluded)' },
    regressions: { type: 'array', items: { type: 'string' }, description: 'suites this unit broke, or its own failing new check' },
    envGatedFailures: { type: 'array', items: { type: 'string' }, description: 'pre-existing environmental failures (Ollama/:8091/onnxruntime down) — not blocking' },
  },
}
const VERDICT = {
  type: 'object',
  required: ['lens', 'real'],
  properties: {
    lens: { type: 'string' },
    real: { type: 'boolean' },
    finding: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  },
}
const SCORE = {
  type: 'object',
  required: ['unitId', 'score', 'justification', 'recommendation'],
  properties: {
    unitId: { type: 'string' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    justification: { type: 'string' },
    recommendation: { type: 'string', enum: ['auto-merge-eligible', 'pr-for-human', 'discarded'] },
    branch: { type: 'string' },
    prUrl: { type: 'string' },
  },
}

// --- 0. SURVEY (read-only; a dirty tree is mapped, NOT a stop condition) ---
phase('Survey')
const world = await agent(
  `You are the SURVEY step of docs/AUTONOMOUS-ROUTINE.md. READ-ONLY: run only inspection commands
   (git status/branch/log/worktree/for-each-ref, reads). Do NOT checkout, pull, stage, commit, or edit
   anything — other sessions may be mid-task in the main checkout.
   Gather the world state so this loop can coexist with concurrent work:
   1. baseRef = the CURRENT branch's committed HEAD (git rev-parse HEAD). We build on committed work and
      IGNORE the dirty working tree. baseBranch = ${OPTS.baseBranch ? `"${OPTS.baseBranch}"` : 'the current branch'} (PR target). currentBranch, headVsOrigin.
   2. dirtyMainFiles = git status --porcelain paths (another session's WIP — record, never touch).
   3. concurrentStreams = group the dirty files by feature, plus other LOCAL/REMOTE branches active
      recently (git for-each-ref --sort=-committerdate) and any existing git worktrees. For each, list
      the files it touches.
   4. claimedFiles = the UNION of files under active concurrent work (dirty main + files changed on other
      recently-active branches vs baseRef). This is the territory to avoid.
   5. inProgressUnits = units OTHER sessions are mid-way on, from the bottom of
      docs/V1-BUILD-HANDOFF-2026-05-30.md (don't duplicate them).
   6. resumable = THIS loop's own unfinished work: any ${LOOP_NS}/* branch (or worktree) with commits not
      merged into baseBranch, or a worktree with uncommitted changes. List its files + state.
   7. candidates = the "remaining/next" buildable units from the handoff. For each: tag buildable (no real
      ML / platform tokens / deploy), envGated (onnxruntime/Ollama/:8091, deploy, real OAuth),
      securitySensitive (${SECURITY_SURFACES}); recon its likely target files; set collides=true if those
      files intersect claimedFiles OR it matches an inProgressUnits id.
   Return the full WORLD map. Build NOTHING.`,
  { schema: WORLD, phase: 'Survey' },
)

if (!world) {
  log('Survey agent failed — cannot map the repo safely. Ending without touching anything.')
  return { ended: 'survey-failed' }
}
const baseRef = world.baseRef
const baseBranch = world.baseBranch
log(
  `Survey: base=${baseRef && baseRef.slice(0, 8)} on ${baseBranch}; ` +
    `${(world.dirtyMainFiles || []).length} dirty main file(s), ` +
    `${(world.concurrentStreams || []).length} concurrent stream(s), ` +
    `${(world.resumable || []).length} resumable, ` +
    `${(world.candidates || []).length} candidate(s).`,
)

const claimed = new Set(world.claimedFiles || [])

// --- 1. RESUME — finish the loop's own unmerged work first ----------------
// A unit picked up here returns the same {unit, build, gate} shape as a fresh
// build so it flows through Review/Converge/Land identically.
phase('Resume')
let live = []
for (const r of world.resumable || []) {
  const resumed = await agent(
    `RESUME the loop's own unfinished unit "${r.id}" at ${r.location} (state: ${r.state}). Work ONLY in
     that branch/worktree — never the main checkout. Ensure its changes are committed, then GATE it.
     ${GATE_INSTRUCTION}`,
    { label: `resume:${r.id}`, phase: 'Resume', schema: GATE, isolation: 'worktree' },
  ).then((gate) => ({
    unit: { id: r.id, title: r.title || r.id, securitySensitive: false, files: r.files || [] },
    build: { unitId: r.id, worktree: r.location, committed: true, summary: `resumed ${r.id}` },
    gate,
  }))
  if (resumed && resumed.build && resumed.build.committed) live.push(resumed)
}
if (live.length) log(`Resumed ${live.length} of the loop's own unit(s) for review/land.`)

// --- 2. PICK — collision-aware, never duplicate concurrent work -----------
const picked = (world.candidates || [])
  .filter((u) => u.buildable && !u.envGated && !u.collides)
  .slice(0, MAX_UNITS)
const skipped = (world.candidates || []).filter((u) => u.buildable && !u.envGated && u.collides)
if (skipped.length) log(`Skipped ${skipped.length} unit(s) colliding with active work: ${skipped.map((u) => u.id).join(', ')}`)

if (!picked.length && !live.length) {
  log('No non-colliding buildable units and nothing to resume. Clean no-op (success). Leave a handoff note.')
  return { ended: 'no-safe-work', baseBranch, skipped: skipped.map((u) => u.id), inProgress: world.inProgressUnits }
}
if (picked.length) log(`Picked ${picked.length} non-colliding unit(s): ${picked.map((u) => u.id).join(', ')}`)

// --- 3. PLAN → BUILD → GATE (pipelined per unit; off the committed base) ---
// Each unit builds in its own worktree branched from baseRef (a committed ref —
// so the worktree is clean even while the main checkout is dirty). PLAN re-checks
// collisions against claimedFiles now that real files are known.
phase('Plan')
const built = await pipeline(
  picked,
  (u) =>
    agent(
      `PLAN unit "${u.id}" (${u.title}). Recon the real code first (file:line), find the contract +
       footguns, return the approach, the falsifiable verify-*.mjs gate, and the EXACT files it will touch.
       Do NOT write code.`,
      { label: `plan:${u.id}`, phase: 'Plan', schema: PLAN },
    ),
  (plan, u) => {
    // Post-plan collision guard: if the real files overlap claimed territory, abort this unit.
    const hit = (plan && plan.files ? plan.files : u.files || []).filter((f) => claimed.has(f))
    if (hit.length) {
      log(`Unit ${u.id}: aborting — real files collide with active work (${hit.join(', ')}).`)
      return null // drops the rest of the pipeline for this item
    }
    return agent(
      `BUILD unit "${u.id}" in an ISOLATED git worktree branched from ${baseRef} (the committed base —
       do NOT pull in the main checkout's uncommitted changes). Plan: ${plan ? plan.approach : '(recon yourself)'}.
       Gate to add: ${plan ? plan.gate : 'a verify-*.mjs covering the new behavior'}. Match surrounding
       style; obey CLAUDE.md security rules (fail closed, never log plaintext, no --no-verify/--force).
       Wire the new verify-*.mjs into the npm run verify chain. Commit on the worktree branch. Return the
       worktree path + summary + files touched.`,
      { label: `build:${u.id}`, phase: 'Build', schema: BUILD, isolation: 'worktree' },
    )
  },
  // Gate is last → it MUST return the accumulated {unit, build, gate} (pipeline
  // yields only the final stage's value).
  (build, u) => {
    if (!build) return null
    return agent(
      `GATE unit "${u.id}" in worktree ${build.worktree}. ${GATE_INSTRUCTION}`,
      { label: `gate:${u.id}`, phase: 'Gate', schema: GATE, isolation: 'worktree' },
    ).then((gate) => ({ unit: u, build, gate }))
  },
)

live = live.concat((built || []).filter((x) => x && x.build && x.build.committed))
if (!live.length) {
  log('Nothing built or resumed successfully. Clean no-op.')
  return { ended: 'nothing-built', baseBranch }
}

// --- 4. REVIEW + 5. CONVERGE (adversarial, loop-till-green) ----------------
async function reviewUnit(unit, build) {
  const tasks = []
  for (const lens of REVIEW_LENSES) {
    for (let k = 0; k < REFUTERS_PER_LENS; k++) {
      tasks.push(() =>
        agent(
          `Adversarially REVIEW unit "${unit.id}" via the ${lens.toUpperCase()} lens, in worktree
           ${build.worktree}. Diff summary: ${build.summary}. Your job is to REFUTE — find a genuine defect.
           ${lens === 'security' ? `Security lens: check ${SECURITY_SURFACES}, plaintext/embedding leakage, fail-open paths, egress outside the chokepoint.` : ''}
           ${lens === 'reproduce' ? 'Reproduce lens: does the added verify check actually exercise the new behavior, or pass vacuously?' : ''}
           Set real=true ONLY for a genuine defect; default real=false when unsure.`,
          { label: `review:${unit.id}:${lens}`, phase: 'Review', schema: VERDICT },
        ),
      )
    }
  }
  return (await parallel(tasks)).filter(Boolean).filter((v) => v.real)
}

phase('Review')
for (const item of live) {
  let round = 0
  let confirmed =
    item.gate && item.gate.green
      ? await reviewUnit(item.unit, item.build)
      : [{ lens: 'gate', real: true, severity: 'high', finding: `Gate regressions: ${((item.gate && item.gate.regressions) || ['unknown']).join(', ')}` }]
  while (confirmed.length && round < MAX_CONVERGE_ROUNDS) {
    round++
    phase('Converge')
    log(`Unit ${item.unit.id}: round ${round}, ${confirmed.length} finding(s) → fix + re-gate + re-review`)
    const findings = confirmed.map((f) => `[${f.lens}/${f.severity || '?'}] ${f.finding}`).join('\n')
    const fix = await agent(
      `FIX the confirmed findings for unit "${item.unit.id}" in worktree ${item.build.worktree}, then commit.
       Findings:\n${findings}\nDo not weaken the gate to force a pass.`,
      { label: `fix:${item.unit.id}:r${round}`, phase: 'Converge', schema: BUILD, isolation: 'worktree' },
    )
    const gate = await agent(
      `Re-GATE unit "${item.unit.id}" in worktree ${item.build.worktree}. ${GATE_INSTRUCTION}`,
      { label: `regate:${item.unit.id}:r${round}`, phase: 'Converge', schema: GATE, isolation: 'worktree' },
    )
    if (!gate || !gate.green) {
      log(`Unit ${item.unit.id}: re-gate red after fix — discarding.`)
      item.discard = true
      confirmed = []
      break
    }
    if (fix && fix.summary) item.build.summary = fix.summary
    confirmed = await reviewUnit(item.unit, item.build)
  }
  if (confirmed.length) {
    log(`Unit ${item.unit.id}: did not converge in ${MAX_CONVERGE_ROUNDS} rounds — discard, needs your call.`)
    item.discard = true
  }
}

// --- 6. LAND — own claude/auto-loop/<unit> branch; PR to baseBranch --------
phase('Land')
const landed = await parallel(
  live.map((item) => () => {
    if (item.discard) {
      return Promise.resolve({
        unitId: item.unit.id,
        score: 0,
        justification: 'did not converge / re-gate red — discarded',
        recommendation: 'discarded',
      })
    }
    return agent(
      `SCORE + LAND unit "${item.unit.id}" (worktree ${item.build.worktree}, ${item.unit.securitySensitive ? 'SECURITY-SENSITIVE' : 'non-sensitive'}).
       This loop owns the ${LOOP_NS}/* namespace; it must NOT push to ${baseBranch} or any other session's branch.
       1. Create/update branch ${LOOP_NS}/${item.unit.id} from ${baseRef} and apply this unit's worktree commit(s) onto it.
       2. Score 0–100 for "correct, complete, safe to land unattended" per the rubric in docs/AUTONOMOUS-ROUTINE.md, one-line justification.
       3. git push -u origin ${LOOP_NS}/${item.unit.id}; open or update a PR into ${baseBranch} (gh).
       4. recommendation: 'auto-merge-eligible' ONLY if score >= 85 AND NOT securitySensitive; else 'pr-for-human'
          (security-sensitive ALWAYS = 'pr-for-human').
       Do NOT merge. Do NOT invoke auto-merge-on-green. Return the branch + PR url.`,
      { label: `land:${item.unit.id}`, phase: 'Land', schema: SCORE, isolation: 'worktree' },
    )
  }),
)

const results = (landed || []).filter(Boolean)
const eligible = results.filter((r) => r.recommendation === 'auto-merge-eligible')
log(
  `Done. ${results.length} unit(s) processed; ${eligible.length} auto-merge-eligible, ` +
    `${results.filter((r) => r.recommendation === 'pr-for-human').length} need a human, ` +
    `${results.filter((r) => r.recommendation === 'discarded').length} discarded. ` +
    `Skipped (collision): ${skipped.map((u) => u.id).join(', ') || 'none'}.`,
)

return {
  baseBranch,
  baseRef,
  results,
  autoMergeEligiblePRs: eligible.map((r) => r.prUrl).filter(Boolean),
  skippedForCollision: skipped.map((u) => u.id),
  inProgressElsewhere: world.inProgressUnits,
  next: 'Invoke auto-merge-on-green for autoMergeEligiblePRs; append a handoff entry per unit.',
}
