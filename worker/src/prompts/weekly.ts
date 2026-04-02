/**
 * Weekly review prompt
 * Sent on Sunday evening (configurable)
 */

export interface WeeklyContext {
  userName: string;
  weekNumber: number;
  messageCount: number;
  topTags: Array<{ tag: string; count: number }>;
  mentionedPeople: string[];
  completedTasks: number;
  openTasks: number;
  newInsights: string[];
  dreamCount: number;
  moodTrend: string | null;
}

export function buildWeeklyPrompt(context: WeeklyContext): string {
  const {
    userName,
    weekNumber,
    messageCount,
    topTags,
    mentionedPeople,
    completedTasks,
    openTasks,
    newInsights,
    dreamCount,
    moodTrend,
  } = context;

  const tagSummary = topTags.length > 0
    ? topTags.slice(0, 5).map((t) => `${t.tag} (${t.count})`).join(", ")
    : "No dominant themes";

  const peopleSummary = mentionedPeople.length > 0
    ? mentionedPeople.slice(0, 5).join(", ")
    : "No one mentioned specifically";

  const insightsSummary = newInsights.length > 0
    ? newInsights.map((i) => `- ${i}`).join("\n")
    : "No new insights logged";

  const moodSummary = moodTrend || "No mood data";

  return `# Week ${weekNumber} Review

Hey ${userName}, here's a snapshot of your week:

## Activity
- ${messageCount} messages exchanged
- ${completedTasks} tasks completed, ${openTasks} still open
- ${dreamCount} dreams logged

## Themes
${tagSummary}

## People
${peopleSummary}

## New Insights
${insightsSummary}

## Mood Trend
${moodSummary}

---

Looking back at this week, what stands out to you? Is there anything you want to carry forward or let go of?`;
}

/**
 * Prompt for generating weekly patterns (for autonomous reflection)
 */
export function buildWeeklyPatternPrompt(
  weekMessages: string,
  previousPatterns: string
): string {
  return `Review this week's conversation patterns:

${weekMessages}

Previous noted patterns:
${previousPatterns || "None yet"}

Identify:
1. Any recurring themes or topics
2. Shifts in mood or energy
3. Progress or regression on goals
4. New interests or concerns emerging
5. Relationship dynamics mentioned

Be observational, not conclusive. Note patterns with appropriate uncertainty.
Respond in bullet points, keeping each observation to 1-2 sentences.`;
}
