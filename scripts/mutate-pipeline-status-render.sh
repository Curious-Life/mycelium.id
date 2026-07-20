#!/usr/bin/env bash
# mutate-pipeline-status-render.sh — mutation-falsification for verify:pipeline-status-render.
#
# A render assertion that no MUTATION can red is decoration ([[gates-fail-on-fixtures-not-assertions]]).
# For each load-bearing render, this mutates PipelineStatus.svelte so that state renders NOTHING (or
# the wrong thing), runs the gate, and PROVES the gate goes RED. Then it RESTORES the component from a
# cp snapshot — NEVER `git checkout --` ([[never-destructive-git]]). If any mutation leaves the gate
# GREEN, that is a hole and this script exits 1.
#
# Run from repo root:  bash scripts/mutate-pipeline-status-render.sh
set -u
COMP="portal-app/src/lib/components/mindscape/PipelineStatus.svelte"
SNAP="$(mktemp -t pipeline-status-comp.XXXXXX)"
cp "$COMP" "$SNAP"
restore() { cp "$SNAP" "$COMP"; }
trap 'restore; rm -f "$SNAP"' EXIT

fail=0
# $1 = human name, $2 = find string, $3 = replace string
mutate_and_expect_red() {
  local name="$1" find="$2" repl="$3"
  restore
  FIND="$find" REPL="$repl" node -e '
    const fs=require("fs"); const p=process.env.COMP;
    const s=fs.readFileSync(p,"utf8");
    if(!s.includes(process.env.FIND)){ console.error("ANCHOR MISSING: "+process.env.FIND); process.exit(2); }
    fs.writeFileSync(p, s.replace(process.env.FIND, process.env.REPL));
  ' || { echo "SKIP  $name — anchor not found (component changed?)"; fail=1; restore; return; }
  # The gate MUST red on the mutated component.
  if MYCELIUM_SKIP_WRITER_LOCK=1 npm run verify:pipeline-status-render --silent >/dev/null 2>&1; then
    echo "HOLE  $name — the gate stayed GREEN on a mutation that breaks this render"
    fail=1
  else
    echo "CAUGHT $name — the gate went RED (assertion is load-bearing)"
  fi
  restore
}
export COMP

echo "── mutation-falsifying verify:pipeline-status-render ──"

# R3 — a running stage's counts + ETA. Delete the render ⇒ running shows nothing.
mutate_and_expect_red "R3 running counts+ETA" \
  '{#if stage.count}{countText(stage.count)}{:else}Working…{/if}{#if stage.etaSeconds != null && stage.etaSeconds > 0} · ~{fmtSeconds(stage.etaSeconds)} left{/if}' \
  ''

# R4 — a blocked stage's action button. Delete it ⇒ the remedy label is gone.
mutate_and_expect_red "R4 blocked action button" \
  '<button class="pipe-action" type="button" disabled={isBusy(`${stage.key}:action`)} aria-busy={isBusy(`${stage.key}:action`)} onclick={() => onAction(stage)}>{stage.action.label}</button>' \
  '<span></span>'

# R4b — the blocked action must render LIVE (enabled at rest). Pin it always-disabled ⇒ it reverts
# to the "soon" dead control Unit 4 deletes.
mutate_and_expect_red "R4b blocked action enabled (live)" \
  'disabled={isBusy(`${stage.key}:action`)} aria-busy={isBusy(`${stage.key}:action`)}' \
  'disabled aria-busy="true"'

# R4c — the co-located per-stage controls (Stop/Resume + Restart). Remove the whole cluster ⇒ a
# running stage has no Stop and a paused stage no Resume (R2/R3 regress to the un-controllable state).
mutate_and_expect_red "R4c per-stage control cluster" \
  '{#if hasControls(stage)}' \
  '{#if false && hasControls(stage)}'

# W2 — the generate wiring. Break start() ⇒ a generate click fires nothing (or the wrong thing).
mutate_and_expect_red "W2 generate wiring (start)" \
  "} else if (target === 'generate') {" \
  "} else if (target === 'generate' && false) {"

# W3 / W5 — the per-stage control wiring (Stop/Resume/Restart). Break the control POST ⇒ a Stop,
# Resume or Restart click no longer hits its per-stage route.
mutate_and_expect_red "W3/W5 per-stage control POST" \
  'await apiPost(`/portal/enrichment/${stage.key}/${kind}`, {});' \
  '/* control POST removed */;'

# W1 — the intelligence wiring. Break the nav ⇒ an intelligence click no longer navigates.
mutate_and_expect_red "W1 intelligence wiring (goto)" \
  "await goto('/settings?tab=intelligence');" \
  '/* goto removed */;'

# W4 — the busy-guard. Remove the in-flight check ⇒ a double-click double-fires the remedy.
mutate_and_expect_red "W4 busy-guard (double-fire)" \
  '!target || busy.has(bkey)' \
  '!target'

# R2 / R7 — the done ✓ icon. Drop it ⇒ a done stage renders no settled mark.
mutate_and_expect_red "R2/R7 done ✓ icon" \
  '{#if state === '"'"'done'"'"'}✓' \
  '{#if state === '"'"'done'"'"'}'

# R5 — the overall:error arm. Neuter its copy ⇒ error renders as silence-equivalent.
mutate_and_expect_red "R5 overall error render" \
  'Something went wrong in the pipeline.' \
  '…'

# R6 — the overall:up-to-date arm. Neuter its copy ⇒ up-to-date no longer names itself.
mutate_and_expect_red "R6 overall up-to-date render" \
  'Your map is already built.' \
  '…'

# R2 — a pending stage's muted "Waiting". Blank it ⇒ a pending stage renders an empty row.
mutate_and_expect_red "R2 pending waiting copy" \
  ": 'Waiting'}" \
  ": ''}"

echo "──"
if [ "$fail" -eq 0 ]; then
  echo "VERDICT: GO — every load-bearing render assertion is falsifiable (each mutation reds the gate)"
else
  echo "VERDICT: NO-GO — a mutation slipped through (see HOLE/SKIP rows above)"
fi
exit "$fail"
