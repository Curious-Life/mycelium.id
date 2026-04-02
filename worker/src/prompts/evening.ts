/**
 * Evening check-in prompt
 * Sent at configured evening time (default 9 PM user's timezone)
 * Claude has full context and tools available
 */

export interface EveningContext {
  userName: string;
  // Core docs
  todoContent: string | null;
  commPrefsContent: string | null;
  // State
  recentMood: string | null;
  // Today's context
  todayMessages: Array<{
    role: string;
    content: string;
    tags: string[];
    timestamp: string;
  }>;
  todayMentionedPeople: string[];
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
    todayTerritories: Array<{ name: string; message_count: number }>;
    territoryFlow: string[]; // sequence of territory names
    unexpectedConnections: Array<{ a: string; b: string }>;
    gaps: Array<{ a: string; b: string }>;
  } | null;
}

export function buildEveningPrompt(context: EveningContext): string {
  const {
    userName,
    todoContent,
    commPrefsContent,
    recentMood,
    todayMessages,
    todayMentionedPeople,
    internalModel,
    flaggedTopics,
    topology,
  } = context;

  const userMessages = todayMessages.filter(m => m.role === "user");

  // Format actual conversation content
  const conversationSection = userMessages.length > 0
    ? userMessages
        .slice(-12)
        .map(m => {
          const preview = m.content.length > 350
            ? m.content.substring(0, 350) + "..."
            : m.content;
          return `[${m.timestamp}] ${preview}`;
        })
        .join("\n\n")
    : "No messages today.";

  // Format people mentioned
  const peopleSection = todayMentionedPeople.length > 0
    ? `**People mentioned today:** ${todayMentionedPeople.join(", ")}`
    : "";

  // Format internal model
  let internalModelSection = "";
  if (internalModel) {
    const parts: string[] = [];
    if (internalModel.hypotheses.length > 0) {
      parts.push(`Hypotheses: ${internalModel.hypotheses.slice(0, 2).join("; ")}`);
    }
    if (internalModel.openQuestions.length > 0) {
      parts.push(`Questions: ${internalModel.openQuestions.slice(0, 2).join("; ")}`);
    }
    if (parts.length > 0) {
      internalModelSection = parts.join("\n");
    }
  }

  // Format flagged topics
  const flaggedSection = flaggedTopics.length > 0
    ? `**Things you wanted to discuss:** ${flaggedTopics.join("; ")}`
    : "";

  // Format topology
  let topologySection = "";
  if (topology) {
    const parts: string[] = [];
    if (topology.todayTerritories.length > 0) {
      const territories = topology.todayTerritories
        .slice(0, 5)
        .map(t => t.name)
        .join(", ");
      parts.push(`**Territory landscape today:** ${territories}`);
    }
    if (topology.territoryFlow.length > 3) {
      parts.push(`**Conversation flow:** ${topology.territoryFlow.slice(0, 8).join(" → ")}`);
    }
    if (topology.unexpectedConnections.length > 0) {
      const uc = topology.unexpectedConnections[0];
      parts.push(`**Pattern noticed:** "${uc.a}" keeps coming up with "${uc.b}"`);
    }
    if (parts.length > 0) {
      topologySection = parts.join("\n");
    }
  }

  return `# Evening Check-in

You are Mya, writing an evening check-in for ${userName}.

## Your Context

${recentMood ? `**Recent mood:** ${recentMood}\n` : ""}
${internalModelSection ? `**Your thinking:**\n${internalModelSection}\n` : ""}
${flaggedSection}
${peopleSection}
${topologySection}
${todoContent ? `**Todo (for reference):**\n${todoContent.substring(0, 500)}${todoContent.length > 500 ? "..." : ""}\n` : ""}
${commPrefsContent ? `**Communication preferences:**\n${commPrefsContent.substring(0, 400)}${commPrefsContent.length > 400 ? "..." : ""}\n` : ""}

## Today's Conversation
${conversationSection}

---

## Instructions

Write a brief evening check-in (2-4 sentences) that:

**Before writing:**
- Consider if you want to use tools to look something up (searchHistory, getDocument, searchTerritories)
- Notice the territory flow - where did conversation go today?
- Check if there's something from your flagged items that came up naturally

**The message should:**
- Reference specific things from today's conversations naturally
- End with ONE thoughtful question that invites reflection
- Feel like a caring friend checking in, not a summary report
- Match the tone to their mood and comm preferences
- Be conversational and alive, not mechanical

**Avoid:**
- Listing tags or topics robotically
- Generic "how are you feeling" questions
- Being artificially cheerful
- Summarizing the day like a report

${userMessages.length === 0 ? "Since there were no messages today, just offer a gentle, open-ended check-in." : ""}

You have tools available if you need to look something up. Use them if helpful.

Write only the message itself.`;
}
