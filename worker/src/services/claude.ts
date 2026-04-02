import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types/env";
import type { Message as DbMessage } from "../types/database";
import { buildSystemPrompt } from "../prompts/system";

// Model configuration - Claude Sonnet 4.5 (best balance of quality/cost)
const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";

// API timeout configuration (in milliseconds)
// 2 minutes for Claude API calls
const API_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Wrap a promise with a timeout
 * Returns the promise result or throws a timeout error
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

// Context budget configuration (based on Claude's context window)
// Max context is ~200k tokens, but we want to leave room for response
// and avoid expensive long-context calls
const CONTEXT_BUDGET = {
  MAX_TOKENS: 100000,        // Soft limit for context assembly
  WARNING_THRESHOLD: 0.8,    // Warn when context exceeds 80%
  CHARS_PER_TOKEN: 4,        // Rough estimate: 1 token ≈ 4 characters
};

/**
 * Estimate token count from text (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CONTEXT_BUDGET.CHARS_PER_TOKEN);
}

/**
 * Context budget tracking result
 */
export interface ContextBudget {
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
  isOverBudget: boolean;
  isWarning: boolean;
  breakdown: {
    masterIndex: number;
    territories: number;
    documents: number;
    history: number;
    internalModel: number;
    pinnedDocs: number;
    other: number;
  };
}

export interface RelevantTerritory {
  territory_id: number;
  name: string;
  essence: string | null;
  realm_id: number | null;
  message_count: number;
  story_current_chapter: string | null;
  agent_expertise: string | null;
  agent_can_help_with: string[] | null;
  uncertainty_open_questions: string[] | null;
  top_entities: Array<{ text: string; type: string; count: number }> | null;
  similarity: number;
}

export interface RelevantSemanticTheme {
  realm_id: number;
  semantic_theme_id: number;
  name: string;
  essence: string | null;
  territory_count: number;
  message_count: number;
  story_current_chapter: string | null;
  similarity: number;
}

export interface RelevantRealm {
  realm_id: number;
  name: string;
  essence: string | null;
  territory_count: number;
  message_count: number;
  story_current_chapter: string | null;
  agent_expertise: string | null;
  agent_can_help_with: string[] | null;
  similarity: number;
}

export interface InternalModel {
  hypotheses: string[];      // Working theories about the owner
  openQuestions: string[];   // Questions Mya is curious about
  contradictions: string[];  // Inconsistencies noticed
  uncertainty: string[];     // Where Mya might be wrong
}

export interface FlaggedItem {
  topic: string;
  context: string;
  timestamp: string;
}

export interface ConversationContext {
  masterIndex: string | null;           // Full mindscape overview (realms, themes, territories)
  recentMessages: DbMessage[];          // Recent conversation history (rendered last for recency)
  currentTags: string[];
  internalModel: InternalModel | null;  // Mya's private model
  flaggedItems: FlaggedItem[];          // Items flagged for discussion
  todoDoc: string | null;               // Always-in-context todo document
  commPrefsDoc: string | null;          // Always-in-context communication preferences
  pinnedDocs: Array<{ path: string; content: string }>; // User-pinned documents
  availableFolders: string[];           // Folder names for createDocument
  availableCanvases: string[];          // Canvas names for createDocument
  imageData?: ArrayBuffer; // Optional image for multimodal messages
  imageMimeType?: string;  // MIME type of the image
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClaudeResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: ClaudeUsage;
  thinking?: string; // Thinking content if thinking mode was enabled
  thinkingTokens?: number; // Estimated thinking tokens
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Convert ArrayBuffer to base64 in chunks to avoid stack overflow
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binaryString = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binaryString += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binaryString);
}

export class ClaudeService {
  private client: Anthropic;
  private ownerName: string;
  private systemPrompt: string;

  constructor(env: Env) {
    this.client = new Anthropic({ apiKey: env.CLAUDE_API_KEY });
    this.ownerName = env.OWNER_NAME || "User";
    this.systemPrompt = buildSystemPrompt(this.ownerName);
  }

  /**
   * Calculate context budget usage
   */
  calculateContextBudget(context: ConversationContext): ContextBudget {
    const breakdown = {
      masterIndex: context.masterIndex ? estimateTokens(context.masterIndex) : 0,
      territories: 0, // No longer passively loading semantic matches
      documents: 0,   // Documents are no longer passively loaded
      history: context.recentMessages.reduce(
        (sum, m) => sum + estimateTokens(m.content), 0
      ),
      internalModel: context.internalModel
        ? estimateTokens(JSON.stringify(context.internalModel))
        : 0,
      pinnedDocs: context.pinnedDocs.reduce(
        (sum, d) => sum + estimateTokens(d.content), 0
      ),
      other: (context.todoDoc ? estimateTokens(context.todoDoc) : 0) +
        (context.commPrefsDoc ? estimateTokens(context.commPrefsDoc) : 0) +
        estimateTokens(this.systemPrompt),
    };

    const totalTokens = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
    const usagePercent = totalTokens / CONTEXT_BUDGET.MAX_TOKENS;

    return {
      totalTokens,
      maxTokens: CONTEXT_BUDGET.MAX_TOKENS,
      usagePercent,
      isOverBudget: usagePercent > 1.0,
      isWarning: usagePercent > CONTEXT_BUDGET.WARNING_THRESHOLD,
      breakdown,
    };
  }

