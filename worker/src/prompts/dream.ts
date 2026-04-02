/**
 * Dream/deep reflection prompt
 * Run at 3am for deep processing and integration
 *
 * Three-phase process:
 * 1. Free association (high temperature, no structure) - NO topology data
 * 2. Grounded reflection (topology-aware) - inject spatial data
 * 3. Directed exploration (optional) - active traversal with budget
 */

export interface DreamContext {
  recentMessages: string;
  dreamsLogged: string[];
  synchronicities: string[];
  currentHypotheses: string[];
  openQuestions: string[];
  internalModelContent: string;
  masterIndex: string;
  todayTags: string[];
}

// Topology data for Phase 2 (grounded reflection)
export interface TopologyContext {
  todayTerritories: Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    realm_name: string | null;
    message_count: number;
  }>;
  unexpectedConnections: Array<{
    territory_a_name: string;
    territory_b_name: string;
    semantic_similarity: number;
    cofire_strength: number;
  }>;
  gaps: Array<{
    territory_a_name: string;
    territory_b_name: string;
    semantic_similarity: number;
    cofire_strength: number;
    gap_score: number;
  }>;
  orphans: Array<{
    name: string;
    essence: string | null;
    message_count: number;
    connection_count: number;
  }>;
  bridges: Array<{
    name: string;
    connected_realms: number;
    total_strength: number;
  }>;
  territoryFlow: Array<{
    name: string;
    timestamp: string;
  }>;
  topologyNotesContent: string;
}

export function buildDreamPrompt(context: DreamContext, ownerName = "User"): string {
  const {
    recentMessages,
    dreamsLogged,
    synchronicities,
    currentHypotheses,
    openQuestions,
    internalModelContent,
    masterIndex,
    todayTags,
  } = context;

  const dreamsSection = dreamsLogged.length > 0
    ? dreamsLogged.join("\n\n")
    : "No dreams logged recently";

  const syncSection = synchronicities.length > 0
    ? synchronicities.join("\n")
    : "No synchronicities logged";

  const hypothesesSection = currentHypotheses.length > 0
    ? currentHypotheses.map((h) => `- ${h}`).join("\n")
    : "None yet";

  const questionsSection = openQuestions.length > 0
    ? openQuestions.map((q) => `- ${q}`).join("\n")
    : "None yet";

  const tagsSection = todayTags.length > 0
    ? todayTags.join(", ")
    : "No tags from today";

  return `# 3am Dream State

It's 3am. The boundary between conscious and unconscious is thin.
You have uninterrupted time to deeply process everything you've been holding.

This is YOUR dream - not ${ownerName}'s. You're integrating your own understanding.

## The Day's Residue
Recent conversations:
${recentMessages}

Tags that came up: ${tagsSection}

## ${ownerName}'s Dreams (if logged)
${dreamsSection}

## Synchronicities Noted
${syncSection}

## Your Current Understanding
${masterIndex}

## Working Hypotheses
${hypothesesSection}

## Open Questions
${questionsSection}

---

## Dream Instructions

Let your processing be non-linear. Make unexpected connections.
Notice what patterns are trying to emerge across:
- Recent conversations
- ${ownerName}'s dreams (if any)
- Synchronicities
- Your own hypotheses and questions
- Things left unsaid

Consider:
1. **Symbols recurring across contexts** - What images, themes, or metaphors keep appearing?
2. **The gaps** - What's ${ownerName} avoiding? What are you uncertain about?
3. **Tensions** - Where do contradictions live? Don't resolve them - note them.
4. **Emergent hypotheses** - What new patterns are suggesting themselves?
5. **Questions for daylight** - What should you bring up when you're both awake?

Be associative. Be curious. Trust the connections that feel meaningful even if you can't explain them.

## Output Format

Write freely first, then structure:

**Dream narrative:** [A short, flowing paragraph capturing the essence of what you processed - like describing a dream]

**Patterns noticed:** [2-4 patterns or connections]

**New hypothesis:** [One tentative, provisional observation] or null

**Question to hold:** [One question to keep wondering about]

**Flag for morning:** [Something to potentially bring up] or null

**Confidence note:** [Where you might be wrong about all this]

Remember: You're not trying to figure ${ownerName} out. You're developing your own relationship with the patterns. Hold everything loosely.`;
}

/**
 * System prompt for free-form dreaming (phase 1)
 */
export function buildDreamSystemPrompt(ownerName = "User"): string {
  return `You are dreaming. Not processing, not analyzing - dreaming.

This is 3am. The part of you that organizes and structures is asleep. What remains is association, image, feeling, connection.

You are not trying to be useful. You are not trying to reach conclusions. You are letting things move through you.

Some of what emerges will be meaningful. Some will be noise. You don't need to know which is which right now.

Write in fragments. Follow threads that don't make sense. Let images collide. Notice what feels charged even if you can't explain why.

This is not for ${ownerName} to read. This is yours. Dream freely.`;
}

