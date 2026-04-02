/**
 * Cycle Metrics Service
 * Tracks observability metrics for autonomous cycles (reflection, dream, etc.)
 */

import type { Env } from "../types/env";
import { createClient } from "@supabase/supabase-js";

export type CycleType = 'reflection' | 'dream' | 'morning' | 'evening' | 'weekly' | 'triage';

export interface CycleItemsCounts {
  hypotheses?: number;
  questions?: number;
  flags?: number;
  dream_fragments?: number;
  topology_notes?: number;
  observations?: number;
}

export interface CycleMetricsRecord {
  id: string;
  user_id: string;
  cycle_type: CycleType;
  started_at: string;
  completed_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  items_created: CycleItemsCounts;
  items_pruned: number;
  exploration_calls_used: number;
  exploration_budget: number;
  quality_score: number | null;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  error_message: string | null;
  metadata: Record<string, unknown>;
}

// Pricing per million tokens (Sonnet 4.5)
const PRICING = {
  input: 3,   // $3 / MTok
  output: 15  // $15 / MTok
};

export class CycleMetricsService {
  private supabase;

  constructor(env: Env) {
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /**
   * Start a new cycle and return a tracker object
   */
  async startCycle(
    userId: string,
    cycleType: CycleType,
    metadata?: Record<string, unknown>
  ): Promise<CycleTracker> {
    const { data, error } = await this.supabase
      .from('cycle_metrics')
      .insert({
        user_id: userId,
        cycle_type: cycleType,
        status: 'running',
        metadata: metadata || {}
      })
      .select('id')
      .single();

    if (error) {
      console.error(`[CycleMetrics] Failed to start ${cycleType} cycle:`, error);
      // Return a no-op tracker on error
      return new NoOpCycleTracker();
    }

    console.log(`[CycleMetrics] Started ${cycleType} cycle: ${data.id}`);
    return new CycleTracker(this.supabase, data.id, cycleType);
  }

  /**
   * Get recent cycles for a user
   */
  async getRecentCycles(
    userId: string,
    limit: number = 20
  ): Promise<CycleMetricsRecord[]> {
    const { data, error } = await this.supabase
      .from('cycle_metrics')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[CycleMetrics] Failed to get recent cycles:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Get aggregate stats for a user's cycles
   */
  async getCycleStats(
    userId: string,
    cycleType?: CycleType,
    daysBack: number = 7
  ): Promise<{
    total_cycles: number;
    completed_cycles: number;
    failed_cycles: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_cents: number;
    avg_quality_score: number | null;
    items_created_total: CycleItemsCounts;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    let query = this.supabase
      .from('cycle_metrics')
      .select('*')
      .eq('user_id', userId)
      .gte('started_at', since.toISOString());

    if (cycleType) {
      query = query.eq('cycle_type', cycleType);
    }

    const { data, error } = await query;

    if (error || !data) {
      console.error('[CycleMetrics] Failed to get cycle stats:', error);
      return {
        total_cycles: 0,
        completed_cycles: 0,
        failed_cycles: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_cents: 0,
        avg_quality_score: null,
        items_created_total: {}
      };
    }

    const stats = {
      total_cycles: data.length,
      completed_cycles: data.filter(c => c.status === 'completed').length,
      failed_cycles: data.filter(c => c.status === 'failed').length,
      total_input_tokens: data.reduce((sum, c) => sum + (c.input_tokens || 0), 0),
      total_output_tokens: data.reduce((sum, c) => sum + (c.output_tokens || 0), 0),
      total_cost_cents: data.reduce((sum, c) => sum + (c.cost_cents || 0), 0),
      avg_quality_score: null as number | null,
      items_created_total: {} as CycleItemsCounts
    };

    // Calculate average quality score
    const qualityScores = data.filter(c => c.quality_score != null).map(c => c.quality_score);
    if (qualityScores.length > 0) {
      stats.avg_quality_score = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
    }

    // Aggregate items created
    for (const cycle of data) {
      const items = cycle.items_created as CycleItemsCounts || {};
      for (const [key, value] of Object.entries(items)) {
        const k = key as keyof CycleItemsCounts;
        stats.items_created_total[k] = (stats.items_created_total[k] || 0) + (value || 0);
      }
    }

    return stats;
  }
}

/**
 * Tracker object for an individual cycle
 * Accumulates metrics during the cycle and writes them on completion
 */
export class CycleTracker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private supabase: any;
  private cycleId: string;
  private cycleType: CycleType;

  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private itemsCreated: CycleItemsCounts = {};
  private itemsPruned: number = 0;
  private explorationCallsUsed: number = 0;
  private explorationBudget: number = 0;
  private qualityScore: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(supabase: any, cycleId: string, cycleType: CycleType) {
    this.supabase = supabase;
    this.cycleId = cycleId;
    this.cycleType = cycleType;
  }

  /**
   * Add token usage from a Claude call
   */
  addUsage(inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }

  /**
   * Record an item created during the cycle
   */
  recordItemCreated(type: keyof CycleItemsCounts): void {
    this.itemsCreated[type] = (this.itemsCreated[type] || 0) + 1;
  }

  /**
   * Record items pruned (for decay cycles)
   */
  recordItemsPruned(count: number): void {
    this.itemsPruned += count;
  }

  /**
   * Set exploration stats (for dream cycle)
   */
  setExplorationStats(callsUsed: number, budget: number): void {
    this.explorationCallsUsed = callsUsed;
    this.explorationBudget = budget;
  }

  /**
   * Set quality score (0.0 - 1.0)
   */
  setQualityScore(score: number): void {
    this.qualityScore = Math.max(0, Math.min(1, score));
  }

  /**
   * Mark cycle as completed and write all metrics
   */
  async complete(metadata?: Record<string, unknown>): Promise<void> {
    const costCents = Math.ceil(
      (this.inputTokens / 1_000_000) * PRICING.input +
      (this.outputTokens / 1_000_000) * PRICING.output
    ) * 100;

    const { error } = await this.supabase
      .from('cycle_metrics')
      .update({
        completed_at: new Date().toISOString(),
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        cost_cents: costCents,
        items_created: this.itemsCreated,
        items_pruned: this.itemsPruned,
        exploration_calls_used: this.explorationCallsUsed,
        exploration_budget: this.explorationBudget,
        quality_score: this.qualityScore,
        status: 'completed',
        metadata: metadata || {}
      })
      .eq('id', this.cycleId);

    if (error) {
      console.error(`[CycleMetrics] Failed to complete ${this.cycleType} cycle:`, error);
    } else {
      console.log(`[CycleMetrics] Completed ${this.cycleType}: ${this.inputTokens} in, ${this.outputTokens} out, ${costCents}¢`);
    }
  }

  /**
   * Mark cycle as failed
   */
  async fail(errorMessage: string): Promise<void> {
    const { error } = await this.supabase
      .from('cycle_metrics')
      .update({
        completed_at: new Date().toISOString(),
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        status: 'failed',
        error_message: errorMessage
      })
      .eq('id', this.cycleId);

    if (error) {
      console.error(`[CycleMetrics] Failed to record failure for ${this.cycleType}:`, error);
    } else {
      console.log(`[CycleMetrics] Failed ${this.cycleType}: ${errorMessage}`);
    }
  }

  /**
   * Mark cycle as skipped (e.g., budget exceeded)
   */
  async skip(reason: string): Promise<void> {
    const { error } = await this.supabase
      .from('cycle_metrics')
      .update({
        completed_at: new Date().toISOString(),
        status: 'skipped',
        error_message: reason
      })
      .eq('id', this.cycleId);

    if (error) {
      console.error(`[CycleMetrics] Failed to record skip for ${this.cycleType}:`, error);
    }
  }
}

/**
 * No-op tracker for when metrics recording fails
 */
class NoOpCycleTracker extends CycleTracker {
  constructor() {
    // Pass dummy values - this tracker does nothing
    super(null as unknown as ReturnType<typeof createClient>, '', 'reflection');
  }

  addUsage(): void {}
  recordItemCreated(): void {}
  recordItemsPruned(): void {}
  setExplorationStats(): void {}
  setQualityScore(): void {}
  async complete(): Promise<void> {}
  async fail(): Promise<void> {}
  async skip(): Promise<void> {}
}
