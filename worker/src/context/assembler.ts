import type { Env } from "../types/env";
import type { Message, Document } from "../types/database";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";

export interface AssembledContext {
  // Level 0: Always loaded
  masterIndex: string | null;
  recentMessages: Message[];
  todaySnapshot: TodaySnapshot;

  // Level 1: Dynamically loaded based on relevance
  relevantDocs: RelevantDocument[];
  semanticMatches: SemanticMatch[];

  // Metadata
  tokenEstimate: number;
}

export interface TodaySnapshot {
  mood: string | null;
  energy: string | null;
  focus: string | null;
  openTasks: number;
}

export interface RelevantDocument {
  path: string;
  title: string;
  summary: string;
  similarity: number;
}

export interface SemanticMatch {
  content: string;
  role: "user" | "assistant";
  tags: string[];
  createdAt: string;
  similarity: number;
}

// Rough token estimates (conservative)
const TOKEN_ESTIMATES = {
  masterIndex: 500,
  messageAverage: 50,
  todaySnapshot: 100,
  docSummary: 150,
  semanticMatch: 100,
};

const MAX_CONTEXT_TOKENS = 6000; // Leave room for system prompt and response

export class ContextAssembler {
  private supabase: SupabaseService;
  private workersAI: WorkersAIService;

  constructor(env: Env) {
    this.supabase = new SupabaseService(env);
    this.workersAI = new WorkersAIService(env);
  }

  /**
   * Assemble context for a conversation turn
   * Uses telescope model: always load core, dynamically load relevant
   */
  async assemble(
    userId: string,
    currentMessage: string,
    options: {
      maxRecentMessages?: number;
      maxRelevantDocs?: number;
      maxSemanticMatches?: number;
      includeSemanticSearch?: boolean;
    } = {}
  ): Promise<AssembledContext> {
    const {
      maxRecentMessages = 20,
      maxRelevantDocs = 3,
      maxSemanticMatches = 5,
      includeSemanticSearch = true,
    } = options;

    // Level 0: Always loaded (parallel fetch)
    const [masterIndexDoc, recentMessages, todaySnapshot, openTasks] = await Promise.all([
      this.supabase.getMasterIndex(userId),
      this.supabase.getRecentMessages(userId, maxRecentMessages),
      this.getTodaySnapshot(userId),
      this.supabase.getOpenTasks(userId),
    ]);

    // Generate embedding for current message (needed for relevance)
    const messageEmbedding = await this.workersAI.generateEmbedding(currentMessage);

    // Level 1: Dynamic loading based on relevance (parallel)
    const [relevantDocs, semanticMatches] = await Promise.all([
      this.supabase.searchDocuments(userId, messageEmbedding, maxRelevantDocs),
      includeSemanticSearch
        ? this.searchSemanticHistory(userId, messageEmbedding, maxSemanticMatches)
        : Promise.resolve([]),
    ]);

    // Calculate token estimate
    const tokenEstimate = this.estimateTokens(
      masterIndexDoc,
      recentMessages,
      relevantDocs,
      semanticMatches
    );

    return {
      masterIndex: masterIndexDoc?.content || null,
      recentMessages,
      todaySnapshot: {
        ...todaySnapshot,
        openTasks: openTasks.length,
      },
      relevantDocs: relevantDocs.map((d) => ({
        path: d.path,
        title: d.title,
        summary: d.summary,
        similarity: d.similarity,
      })),
      semanticMatches,
      tokenEstimate,
    };
  }

  /**
   * Get today's state snapshot from state documents
   */
  private async getTodaySnapshot(userId: string): Promise<Omit<TodaySnapshot, "openTasks">> {
    const moodDoc = await this.supabase.getDocument(userId, "states/mood_energy");

    if (!moodDoc?.content) {
      return { mood: null, energy: null, focus: null };
    }

    // Extract most recent entry from mood_energy document
    const recentMatch = moodDoc.content.match(/## Recent[\s\S]*?### (\d{4}-\d{2}-\d{2})/);
    if (!recentMatch) {
      return { mood: null, energy: null, focus: null };
    }

    // Simple extraction of mood/energy from most recent entry
    const moodMatch = moodDoc.content.match(/Mood:\s*([^\n]+)/i);
    const energyMatch = moodDoc.content.match(/Energy:\s*([^\n]+)/i);
    const focusMatch = moodDoc.content.match(/Focus:\s*([^\n]+)/i);

    return {
      mood: moodMatch?.[1]?.trim() || null,
      energy: energyMatch?.[1]?.trim() || null,
      focus: focusMatch?.[1]?.trim() || null,
    };
  }

  /**
   * Search message history semantically
   */
  private async searchSemanticHistory(
    userId: string,
    embedding: number[],
    limit: number
  ): Promise<SemanticMatch[]> {
    const matches = await this.supabase.searchMessages(userId, embedding, limit);

    return matches.map((m) => ({
      content: m.content,
      role: m.role as "user" | "assistant",
      tags: m.tags || [],
      createdAt: m.created_at,
      similarity: 0, // RPC doesn't return similarity for messages yet
    }));
  }

  /**
   * Estimate token count for context
   */
  private estimateTokens(
    masterIndex: Document | null,
    recentMessages: Message[],
    relevantDocs: RelevantDocument[],
    semanticMatches: SemanticMatch[]
  ): number {
    let total = 0;

    if (masterIndex) {
      total += TOKEN_ESTIMATES.masterIndex;
    }

    total += recentMessages.length * TOKEN_ESTIMATES.messageAverage;
    total += TOKEN_ESTIMATES.todaySnapshot;
    total += relevantDocs.length * TOKEN_ESTIMATES.docSummary;
    total += semanticMatches.length * TOKEN_ESTIMATES.semanticMatch;

    return total;
  }

  /**
   * Format context for Claude's system prompt
   */
  formatForPrompt(context: AssembledContext): string {
    const sections: string[] = [];

    // Master Index (always first)
    if (context.masterIndex) {
      sections.push(`<document_map>\n${context.masterIndex}\n</document_map>`);
    }

    // Today's State
    const { todaySnapshot } = context;
    if (todaySnapshot.mood || todaySnapshot.energy || todaySnapshot.focus) {
      const stateLines = [];
      if (todaySnapshot.mood) stateLines.push(`Mood: ${todaySnapshot.mood}`);
      if (todaySnapshot.energy) stateLines.push(`Energy: ${todaySnapshot.energy}`);
      if (todaySnapshot.focus) stateLines.push(`Focus: ${todaySnapshot.focus}`);
      stateLines.push(`Open tasks: ${todaySnapshot.openTasks}`);
      sections.push(`<today_state>\n${stateLines.join("\n")}\n</today_state>`);
    }

    // Relevant Documents (summaries only)
    if (context.relevantDocs.length > 0) {
      const docLines = context.relevantDocs.map(
        (d) => `- ${d.path}: ${d.summary || "No summary"}`
      );
      sections.push(`<relevant_documents>\n${docLines.join("\n")}\n</relevant_documents>`);
    }

    // Semantic Matches (from history)
    if (context.semanticMatches.length > 0) {
      const matchLines = context.semanticMatches.map((m) => {
        const date = new Date(m.createdAt).toLocaleDateString();
        const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        return `[${date}]${tags} ${m.role}: ${m.content.substring(0, 200)}...`;
      });
      sections.push(`<relevant_history>\n${matchLines.join("\n\n")}\n</relevant_history>`);
    }

    return sections.join("\n\n");
  }
}