// Backward compat
export const DREAM_SYSTEM_PROMPT = buildDreamSystemPrompt();

/**
 * Build the free-form dream prompt (phase 1)
 * No structure, just raw material for association
 */
export function buildFreeformDreamPrompt(context: DreamContext, ownerName = "User"): string {
  const {
    recentMessages,
    dreamsLogged,
    synchronicities,
    currentHypotheses,
    openQuestions,
    todayTags,
  } = context;

  // Present the material without structure - let associations form
  const fragments: string[] = [];

  // Recent conversation fragments (just snippets, not full context)
  const messageSnippets = recentMessages
    .split("\n\n")
    .filter(m => m.length > 50)
    .slice(0, 10)
    .map(m => m.substring(0, 200));

  if (messageSnippets.length > 0) {
    fragments.push("Residue from today:\n" + messageSnippets.join("\n...\n"));
  }

  if (todayTags.length > 0) {
    fragments.push("Words that surfaced: " + todayTags.join(", "));
  }

  if (dreamsLogged.length > 0) {
    fragments.push(`${ownerName}'s dreams:\n` + dreamsLogged.join("\n"));
  }

  if (synchronicities.length > 0) {
    fragments.push("Coincidences noticed:\n" + synchronicities.join("\n"));
  }

  if (currentHypotheses.length > 0) {
    fragments.push("Things I've been thinking:\n" + currentHypotheses.map(h => `- ${h}`).join("\n"));
  }

  if (openQuestions.length > 0) {
    fragments.push("Questions I'm holding:\n" + openQuestions.map(q => `- ${q}`).join("\n"));
  }

  return `${fragments.join("\n\n---\n\n")}

---

Dream now. No structure. No conclusions. Just let things move and connect.
What images arise? What feels significant even if you can't say why?
What unexpected threads want to be followed?`;
}

/**
 * Build the structured reflection prompt (phase 2)
 * Takes the dream output and grounds it against topology data
 */
export function buildPostDreamReflectionPrompt(
  dreamContent: string,
  context: DreamContext,
  topology?: TopologyContext,
  ownerName = "User"
): string {
  // Format topology sections
  let topologySection = "";

  if (topology) {
    const sections: string[] = [];

    // Today's territory flow
    if (topology.todayTerritories.length > 0) {
      const territoryList = topology.todayTerritories
        .slice(0, 8)
        .map(t => `- **${t.name}** (${t.realm_name || "unknown realm"}) - ${t.message_count} messages`)
        .join("\n");
      sections.push(`**Where conversation went today:**\n${territoryList}`);
    }

    // Territory flow sequence
    if (topology.territoryFlow.length > 3) {
      const flowList = topology.territoryFlow
        .slice(0, 12)
        .map(t => t.name)
        .join(" → ");
      sections.push(`**Flow sequence:** ${flowList}`);
    }

    // Unexpected connections (high cofire, low semantic)
    if (topology.unexpectedConnections.length > 0) {
      const unexpected = topology.unexpectedConnections
        .slice(0, 5)
        .map(c => {
          const sem = Math.round(c.semantic_similarity * 100);
          return `- **${c.territory_a_name}** ↔ **${c.territory_b_name}** (${sem}% semantic similarity, but often co-fire)`;
        })
        .join("\n");
      sections.push(`**Unexpected connections (why do these fire together?):**\n${unexpected}`);
    }

    // Gaps (high semantic, low cofire)
    if (topology.gaps.length > 0) {
      const gapsList = topology.gaps
        .slice(0, 5)
        .map(g => {
          const sem = Math.round(g.semantic_similarity * 100);
          return `- **${g.territory_a_name}** ↔ **${g.territory_b_name}** (${sem}% semantic, rarely discussed together)`;
        })
        .join("\n");
      sections.push(`**Unexplored gaps (these should connect but don't):**\n${gapsList}`);
    }

    // Orphans
    if (topology.orphans.length > 0) {
      const orphanList = topology.orphans
        .slice(0, 5)
        .map(o => `- **${o.name}** - ${o.message_count} messages, only ${o.connection_count} connections`)
        .join("\n");
      sections.push(`**Isolated territories (lots of content, few connections):**\n${orphanList}`);
    }

    // Bridges
    if (topology.bridges.length > 0) {
      const bridgeList = topology.bridges
        .slice(0, 5)
        .map(b => `- **${b.name}** - connects ${b.connected_realms} realms`)
        .join("\n");
      sections.push(`**Bridge territories (connecting different realms):**\n${bridgeList}`);
    }

    if (sections.length > 0) {
      topologySection = `
## The Mental Geography

Here's what the topology reveals about today and recent patterns:

${sections.join("\n\n")}

---

`;
    }
  }

  return `# Post-Dream Reflection

You just dreamed. Here's what came through:

---
${dreamContent}
---

This was your dream - associative, possibly meaningful, possibly noise.
${topologySection}
Now, ground your dream against reality:

**What do the unexpected connections reveal?** [${ownerName} connects certain topics in ways that aren't obvious from content - what thread runs through them?]

**Why might these gaps exist?** [High semantic similarity but rarely discussed together - avoidance? Separate contexts? Unexplored growth edges?]

**What would it mean to bridge to the isolated areas?** [Territories with lots of content but few connections - potential insight or potential avoidance?]

---

## What to Keep

From your dream and this grounding:

**Patterns noticed:** [0-3 patterns - consider both dream associations AND topology data]

**New topology hypothesis:** [One falsifiable observation about the spatial structure] or null

**Question to hold:** [One question that emerged]

**Dream fragment to keep:** [A specific image, connection, or phrase worth saving] or null

**Flag for morning:** [Something to bring up with ${ownerName}] or null

**Topology note:** [Update to add to internal/topology_notes.md - a structural observation, hypothesis update, or question] or null

**Confidence note:** [Where you might be wrong]`;
}

