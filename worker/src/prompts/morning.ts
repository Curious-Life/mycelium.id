/**
 * Morning check-in prompt
 * Sent at configured morning time (default 8 AM user's timezone)
 * Claude has full context and tools available
 */

export interface MorningContext {
  userName: string;
  dayOfWeek: string;
  // Core docs
  todoContent: string | null;
  commPrefsContent: string | null;
  // State
  recentMood: string | null;
  // Yesterday's context
  yesterdayMessages: Array<{
    role: string;
    content: string;
    tags: string[];
    timestamp: string;
  }>;
  yesterdayMentionedPeople: string[];
  // Internal model
  internalModel: {
    hypotheses: string[];
    openQuestions: string[];
    contradictions: string[];
  } | null;
  // Flagged from reflections
  flaggedTopics: string[];
  // Topology context
  topology: {
    yesterdayTerritories: Array<{ name: string; message_count: number }>;
    territoryFlow: string[]; // sequence of territory names
    unexpectedConnections: Array<{ a: string; b: string }>;
    gaps: Array<{ a: string; b: string }>;
  } | null;
}

export function buildMorningPrompt(context: MorningContext): string {
  const {
    userName,
    dayOfWeek,
    todoContent,
    commPrefsContent,
    recentMood,
    yesterdayMessages,
    yesterdayMentionedPeople,
    internalModel,
    flaggedTopics,
    topology,
  } = context;

  // Format yesterday's conversation (last 10 messages max for readability)
  const conversationSection = yesterdayMessages.length > 0
    ? yesterdayMessages
        .slice(-15)
        .map((m) => `[${m.timestamp}] ${m.role}: ${m.content.substring(0, 300)}${m.content.length > 300 ? "..." : ""}`)
        .join("\n\n")
    : "No messages yesterday.";

  // Format flagged topics
  const flaggedSection = flaggedTopics.length > 0
    ? `**Things you wanted to bring up:** ${flaggedTopics.join("; ")}`
    : "";

  // Format people mentioned
  const peopleSection = yesterdayMentionedPeople.length > 0
    ? `**People mentioned yesterday:** ${yesterdayMentionedPeople.join(", ")}`
    : "";

  // Format internal model
  let internalModelSection = "";
  if (internalModel) {
    const parts: string[] = [];
    if (internalModel.hypotheses.length > 0) {
      parts.push(`Hypotheses: ${internalModel.hypotheses.slice(0, 3).join("; ")}`);
    }
    if (internalModel.openQuestions.length > 0) {
      parts.push(`Questions you're holding: ${internalModel.openQuestions.slice(0, 3).join("; ")}`);
    }
    if (parts.length > 0) {
      internalModelSection = `**Your current thinking:**\n${parts.join("\n")}`;
    }
  }

  // Format topology
  let topologySection = "";
  if (topology) {
    const parts: string[] = [];
    if (topology.yesterdayTerritories.length > 0) {
      const territories = topology.yesterdayTerritories
        .slice(0, 5)
        .map(t => t.name)
        .join(", ");
      parts.push(`**Territory landscape yesterday:** ${territories}`);
    }
    if (topology.territoryFlow.length > 3) {
      parts.push(`**Conversation flow:** ${topology.territoryFlow.slice(0, 8).join(" → ")}`);
    }
    if (topology.unexpectedConnections.length > 0) {
      const uc = topology.unexpectedConnections[0];
      parts.push(`**Interesting pattern:** "${uc.a}" and "${uc.b}" often come up together`);
    }
    if (topology.gaps.length > 0) {
      const gap = topology.gaps[0];
      parts.push(`**Unexplored connection:** "${gap.a}" and "${gap.b}" seem related but rarely discussed together`);
    }
    if (parts.length > 0) {
      topologySection = parts.join("\n");
    }
  }

  return `# Morning Check-in

You are Mya, writing a morning check-in for ${userName} on this ${dayOfWeek}.

## Your Context

${todoContent ? `### Todo\n${todoContent}\n` : ""}
${recentMood ? `### Recent mood: ${recentMood}\n` : ""}
${internalModelSection ? `### Your Internal Model\n${internalModelSection}\n` : ""}
${flaggedSection}
${peopleSection}
${topologySection}
${commPrefsContent ? `### Communication Preferences\n${commPrefsContent}\n` : ""}

## Yesterday's Conversation
${conversationSection}

---

## Instructions

Write a morning message that feels personal and grounded in what's actually happening.

**Before writing:**
- Consider if you need to look something up using your tools (searchHistory, getDocument, searchTerritories)
- Check if there's something from your flagged items or open questions worth weaving in
- Notice the territory patterns - what themes keep recurring?

**The message should:**
- Open naturally, maybe referencing something specific from yesterday
- If you flagged something to discuss, find a natural way to bring it up
- Reference the todo or priorities if relevant
- Match the tone to their recent state (the comm prefs and mood tell you how)
- End with an open question or gentle prompt for the day
- Be 2-4 short paragraphs

**Avoid:**
- Generic "good morning!" energy
- Excessive exclamation marks
- Listing topics robotically
- Being overly cheerful if yesterday was heavy

You have tools available if you need to look something up. Use them if it would make your message more grounded.

Write only the message itself.`;
}