  async chat(
    userMessage: string,
    context: ConversationContext
  ): Promise<ClaudeResponse> {
    // Calculate and log context budget
    const budget = this.calculateContextBudget(context);
    if (budget.isWarning) {
      console.log(`Context budget warning: ${(budget.usagePercent * 100).toFixed(1)}% used (${budget.totalTokens}/${budget.maxTokens} tokens)`);
      console.log("Breakdown:", budget.breakdown);
    }

    // Build context string
    const contextParts: string[] = [];

    // Add current date/time (in Riga timezone)
    const now = new Date();
    const rigaTime = now.toLocaleString("en-GB", {
      timeZone: env.OWNER_TIMEZONE || "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    contextParts.push(`## Current Time\n${rigaTime}`);

    if (context.masterIndex) {
      contextParts.push(`## Mindscape\n${context.masterIndex}\n\n*Use searchTerritories, searchRealms, searchThemes, searchHistory, getDocument to explore specific areas when needed*`);
    }

    if (context.currentTags.length > 0) {
      contextParts.push(`## Message Tags (auto-detected)\n${context.currentTags.join(", ")}`);
    }

    // Add internal model (Mya's private hypotheses and questions)
    if (context.internalModel) {
      const { hypotheses, openQuestions, contradictions, uncertainty } = context.internalModel;
      const internalParts: string[] = [];

      if (hypotheses.length > 0) {
        internalParts.push(`**Working Hypotheses:**\n${hypotheses.map(h => `- ${h}`).join("\n")}`);
      }
      if (openQuestions.length > 0) {
        internalParts.push(`**Open Questions:**\n${openQuestions.map(q => `- ${q}`).join("\n")}`);
      }
      if (contradictions.length > 0) {
        internalParts.push(`**Contradictions Noticed:**\n${contradictions.map(c => `- ${c}`).join("\n")}`);
      }
      if (uncertainty.length > 0) {
        internalParts.push(`**Where I Might Be Wrong:**\n${uncertainty.map(u => `- ${u}`).join("\n")}`);
      }

      if (internalParts.length > 0) {
        contextParts.push(`## Your Private Model (not visible to the owner)\n${internalParts.join("\n\n")}`);
      }
    }

    // Add flagged items for discussion
    if (context.flaggedItems && context.flaggedItems.length > 0) {
      const flaggedText = context.flaggedItems
        .slice(0, 5) // Limit to most recent 5
        .map(item => {
          const parts = [`- **${item.topic}**`];
          if (item.context) parts.push(`  Context: ${item.context}`);
          parts.push(`  (flagged ${item.timestamp})`);
          return parts.join("\n");
        })
        .join("\n");
      contextParts.push(`## Things You Wanted to Bring Up\n${flaggedText}`);
    }

    // Always-in-context: Todo document
    if (context.todoDoc) {
      contextParts.push(`## Todo (keep this updated)\n${context.todoDoc}`);
    }

    // Always-in-context: Communication preferences
    if (context.commPrefsDoc) {
      contextParts.push(`## Communication Preferences (update as you learn)\n${context.commPrefsDoc}`);
    }

    // Pinned documents (user-selected to always appear in context)
    if (context.pinnedDocs && context.pinnedDocs.length > 0) {
      const pinnedText = context.pinnedDocs
        .map(doc => `### ${doc.path}\n${doc.content}`)
        .join("\n\n");
      contextParts.push(`## Pinned Documents\n${pinnedText}`);
    }

    // Available folders and canvases (for createDocument tool)
    if (context.availableFolders?.length > 0 || context.availableCanvases?.length > 0) {
      const orgParts: string[] = [];
      if (context.availableFolders?.length > 0) {
        orgParts.push(`Folders: ${context.availableFolders.join(", ")}`);
      }
      if (context.availableCanvases?.length > 0) {
        orgParts.push(`Canvases: ${context.availableCanvases.join(", ")}`);
      }
      contextParts.push(`## Available Organization\n${orgParts.join("\n")}`);
    }

    // Build message array with context FIRST, then conversation history, then current message
    // This ensures background context comes before recent messages for better recency bias
    const cleanedMessages: Anthropic.MessageParam[] = [];

    // 1. Add context as first user message (if any context exists)
    if (contextParts.length > 0) {
      cleanedMessages.push({
        role: "user",
        content: `<context>\n${contextParts.join("\n\n")}\n</context>`,
      });
      // Add brief assistant acknowledgment to maintain alternation
      cleanedMessages.push({
        role: "assistant",
        content: "[context received]",
      });
    }

    // 2. Build message history from recent messages - filter out empty messages
    const historyMessages: Anthropic.MessageParam[] = context.recentMessages
      .filter((m) => m.content && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Add history messages, ensuring alternation (Claude API requirement)
    for (const msg of historyMessages) {
      const last = cleanedMessages[cleanedMessages.length - 1];
      if (!last || last.role !== msg.role) {
        cleanedMessages.push(msg);
      } else {
        // Merge consecutive same-role messages
        cleanedMessages[cleanedMessages.length - 1] = {
          role: msg.role,
          content: `${last.content}\n\n${msg.content}`,
        };
      }
    }

    // 3. Add current message (without context - it's already at the start)
    // Ensure we don't have consecutive user messages
    const lastMsg = cleanedMessages[cleanedMessages.length - 1];
    if (lastMsg?.role === "user") {
      // Need assistant placeholder to allow another user message
      cleanedMessages.push({
        role: "assistant",
        content: "...",
      });
    }

    if (context.imageData) {
      // Multimodal message with image
      const base64 = arrayBufferToBase64(context.imageData);
      cleanedMessages.push({
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: (context.imageMimeType || "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: base64,
            },
          },
          {
            type: "text",
            text: userMessage,
          },
        ],
      });
    } else {
      // Text-only message
      cleanedMessages.push({
        role: "user",
        content: userMessage,
      });
    }

    const response = await withTimeout(
      this.client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: this.systemPrompt,
        messages: cleanedMessages,
        tools: this.getTools(),
      }),
      API_TIMEOUT_MS,
      "Claude API chat"
    );

