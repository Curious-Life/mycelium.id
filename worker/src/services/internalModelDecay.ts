/**
 * Internal Model Decay Service
 * Manages the lifecycle of internal model items (hypotheses, questions, etc.)
 * with decay/reinforcement mechanics.
 *
 * Decay Rules:
 * - Not reinforced in 7 days + <2 reinforcements → archive
 * - Reinforced 3+ times → promote to "stable belief"
 * - Contradicted by evidence → flag for resolution
 */

import type { Env } from "../types/env";
import { createClient } from "@supabase/supabase-js";

export type ItemSection =
  | "hypotheses"
  | "questions"
  | "observations"
  | "contradictions"
  | "patterns"
  | "dream_fragments";

export type ItemStatus = "active" | "promoted" | "archived" | "resolved";

export interface InternalModelItem {
  id: string;
  user_id: string;
  section: ItemSection;
  content: string;
  embedding: number[] | null;
  created_at: string;
  last_reinforced_at: string;
  reinforcement_count: number;
  status: ItemStatus;
  source_cycle_id: string | null;
  metadata: Record<string, unknown>;
}

// Decay configuration
const DECAY_CONFIG = {
  // Days without reinforcement before archiving
  DECAY_DAYS: 7,
  // Minimum reinforcements to avoid decay
  MIN_REINFORCEMENTS_TO_SURVIVE: 2,
  // Reinforcements needed to promote to stable belief
  REINFORCEMENTS_TO_PROMOTE: 3,
  // Semantic similarity threshold for reinforcement detection
  REINFORCEMENT_SIMILARITY_THRESHOLD: 0.75,
};