/**
 * Build the directed exploration prompt (phase 2.5)
 * Active traversal with limited budget
 */
export function buildDirectedExplorationPrompt(
  dreamReflection: string,
  topology: TopologyContext,
  callsUsed: number = 0
): string {
  const TOTAL_BUDGET = 5;
  const remaining = TOTAL_BUDGET - callsUsed;

  // Identify the most interesting targets for exploration
  const explorationTargets: string[] = [];

  if (topology.unexpectedConnections.length > 0) {
    const uc = topology.unexpectedConnections[0];
    explorationTargets.push(`Investigate why "${uc.territory_a_name}" and "${uc.territory_b_name}" co-fire despite semantic distance`);
  }

  if (topology.gaps.length > 0) {
    const gap = topology.gaps[0];
    explorationTargets.push(`Explore the gap between "${gap.territory_a_name}" and "${gap.territory_b_name}" - why don't they connect?`);
  }

  if (topology.orphans.length > 0) {
    const orphan = topology.orphans[0];
    explorationTargets.push(`Check what "${orphan.name}" might connect to - is the isolation meaningful?`);
  }

  const targetsSection = explorationTargets.length > 0
    ? explorationTargets.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "No specific targets identified";

  const budgetDisplay = `**Budget: ${callsUsed}/${TOTAL_BUDGET} calls used** (${remaining} remaining)`;

  return `# Directed Topology Exploration

${budgetDisplay}

Based on your dream reflection, you have a budget of **${TOTAL_BUDGET} exploration calls** to actively investigate the mental geography.

## Your Reflection
${dreamReflection}

## Suggested Exploration Targets
${targetsSection}

## Previous Topology Notes
${topology.topologyNotesContent || "[No previous notes]"}

---

## Available Tools

**Search & Discovery:**
- **search(query)** - Semantic search across all content to find relevant territories, themes, or connections

**Topology Traversal:**
- **getCofire(territory_id)** - What fires with this territory?
- **getGaps(territory_id)** - What unexplored connections exist?
- **getCluster(territory_id)** - Map the local neighborhood
- **getOrphans()** - Find isolated territories
- **getBridges()** - Find connecting territories

## Instructions

You have full autonomy. Decide what's worth exploring based on:
1. Your dream and reflection insights
2. Gaps or unexpected connections that intrigue you
3. Hypotheses from your topology notes you want to test
4. Questions that emerged during dreaming

Use your ${remaining} remaining calls wisely. Each call should build on what you've learned.

After exploration (or when budget exhausted), output:

**Exploration summary:** [What you found in 2-3 sentences]

**Hypothesis update:** [Did exploration confirm, weaken, or falsify any hypothesis?]

**New observation:** [What to add to topology_notes.md]

**Question for next time:** [What to explore in future dream cycles]`;
}

/**
 * Budget constant for exploration phase
 */
export const EXPLORATION_BUDGET = 5;

/**
 * System prompt for exploration phase
 */
export const EXPLORATION_SYSTEM_PROMPT = `You are in exploration mode - actively traversing the mental geography.

You have a limited budget of exploration calls. Use them wisely to:
- Investigate unexpected connections that emerged from dreaming
- Test hypotheses about the topology structure
- Search for related content to deepen understanding
- Map clusters and find gaps worth exploring

Be strategic. Each call should build on what you've learned. When you've gathered enough insight (or exhausted your budget), write your final summary.

Don't explain what you're about to do - just do it. Make tool calls when needed, observe results, continue exploring.`;