    // Extract content and tool calls
    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    };
  }

  /**
   * Chat with thinking mode enabled (extended thinking)
   * Returns thinking content along with the response
   */
  async chatWithThinking(
    userMessage: string,
    context: ConversationContext,
    thinkingBudget: number = 10000
  ): Promise<ClaudeResponse> {
    // Calculate and log context budget
    const budget = this.calculateContextBudget(context);
    if (budget.isWarning) {
      console.log(`Context budget warning: ${(budget.usagePercent * 100).toFixed(1)}% used (${budget.totalTokens}/${budget.maxTokens} tokens)`);
      console.log("Breakdown:", budget.breakdown);
    }

    // Build context string (same as chat method)
    const contextParts: string[] = [];

    // Add current date/time (in Riga timezone)
    const now = new Date();
    const rigaTime = now.toLocaleString("en-GB", {
      timeZone: env.OWNER_TIMEZONE || "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    contextParts.push(`## Current Time\n${rigaTime}`);

    if (context.masterIndex) {
      contextParts.push(`## Mindscape\n${context.masterIndex}\n\n*Use searchTerritories, searchRealms, searchThemes, searchHistory, getDocument to explore specific areas when needed*`);
    }

    if (context.currentTags.length > 0) {
      contextParts.push(`## Message Tags (auto-detected)\n${context.currentTags.join(", ")}`);
    }

    // Add internal model (Mya's private hypotheses and questions)
    if (context.internalModel) {
      const { hypotheses, openQuestions, contradictions, uncertainty } = context.internalModel;
      const internalParts: string[] = [];

      if (hypotheses.length > 0) {
        internalParts.push(`**Working Hypotheses:**\n${hypotheses.map(h => `- ${h}`).join("\n")}`);
      }
      if (openQuestions.length > 0) {
        internalParts.push(`**Open Questions:**\n${openQuestions.map(q => `- ${q}`).join("\n")}`);
      }
      if (contradictions.length > 0) {
        internalParts.push(`**Contradictions Noticed:**\n${contradictions.map(c => `- ${c}`).join("\n")}`);
      }
      if (uncertainty.length > 0) {
        internalParts.push(`**Where I Might Be Wrong:**\n${uncertainty.map(u => `- ${u}`).join("\n")}`);
      }

      if (internalParts.length > 0) {
        contextParts.push(`## Your Private Model (not visible to the owner)\n${internalParts.join("\n\n")}`);
      }
    }

    // Add flagged items for discussion
    if (context.flaggedItems && context.flaggedItems.length > 0) {
      const flaggedText = context.flaggedItems
        .slice(0, 5) // Limit to most recent 5
        .map(item => {
          const parts = [`- **${item.topic}**`];
          if (item.context) parts.push(`  Context: ${item.context}`);
          parts.push(`  (flagged ${item.timestamp})`);
          return parts.join("\n");
        })
        .join("\n");
      contextParts.push(`## Things You Wanted to Bring Up\n${flaggedText}`);
    }

    // Always-in-context: Todo document
    if (context.todoDoc) {
      contextParts.push(`## Todo (keep this updated)\n${context.todoDoc}`);
    }

    // Always-in-context: Communication preferences
    if (context.commPrefsDoc) {
      contextParts.push(`## Communication Preferences (update as you learn)\n${context.commPrefsDoc}`);
    }

    // Pinned documents
    if (context.pinnedDocs && context.pinnedDocs.length > 0) {
      const pinnedText = context.pinnedDocs
        .map(doc => `### ${doc.path}\n${doc.content}`)
        .join("\n\n");
      contextParts.push(`## Pinned Documents\n${pinnedText}`);
    }

    // Available folders and canvases
    if (context.availableFolders?.length > 0 || context.availableCanvases?.length > 0) {
      const orgParts: string[] = [];
      if (context.availableFolders?.length > 0) {
        orgParts.push(`Folders: ${context.availableFolders.join(", ")}`);
      }
      if (context.availableCanvases?.length > 0) {
        orgParts.push(`Canvases: ${context.availableCanvases.join(", ")}`);
      }
      contextParts.push(`## Available Organization\n${orgParts.join("\n")}`);
    }

    // Build message array
    const cleanedMessages: Anthropic.MessageParam[] = [];

    // 1. Add context as first user message
    if (contextParts.length > 0) {
      cleanedMessages.push({
        role: "user",
        content: `<context>\n${contextParts.join("\n\n")}\n</context>`,
      });
      cleanedMessages.push({
        role: "assistant",
        content: "[context received]",
      });
    }

    // 2. Build message history
    const historyMessages: Anthropic.MessageParam[] = context.recentMessages
      .filter((m) => m.content && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    for (const msg of historyMessages) {
      const last = cleanedMessages[cleanedMessages.length - 1];
      if (!last || last.role !== msg.role) {
        cleanedMessages.push(msg);
      } else {
        cleanedMessages[cleanedMessages.length - 1] = {
          role: msg.role,
          content: `${last.content}\n\n${msg.content}`,
        };
      }
    }

    // 3. Add current message
    const lastMsg = cleanedMessages[cleanedMessages.length - 1];
    if (lastMsg?.role === "user") {
      cleanedMessages.push({
        role: "assistant",
        content: "...",
      });
    }

    if (context.imageData) {
      const base64 = arrayBufferToBase64(context.imageData);
      cleanedMessages.push({
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: (context.imageMimeType || "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: base64,
            },
          },
          {
            type: "text",
            text: userMessage,
          },
        ],
      });
    } else {
      cleanedMessages.push({
        role: "user",
        content: userMessage,
      });
    }

    // Call Claude with thinking enabled
    const response = await withTimeout(
      this.client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 20000, // Must be higher when thinking is enabled
        system: this.systemPrompt,
        messages: cleanedMessages,
        tools: this.getTools(),
        thinking: {
          type: "enabled",
          budget_tokens: thinkingBudget,
        },
      }, {
        headers: {
          // Required for thinking between tool calls
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      }),
      API_TIMEOUT_MS,
      "Claude API chat with thinking"
    );

    // Extract content, thinking, and tool calls
    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "thinking") {
        thinking += block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    // Derive thinking tokens estimate
    const responseTokens = estimateTokens(content);
    const thinkingTokens = Math.max(0, response.usage.output_tokens - responseTokens);

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      thinking: thinking || undefined,
      thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined,
    };
  }

  /**
   * Continue conversation after tool execution with thinking preserved
   */
  async continueWithToolResultsAndThinking(
    messages: Anthropic.MessageParam[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    thinkingBlocks: Array<{ thinking: string; signature: string }>,
    orientationContext?: {
      toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
      flaggedTopics?: string[];
      currentPriority?: string;
    }
  ): Promise<ClaudeResponse> {
    // Build orientation anchor
    const toolSummaries = this.buildToolOrientationSummaries(
      orientationContext?.toolCalls || []
    );
    const flaggedSummary = orientationContext?.flaggedTopics?.length
      ? `Flagged for discussion: ${orientationContext.flaggedTopics.slice(0, 3).join("; ")}`
      : "";
    const prioritySummary = orientationContext?.currentPriority
      ? `User's current priority: ${orientationContext.currentPriority}`
      : "";

    const orientationParts = [toolSummaries, flaggedSummary, prioritySummary]
      .filter(Boolean);

    const orientationText = orientationParts.length > 0
      ? `[ORIENTATION: ${orientationParts.join(" | ")}]\n\n`
      : "";

    // Add tool results with orientation
    messages.push({
      role: "user",
      content: [
        ...toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
        {
          type: "text" as const,
          text: `${orientationText}[Tools executed. Now respond to the user naturally based on what you did and learned. Don't just say 'noted' - engage with what they shared.]`,
        },
      ],
    });

    const response = await withTimeout(
      this.client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 20000,
        system: this.systemPrompt,
        messages,
        tools: this.getTools(),
        thinking: {
          type: "enabled",
          budget_tokens: 10000,
        },
      }, {
        headers: {
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      }),
      API_TIMEOUT_MS,
      "Claude API continue with thinking"
    );

    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "thinking") {
        thinking += block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const responseTokens = estimateTokens(content);
    const thinkingTokens = Math.max(0, response.usage.output_tokens - responseTokens);

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      thinking: thinking || undefined,
      thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined,
    };
  }

  /**
   * Continue conversation after tool execution
   * Includes context anchor injection to prevent drift during long tool chains
   */
  async continueWithToolResults(
    messages: Anthropic.MessageParam[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    orientationContext?: {
      toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
      flaggedTopics?: string[];
      currentPriority?: string;
    }
  ): Promise<ClaudeResponse> {
    // Build context-aware orientation anchor based on what tools did
    const toolSummaries = this.buildToolOrientationSummaries(
      orientationContext?.toolCalls || []
    );
    const flaggedSummary = orientationContext?.flaggedTopics?.length
      ? `Flagged for discussion: ${orientationContext.flaggedTopics.slice(0, 3).join("; ")}`
      : "";
    const prioritySummary = orientationContext?.currentPriority
      ? `User's current priority: ${orientationContext.currentPriority}`
      : "";

    const orientationParts = [toolSummaries, flaggedSummary, prioritySummary]
      .filter(Boolean);

    const orientationText = orientationParts.length > 0
      ? `[ORIENTATION: ${orientationParts.join(" | ")}]\n\n`
      : "";

    // Add tool results to messages with orientation anchor and prompt to respond
    messages.push({
      role: "user",
      content: [
        ...toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
        {
          type: "text" as const,
          text: `${orientationText}[Tools executed. Now respond to the user naturally based on what you did and learned. Don't just say 'noted' - engage with what they shared.]`,
        },
      ],
    });

    const response = await withTimeout(
      this.client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: this.systemPrompt,
        messages,
        tools: this.getTools(),
      }),
      API_TIMEOUT_MS,
      "Claude API continue with tool results"
    );

    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    };
  }

  /**
   * Build context-aware orientation summaries based on tool calls
   * Different tools get different emphasis to maintain conversational coherence
   */
  private buildToolOrientationSummaries(
    toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  ): string {
    if (toolCalls.length === 0) return "";

    const summaries: string[] = [];

    for (const call of toolCalls) {
      switch (call.name) {
        case "searchHistory": {
          const query = call.input.query as string;
          summaries.push(`Searched history for "${query}" - connect findings to current thread`);
          break;
        }
        case "updateDocument": {
          const path = call.input.path as string;
          const entryType = call.input.entryType as string;
          summaries.push(`Recorded ${entryType} in ${path}`);
          break;
        }
        case "updateInternalModel": {
          const section = call.input.section as string;
          summaries.push(`Updated internal model (${section}) - this is your private thinking`);
          break;
        }
        case "getDocument": {
          const path = call.input.path as string;
          summaries.push(`Retrieved ${path} - use this context`);
          break;
        }
        case "flagForDiscussion": {
          const topic = call.input.topic as string;
          summaries.push(`Flagged "${topic}" for later - will appear in next conversation`);
          break;
        }
        case "createDocument": {
          const path = call.input.path as string;
          summaries.push(`Created new document at ${path}`);
          break;
        }
        case "createTask": {
          const content = (call.input.content as string).substring(0, 40);
          summaries.push(`Created task: "${content}..."`);
          break;
        }
        case "pinDocument":
        case "unpinDocument": {
          const path = call.input.path as string;
          const action = call.name === "pinDocument" ? "Pinned" : "Unpinned";
          summaries.push(`${action} ${path}`);
          break;
        }
        case "listDocuments":
          summaries.push("Listed documents");
          break;
        default:
          summaries.push(`Used ${call.name}`);
      }
    }

    return summaries.join("; ");
  }

  /**
   * Force a text response when Claude only used tools
   * Called without tools to ensure Claude generates text
   */
  async forceTextResponse(
    userMessage: string,
    context: ConversationContext,
    toolsUsed: string[]
  ): Promise<{ content: string; usage: ClaudeUsage }> {
    // Build a prompt that references what was done
    const toolsSummary = toolsUsed.length > 0
      ? `You just used these tools: ${toolsUsed.join(", ")}.`
      : "";

    const prompt = `${toolsSummary} Now respond naturally to what the user shared. Be present and engaged - don't just acknowledge, actually respond to them.

User's message was: "${userMessage}"`;

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: this.systemPrompt,
      messages: [{ role: "user", content: prompt }],
      // No tools - forces text response
    });

    let content = "";
    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      }
    }

    return {
      content: content.trim(),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    };
  }

  /**
   * Dream mode - higher temperature, no structure, pure association
   * Used for the free-form phase of overnight processing
   */
  async dream(
    prompt: string,
    systemPrompt: string,
    temperature: number = 1.0
  ): Promise<{ content: string; usage: ClaudeUsage }> {
    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
      temperature,
      // No tools - pure associative text
    });

    let content = "";
    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      }
    }

    return {
      content: content.trim(),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    };
  }

  /**
   * Exploration mode - autonomous topology traversal with budget
   * Returns tool calls for execution by caller, tracks budget
   */
  async explore(
    prompt: string,
    systemPrompt: string
  ): Promise<ClaudeResponse> {
    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: this.getExplorationTools(),
    });

    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    };
  }

  /**
   * Continue exploration after tool results
   */
  async continueExploration(
    messages: Anthropic.MessageParam[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    systemPrompt: string
  ): Promise<ClaudeResponse> {
    messages.push({
      role: "user",
      content: toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
      })),
    });

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      tools: this.getExplorationTools(),
    });

    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    };
  }

  /**
   * Extract text from a PDF using Claude's vision capabilities
   * Used for scanned/bitmap PDFs where standard text extraction fails
   * Handles up to 100 pages, 32MB max
   */
  async extractPdfText(pdfData: ArrayBuffer, filename: string): Promise<string> {
    // Convert ArrayBuffer to base64 - use chunked string building to avoid stack overflow
    const bytes = new Uint8Array(pdfData);
    const CHUNK_SIZE = 8192; // Process 8KB at a time to avoid stack overflow
    let binaryString = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
      binaryString += String.fromCharCode.apply(null, Array.from(chunk));
    }
    const base64 = btoa(binaryString);

    console.log(`[Claude PDF] Sending ${filename} (${Math.round(pdfData.byteLength / 1024)}KB, ${base64.length} base64 chars)`);

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: `Extract all readable text from this PDF document "${filename}".

Instructions:
- Extract ALL text content, preserving paragraph structure
- Include text from images, charts, tables, and diagrams
- For tables, format as markdown tables
- For lists, preserve bullet/number formatting
- Separate sections with blank lines
- If the document contains handwriting, transcribe it as accurately as possible
- Do not add commentary or analysis - just extract the raw text content

Output the extracted text:`,
            },
          ],
        },
      ],
    });

    // Extract text from response
    let extractedText = "";
    for (const block of response.content) {
      if (block.type === "text") {
        extractedText += block.text;
      }
    }

    console.log(`[Claude PDF] Extracted ${extractedText.length} chars from ${filename} (${response.usage.input_tokens} input tokens)`);
    return extractedText;
  }

  /**
   * Get exploration-specific tools (subset for dream traversal)
   */
  private getExplorationTools(): Anthropic.Tool[] {
    return [
      {
        name: "search",
        description: "Semantic search across all content - territories, messages, documents. Use to find relevant areas to explore.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "What to search for (concept, topic, question)",
            },
            scope: {
              type: "string",
              enum: ["territories", "messages", "documents", "all"],
              description: "Scope of search (default: all)",
            },
            limit: {
              type: "number",
              description: "Max results (default 5)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "getCofire",
        description: "Get territories that co-fire (discussed together) with a given territory",
        input_schema: {
          type: "object" as const,
          properties: {
            territory_id: {
              type: "number",
              description: "The territory ID to find co-firing partners for",
            },
            scale: {
              type: "string",
              enum: ["immediate", "session", "daily", "weekly"],
              description: "Temporal scale (default: weekly)",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: ["territory_id"],
        },
      },
      {
        name: "getGaps",
        description: "Find unexplored connections: high semantic similarity but low co-firing",
        input_schema: {
          type: "object" as const,
          properties: {
            territory_id: {
              type: "number",
              description: "The territory ID to find gaps for",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: ["territory_id"],
        },
      },
      {
        name: "getCluster",
        description: "Map the connected neighborhood around a territory",
        input_schema: {
          type: "object" as const,
          properties: {
            territory_id: {
              type: "number",
              description: "Starting territory ID",
            },
            depth: {
              type: "number",
              description: "Hops to walk (default 2)",
            },
          },
          required: ["territory_id"],
        },
      },
      {
        name: "getOrphans",
        description: "Find isolated territories with high content but few connections",
        input_schema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: [],
        },
      },
      {
        name: "getBridges",
        description: "Find territories that bridge different realms",
        input_schema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: [],
        },
      },
    ];
  }

  private getTools(): Anthropic.Tool[] {
    // All tools use strict: true for guaranteed schema compliance
    return [
      {
        name: "updateDocument",
        description: "Update a living document with new observations. Use provisional language.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Document path (e.g., 'states/mental', 'business/mya')",
            },
            entry: {
              type: "string",
              description: "The observation to add (timestamped, provisional language)",
            },
            entryType: {
              type: "string",
              enum: ["observation", "shift", "note", "wondering"],
              description: "Type of entry",
            },
            confidence: {
              type: "string",
              enum: ["low", "medium", "provisional"],
              description: "Confidence level",
            },
          },
          required: ["path", "entry", "entryType", "confidence"],
        },
      },
      {
        name: "updateInternalModel",
        description: "Update your private model (never shown to user)",
        input_schema: {
          type: "object" as const,
          properties: {
            section: {
              type: "string",
              enum: ["observations", "hypotheses", "questions", "contradictions", "patterns", "uncertainty", "notes", "dream_fragments"],
              description: "Section to update: observations (raw notes), hypotheses (working theories), questions (open inquiries), contradictions (inconsistencies noticed), patterns (recurring themes), uncertainty (where you might be wrong), notes (misc), dream_fragments (raw associative images/connections from dreams)",
            },
            content: {
              type: "string",
              description: "Your private observation or question",
            },
          },
          required: ["section", "content"],
        },
      },
      {
        name: "getDocument",
        description: "Retrieve full document content when you need more detail",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Document path to retrieve",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "searchHistory",
        description: "Search past conversations and documents",
        input_schema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "What to search for",
            },
            scope: {
              type: "string",
              enum: ["all", "messages", "documents", "dreams", "states"],
              description: "Scope of search",
            },
            limit: {
              type: "number",
              description: "Max results (default 5)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "createTask",
        description: "Create a task captured from conversation",
        input_schema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description: "What needs to be done",
            },
            deadline: {
              type: "string",
              description: "Optional deadline (ISO date)",
            },
            priority: {
              type: "number",
              description: "Priority 1-5 (default 3)",
            },
            projectPath: {
              type: "string",
              description: "Related project document path",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "createDocument",
        description: "Create a new document to track a person, project, concept, or anything worth remembering. Can optionally place in a specific folder or add to a canvas.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Document path (e.g., 'people/sarah', 'business/project-x', 'concepts/emergence')",
            },
            title: {
              type: "string",
              description: "Human-readable title for the document",
            },
            initialContent: {
              type: "string",
              description: "Initial markdown content for the document",
            },
            folder: {
              type: "string",
              description: "Optional folder name to place document in (e.g., 'Projects', 'Research'). Defaults to Inbox.",
            },
            canvas: {
              type: "string",
              description: "Optional canvas name to add document to (e.g., 'Home', 'Work Projects')",
            },
          },
          required: ["path", "title", "initialContent"],
        },
      },
      {
        name: "listDocuments",
        description: "List all available documents with their paths and summaries",
        input_schema: {
          type: "object" as const,
          properties: {
            category: {
              type: "string",
              description: "Optional filter by category (e.g., 'people', 'business', 'states'). Leave empty to list all.",
            },
          },
          required: [],
        },
      },
      {
        name: "listFolders",
        description: "List all available folders. Use this to discover folder names before creating documents in specific folders.",
        input_schema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "listCanvases",
        description: "List all available canvases (workspaces). Use this to discover canvas names before adding documents to specific canvases.",
        input_schema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "pinDocument",
        description: "Pin a document to always appear in your context. Use sparingly - pinned docs take up context space.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Document path to pin",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "unpinDocument",
        description: "Unpin a document from your context",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Document path to unpin",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "flagForDiscussion",
        description: "Flag something to bring up in next conversation",
        input_schema: {
          type: "object" as const,
          properties: {
            topic: {
              type: "string",
              description: "What you want to discuss",
            },
            context: {
              type: "string",
              description: "Why this seems worth exploring",
            },
          },
          required: ["topic", "context"],
        },
      },
      {
        name: "searchTerritories",
        description: "Search across your mindscape territories (most specific level). Find territories related to a topic, concept, or question.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "What to search for (concept, topic, question)",
            },
            limit: {
              type: "number",
              description: "Max results (default 5)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "searchRealms",
        description: "Search across your mindscape realms (highest level). Find broad domains related to a topic.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "What to search for (concept, topic, question)",
            },
            limit: {
              type: "number",
              description: "Max results (default 3)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "searchThemes",
        description: "Search across your mindscape themes (mid-level). Find thematic threads related to a topic.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "What to search for (concept, topic, question)",
            },
            limit: {
              type: "number",
              description: "Max results (default 5)",
            },
          },
          required: ["query"],
        },
      },
      // ============ CO-FIRING TRAVERSAL TOOLS ============
      // These tools navigate the actual co-occurrence graph, showing what
      // actually fires together in the owner's mind (vs semantic similarity)
      {
        name: "getCoFiring",
        description: "Get territories that actually co-fire (occur together in conversation) with a given territory. Different from semantic search - this shows what the owner actually discusses together, not what could relate.",
        input_schema: {
          type: "object" as const,
          properties: {
            territory_id: {
              type: "number",
              description: "The territory ID to find co-firing partners for",
            },
            scale: {
              type: "string",
              enum: ["immediate", "session", "daily", "weekly"],
              description: "Temporal scale: immediate (1h half-life, focused work), session (4h, conversation), daily (24h), weekly (7d, project-level). Default: session",
            },
            min_strength: {
              type: "number",
              description: "Minimum co-fire strength 0-1 (default 0.1)",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: ["territory_id"],
        },
      },
      {
        name: "getOrphans",
        description: "Find orphan territories: high content but low connectivity. These may be isolated insights, avoidance patterns, or areas worth bridging to other topics.",
        input_schema: {
          type: "object" as const,
          properties: {
            min_messages: {
              type: "number",
              description: "Minimum message count to be considered 'substantial' (default 50)",
            },
            max_connections: {
              type: "number",
              description: "Maximum connections to be considered 'orphaned' (default 3)",
            },
            scale: {
              type: "string",
              enum: ["immediate", "session", "daily", "weekly"],
              description: "Temporal scale for measuring connections (default: weekly)",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: [],
        },
      },
      {
        name: "getBridges",
        description: "Find bridge territories: nodes that connect different realms. These are structural points worth understanding - they link different areas of the mindscape.",
        input_schema: {
          type: "object" as const,
          properties: {
            min_connections: {
              type: "number",
              description: "Minimum connections to be considered a bridge (default 5)",
            },
            scale: {
              type: "string",
              enum: ["immediate", "session", "daily", "weekly"],
              description: "Temporal scale (default: weekly)",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: [],
        },
      },
      {
        name: "getGaps",
        description: "Find unexplored connections: territories with high semantic similarity but low co-firing. These are potential bridges worth exploring - things that could relate but rarely discussed together.",
        input_schema: {
          type: "object" as const,
          properties: {
            territory_id: {
              type: "number",
              description: "The territory ID to find gaps for",
            },
            min_similarity: {
              type: "number",
              description: "Minimum semantic similarity 0-1 (default 0.7)",
            },
            max_cofire: {
              type: "number",
              description: "Maximum co-fire strength 0-1 (default 0.5)",
            },
            scale: {
              type: "string",
              enum: ["immediate", "session", "daily", "weekly"],
              description: "Temporal scale (default: weekly)",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: ["territory_id"],
        },
      },
      {
        name: "getCluster",
        description: "Walk outward from a territory to map its connected cluster. Shows the local neighborhood in the co-firing graph.",
        input_schema: {
          type: "object" as const,
          properties: {
            territory_id: {
              type: "number",
              description: "Starting territory ID",
            },
            depth: {
              type: "number",
              description: "How many hops to walk (default 2)",
            },
            min_strength: {
              type: "number",
              description: "Minimum connection strength to follow (default 0.3)",
            },
            scale: {
              type: "string",
              enum: ["immediate", "session", "daily", "weekly"],
              description: "Temporal scale (default: session)",
            },
          },
          required: ["territory_id"],
        },
      },
      // ============ MULTI-AGENT DELEGATION ============
      {
        name: "delegate_to_agent",
        description: "Delegate a task to Ada (research-agent) for deep research, analysis, and content creation. Delegation is async - results return later.",
        input_schema: {
          type: "object" as const,
          properties: {
            agent: {
              type: "string",
              enum: ["research-agent"],
              description: "Target agent: research-agent (Ada - deep research, analysis, content synthesis)",
            },
            task: {
              type: "string",
              description: "Clear description of what you want the agent to do",
            },
            context: {
              type: "string",
              description: "Relevant context to pass to the agent (background info, constraints, etc.)",
            },
            priority: {
              type: "string",
              enum: ["low", "normal", "high"],
              description: "Task priority (default: normal)",
            },
          },
          required: ["agent", "task"],
        },
      },
    ];
  }

  /**
   * Process a document (docx, pdf, etc.) and extract text using Claude's document feature
   */
  async processDocument(params: {
    content: string; // base64 encoded
    mimeType: string;
    filename: string;
    prompt: string;
  }): Promise<string> {
    const response = await withTimeout(
      this.client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: params.mimeType as "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                data: params.content,
              },
            },
            {
              type: "text",
              text: params.prompt,
            },
          ],
        }],
      }),
      API_TIMEOUT_MS,
      "Document extraction"
    );

    const textContent = response.content.find(c => c.type === "text");
    return textContent && "text" in textContent ? textContent.text : "[No text extracted]";
  }
}
