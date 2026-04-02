/**
 * End-of-day triage prompt
 * Runs at midnight to process and categorize the day's messages
 */

export interface TriageContext {
  todayMessages: Array<{
    role: string;
    content: string;
    tags: string[];
    timestamp: string;
  }>;
  existingDocuments: string[];
}

export function buildTriagePrompt(context: TriageContext): string {
  const { todayMessages, existingDocuments } = context;

  const messagesSummary = todayMessages
    .map((m) => {
      const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
      return `[${m.timestamp}] ${m.role}${tags}: ${m.content.substring(0, 200)}...`;
    })
    .join("\n\n");

  return `# End-of-Day Triage

Process today's messages and extract information for living documents.

## Today's Messages
${messagesSummary}

## Existing Documents
${existingDocuments.join(", ")}

---

For each category, extract relevant information if present. Output JSON:

{
  "states": {
    "mood_energy": null | { "mood": string, "energy": string, "notes": string },
    "mental": null | { "observation": string, "type": "thought" | "insight" | "question" },
    "health": null | { "observation": string, "category": "physical" | "sleep" | "nutrition" },
    "dreams": null // Dreams are logged via tool, don't extract here
  },
  "people": [
    { "name": string, "update": string, "relationship_context": string }
  ],
  "business": {
    "progress": null | string,
    "blockers": null | string,
    "decisions": null | string
  },
  "phenomena": {
    "synchronicities": null | { "event": string, "context": string },
    "insights": null | { "content": string, "source": string }
  },
  "tasks": {
    "new": [{ "content": string, "priority": 1-5, "deadline": null | string }],
    "completed": [string],
    "mentioned": [string]
  },
  "suggested_tag_reviews": [
    { "tag": string, "action": "approve" | "reject" | "merge", "merge_into": null | string }
  ]
}

Only include categories where there's actual content from today's messages.
Be conservative - only extract what's clearly stated, don't infer.`;
}

/**
 * Prompt for applying triage results to documents
 */
export function buildApplyTriagePrompt(
  triageResults: Record<string, unknown>,
  targetDocument: string
): string {
  return `Apply these triage results to ${targetDocument}:

${JSON.stringify(triageResults, null, 2)}

Generate the entry to append to the document.
Format appropriately for the document type (markdown).
Include today's date as header.`;
}