export class InternalModelDecayService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private supabase: any;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /**
   * Create a new internal model item with embedding
   */
  async createItem(
    userId: string,
    section: ItemSection,
    content: string,
    embedding?: number[],
    sourceCycleId?: string
  ): Promise<InternalModelItem | null> {
    const { data, error } = await this.supabase
      .from("internal_model_items")
      .insert({
        user_id: userId,
        section,
        content,
        embedding: embedding || null,
        source_cycle_id: sourceCycleId || null,
      })
      .select()
      .single();

    if (error) {
      console.error("[Decay] Failed to create item:", error);
      return null;
    }

    console.log(`[Decay] Created ${section} item: ${data.id}`);
    return data;
  }

  /**
   * Get all active items for a user, optionally filtered by section
   */
  async getActiveItems(
    userId: string,
    section?: ItemSection
  ): Promise<InternalModelItem[]> {
    let query = this.supabase
      .from("internal_model_items")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: false });

    if (section) {
      query = query.eq("section", section);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[Decay] Failed to get items:", error);
      return [];
    }

    return data || [];
  }

  /**
   * Get items with embeddings for semantic matching
   */
  async getItemsWithEmbeddings(
    userId: string,
    section?: ItemSection
  ): Promise<Array<InternalModelItem & { embedding: number[] }>> {
    let query = this.supabase
      .from("internal_model_items")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .not("embedding", "is", null);

    if (section) {
      query = query.eq("section", section);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[Decay] Failed to get items with embeddings:", error);
      return [];
    }

    return data || [];
  }

  /**
   * Reinforce an item (called when semantic match detected)
   */
  async reinforceItem(itemId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("internal_model_items")
      .update({
        last_reinforced_at: new Date().toISOString(),
        reinforcement_count: this.supabase.rpc("increment_reinforcement", { item_id: itemId }),
      })
      .eq("id", itemId)
      .select()
      .single();

    if (error) {
      // Fallback: fetch current count and update manually
      const { data: current } = await this.supabase
        .from("internal_model_items")
        .select("reinforcement_count")
        .eq("id", itemId)
        .single();

      if (current) {
        const newCount = (current.reinforcement_count || 0) + 1;
        await this.supabase
          .from("internal_model_items")
          .update({
            last_reinforced_at: new Date().toISOString(),
            reinforcement_count: newCount,
          })
          .eq("id", itemId);

        // Check if should promote
        if (newCount >= DECAY_CONFIG.REINFORCEMENTS_TO_PROMOTE) {
          await this.promoteItem(itemId);
        }

        console.log(`[Decay] Reinforced item ${itemId} (count: ${newCount})`);
        return true;
      }
      return false;
    }

    // Check if should promote
    if (data && data.reinforcement_count >= DECAY_CONFIG.REINFORCEMENTS_TO_PROMOTE) {
      await this.promoteItem(itemId);
    }

    console.log(`[Decay] Reinforced item ${itemId}`);
    return true;
  }

  /**
   * Promote an item to "stable belief" status
   */
  async promoteItem(itemId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from("internal_model_items")
      .update({ status: "promoted" })
      .eq("id", itemId);

    if (error) {
      console.error("[Decay] Failed to promote item:", error);
      return false;
    }

    console.log(`[Decay] Promoted item ${itemId} to stable belief`);
    return true;
  }

  /**
   * Archive an item (decayed due to lack of reinforcement)
   */
  async archiveItem(itemId: string): Promise<boolean> {
    const { error } = await this.supabase
      .from("internal_model_items")
      .update({ status: "archived" })
      .eq("id", itemId);

    if (error) {
      console.error("[Decay] Failed to archive item:", error);
      return false;
    }

    console.log(`[Decay] Archived item ${itemId}`);
    return true;
  }

  /**
   * Find items that semantically match given content
   * Used for reinforcement detection during conversations/reflections
   */
  async findMatchingItems(
    userId: string,
    embedding: number[],
    threshold: number = DECAY_CONFIG.REINFORCEMENT_SIMILARITY_THRESHOLD
  ): Promise<Array<{ item: InternalModelItem; similarity: number }>> {
    // Use Supabase's vector similarity search
    const { data, error } = await this.supabase.rpc("match_internal_model_items", {
      query_embedding: embedding,
      match_user_id: userId,
      match_threshold: threshold,
      match_count: 10,
    });

    if (error) {
      console.error("[Decay] Failed to find matching items:", error);
      return [];
    }

    return (data || []).map((row: { id: string; similarity: number } & InternalModelItem) => ({
      item: row,
      similarity: row.similarity,
    }));
  }

  /**
   * Detect and reinforce items based on content embedding
   * Call this during reflections and conversations
   */
  async detectAndReinforce(
    userId: string,
    contentEmbedding: number[]
  ): Promise<{ reinforced: number; items: string[] }> {
    const matches = await this.findMatchingItems(userId, contentEmbedding);

    const reinforcedItems: string[] = [];
    for (const { item, similarity } of matches) {
      if (similarity >= DECAY_CONFIG.REINFORCEMENT_SIMILARITY_THRESHOLD) {
        const success = await this.reinforceItem(item.id);
        if (success) {
          reinforcedItems.push(item.content.substring(0, 50));
        }
      }
    }

    if (reinforcedItems.length > 0) {
      console.log(`[Decay] Reinforced ${reinforcedItems.length} items for user ${userId}`);
    }

    return {
      reinforced: reinforcedItems.length,
      items: reinforcedItems,
    };
  }

  /**
   * Run decay cycle for a user
   * Archives items that haven't been reinforced enough
   * Returns count of items archived and promoted
   */
  async runDecayCycle(userId: string): Promise<{
    archived: number;
    promoted: number;
    total_active: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DECAY_CONFIG.DECAY_DAYS);

    // Find items to archive (old, not reinforced enough, still active)
    const { data: toArchive, error: archiveError } = await this.supabase
      .from("internal_model_items")
      .select("id, content, section")
      .eq("user_id", userId)
      .eq("status", "active")
      .lt("last_reinforced_at", cutoffDate.toISOString())
      .lt("reinforcement_count", DECAY_CONFIG.MIN_REINFORCEMENTS_TO_SURVIVE);

    if (archiveError) {
      console.error("[Decay] Failed to find items to archive:", archiveError);
      return { archived: 0, promoted: 0, total_active: 0 };
    }

    // Archive old unreinforced items
    let archivedCount = 0;
    for (const item of toArchive || []) {
      const success = await this.archiveItem(item.id);
      if (success) {
        archivedCount++;
        console.log(`[Decay] Archived ${item.section}: "${item.content.substring(0, 40)}..."`);
      }
    }

    // Find items to promote (well-reinforced)
    const { data: toPromote, error: promoteError } = await this.supabase
      .from("internal_model_items")
      .select("id, content, section")
      .eq("user_id", userId)
      .eq("status", "active")
      .gte("reinforcement_count", DECAY_CONFIG.REINFORCEMENTS_TO_PROMOTE);

    if (promoteError) {
      console.error("[Decay] Failed to find items to promote:", promoteError);
    }

    // Promote well-reinforced items
    let promotedCount = 0;
    for (const item of toPromote || []) {
      const success = await this.promoteItem(item.id);
      if (success) {
        promotedCount++;
        console.log(`[Decay] Promoted ${item.section}: "${item.content.substring(0, 40)}..."`);
      }
    }

    // Get total active count
    const { count: totalActive } = await this.supabase
      .from("internal_model_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active");

    console.log(`[Decay] Cycle complete for ${userId}: ${archivedCount} archived, ${promotedCount} promoted, ${totalActive || 0} active`);

    return {
      archived: archivedCount,
      promoted: promotedCount,
      total_active: totalActive || 0,
    };
  }

  /**
   * Get decay statistics for a user
   */
  async getDecayStats(userId: string): Promise<{
    active: number;
    promoted: number;
    archived: number;
    by_section: Record<string, number>;
  }> {
    const { data, error } = await this.supabase
      .from("internal_model_items")
      .select("status, section")
      .eq("user_id", userId);

    if (error || !data) {
      return { active: 0, promoted: 0, archived: 0, by_section: {} };
    }

    const stats = {
      active: 0,
      promoted: 0,
      archived: 0,
      by_section: {} as Record<string, number>,
    };

    for (const item of data) {
      if (item.status === "active") stats.active++;
      else if (item.status === "promoted") stats.promoted++;
      else if (item.status === "archived") stats.archived++;

      const sectionKey = `${item.section}_${item.status}`;
      stats.by_section[sectionKey] = (stats.by_section[sectionKey] || 0) + 1;
    }

    return stats;
  }
}

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
