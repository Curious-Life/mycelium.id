// portal-app/src/lib/stage-count.ts — how a pipeline stage renders its own count.
//
// WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE PipelineStatus.svelte. It was one, and the gate
// written for it could only pattern-match the component's SOURCE — "is there a unit map?", "is the
// key passed?" — never what the function actually returned. Mutation-testing caught that
// immediately: gutting the function to `return done;` left every assertion green, because a source
// that MENTIONS a unit and a function that USES one are different claims. That is the same defect
// verify:stage-accounting's coverage check had (a file that merely mentioned `createStageResult`
// passed while writing nothing), and the same one D-014 is named for.
//
// Extracted so scripts/verify-map-freshness.mjs can IMPORT it and drive real inputs through it.
// A behavioural assertion cannot be satisfied by a comment.

/**
 * P8b — A ROW NAMES ITS OWN UNIT. The operator's words: "it shouldnt say conversations, it should
 * say points."
 *
 * ⚠️ THE UNDERLYING BUG WAS A CATEGORY ERROR, NOT A CONTRADICTION. The retired MapFreshness card
 * rendered "{embedded} conversations ready · {mapped} on the map" — one sentence fusing TWO
 * DIFFERENT TABLES: `messages` carrying an embedding_768, and `clustering_points` carrying a
 * landscape_x. cluster.py does not emit one point per embedded message, so those numbers are not
 * two views of one quantity and were never meant to be compared by eye. That is how a perfectly
 * healthy vault could read "0 conversations ready · 1014 on the map" and look broken.
 *
 * Each row now states ONLY the quantity it is about: `embed` counts messages, `cluster` counts
 * points. The relationship between them is expressed ONCE, as drift, in words that name it.
 */
export const STAGE_UNIT: Record<string, string> = { cluster: 'point' };

/**
 * P8c — WHAT A STAGE PRODUCES, for stages whose NAME is a verb the UI uses elsewhere for a
 * different job.
 *
 * "Describe" is the offender. Step 3 of run-clustering.sh runs BOTH `describe-clusters.js`
 * (the only writer of realm/territory NAMES, :177) and, conditionally, `describe-chronicles.js`
 * (which writes PROSE and deliberately preserves names, :185). Meanwhile the mindscape detail
 * panel offers "Name your areas" — the naming half, gap-fill, whole map — and a per-area
 * "Add more detail" — the chronicle half, one area. Three surfaces, one word, three scopes, and
 * nothing on screen said which was which.
 *
 * ⚠️ THE OBVIOUS FIX WAS WRONG, AND ONLY READING THE SCRIPT CAUGHT IT. Renaming the row to
 * "Name" — on the reasoning that describe-clusters is the sole writer of names — would have been
 * a false claim about a stage that runs both halves. The row therefore keeps its name and states
 * its OUTPUT, which is what a reader is trying to infer from the label in the first place.
 */
export const STAGE_PRODUCES: Record<string, string> = { describe: 'Names and descriptions' };

/** The output line for a settled stage, or '' when the stage has nothing extra to declare. */
export function producesText(key?: string): string {
  return (key && STAGE_PRODUCES[key]) || '';
}

/**
 * "3,200 / 76,000" — counts only, localised. Absent total ⇒ a bare done count, which is where a
 * unit is both meaningful and unambiguous (a "done / total" pair already reads as a ratio, so
 * appending a noun to it would read as a rate).
 */
export function countText(c?: { done: number; total?: number }, key?: string): string {
  if (!c) return '';
  const n = c.done ?? 0;
  const done = n.toLocaleString();
  if (c.total != null) return `${done} / ${c.total.toLocaleString()}`;
  const unit = key ? STAGE_UNIT[key] : undefined;
  if (!unit) return done;
  return `${done} ${n === 1 ? unit : `${unit}s`}`;
}

/**
 * P8b — the drift note. `drift` counts MESSAGES not yet represented on the map; the row's own
 * count is POINTS. The copy therefore never subtracts one from the other or presents them as a
 * pair — it names what each is. "new to place" is the honest verb: those messages are waiting for
 * a run that will place them, however many points that turns out to produce.
 */
export function driftNote(drift?: number): string {
  return drift && drift > 0 ? `${drift.toLocaleString()} new to place` : '';
}
