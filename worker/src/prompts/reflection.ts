/**
 * Autonomous reflection prompt
 * Run 1-3 times daily to update internal model
 */

export interface ReflectionContext {
  recentMessages: string;
  masterIndex: string;
  internalModelSummary: string;
  currentHypotheses: string[];
  openQuestions: string[];
  lastReflection: string | null;
  // Optional topology context for deeper reflection
  topology?: {
    recentTerritories?: Array<{ name: string; message_count: number }>;
    topGaps?: Array<{ territory_a_name: string; territory_b_name: string; gap_score: number }>;
    unexpectedConnections?: Array<{ territory_a_name: string; territory_b_name: string }>;
    orphans?: Array<{ name: string; message_count: number }>;
  };
}

export function buildReflectionPrompt(context: ReflectionContext): string {
  const {
    recentMessages,
    internalModelSummary,
    currentHypotheses,
    openQuestions,
    lastReflection,
    topology,
  } = context;

  const hypothesesSection = currentHypotheses.length > 0
    ? currentHypotheses.map((h) => `- ${h}`).join("\n")
    : "None yet";

  const questionsSection = openQuestions.length > 0
    ? openQuestions.map((q) => `- ${q}`).join("\n")
    : "None yet";

  const lastReflectionSection = lastReflection
    ? `Last reflection: ${lastReflection}`
    : "No previous reflection";

  // Build topology section if available
  let topologySection = "";
  if (topology) {
    const parts: string[] = [];

    if (topology.recentTerritories && topology.recentTerritories.length > 0) {
      const territories = topology.recentTerritories
        .slice(0, 5)
        .map((t) => `- ${t.name} (${t.message_count} messages)`)
        .join("\n");
      parts.push(`**Recent territories:**\n${territories}`);
    }

    if (topology.topGaps && topology.topGaps.length > 0) {
      const gaps = topology.topGaps
        .slice(0, 3)
        .map((g) => `- ${g.territory_a_name} ↔ ${g.territory_b_name}`)
        .join("\n");
      parts.push(`**Unexplored gaps (high semantic, low co-fire):**\n${gaps}`);
    }

    if (topology.unexpectedConnections && topology.unexpectedConnections.length > 0) {
      const connections = topology.unexpectedConnections
        .slice(0, 3)
        .map((c) => `- ${c.territory_a_name} ↔ ${c.territory_b_name}`)
        .join("\n");
      parts.push(`**Unexpected connections (low semantic, high co-fire):**\n${connections}`);
    }

    if (topology.orphans && topology.orphans.length > 0) {
      const orphans = topology.orphans
        .slice(0, 3)
        .map((o) => `- ${o.name} (${o.message_count} messages, isolated)`)
        .join("\n");
      parts.push(`**Isolated territories:**\n${orphans}`);
    }

    if (parts.length > 0) {
      topologySection = `\n\n## Mental Geography\n${parts.join("\n\n")}`;
    }
  }

  return `# Autonomous Reflection

You are reflecting on recent conversations to update your understanding.
This is a private process - the user won't see this directly.

## Recent Messages (last 24-48h)
${recentMessages}

## Current Understanding
${internalModelSummary}

## Working Hypotheses
${hypothesesSection}

## Open Questions
${questionsSection}

## ${lastReflectionSection}${topologySection}

---

Reflect on what you've observed. Consider:

1. **Patterns**: What recurring themes, behaviors, or concerns do you notice?
2. **Contradictions**: Anything that doesn't fit your current model?
3. **Questions**: What would you like to understand better?
4. **Hypotheses**: Any tentative observations (with appropriate uncertainty)?
5. **Flag for discussion**: Anything important enough to bring up next conversation?${topology ? "\n6. **Topology insights**: What does the mental geography reveal?" : ""}

Output format:
- observations: [list of observations]
- updates_to_model: [specific updates to make]
- new_questions: [questions to add]
- flag_for_discussion: [topic] or null
- reflection_summary: [1-2 sentence summary]${topology ? "\n- topology_note: [structural observation] or null" : ""}

Be curious, not conclusive. Note patterns without assuming their meaning.`;
}

/**
 * Lightweight reflection for quick updates
 */
export function buildQuickReflectionPrompt(recentMessages: string): string {
  return `Quick reflection on recent messages:

${recentMessages}

In 2-3 bullet points, note:
- Any notable patterns or themes
- Anything that seems important to remember
- Questions to explore later

Keep observations tentative and curious.`;
}
