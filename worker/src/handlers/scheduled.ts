import type { Env } from "../types/env";
import { TelegramService } from "../services/telegram";
import { SupabaseService } from "../services/supabase";
import { ClaudeService, type InternalModel, type ClaudeUsage } from "../services/claude";
import { WorkersAIService } from "../services/workersai";
import { MasterIndexGenerator } from "../documents/masterIndex";
import { DocumentManager } from "../documents/manager";
import { ToolExecutor } from "../tools/executor";
import { CycleMetricsService, type CycleTracker } from "../services/cycleMetrics";
import { InternalModelDecayService } from "../services/internalModelDecay";
import { buildMorningPrompt, type MorningContext } from "../prompts/morning";
import { buildEveningPrompt, type EveningContext } from "../prompts/evening";
import { buildWeeklyPrompt, type WeeklyContext } from "../prompts/weekly";
import { buildReflectionPrompt, type ReflectionContext } from "../prompts/reflection";
import { buildTriagePrompt, type TriageContext } from "../prompts/triage";
import {
  buildDreamPrompt,
  buildFreeformDreamPrompt,
  buildPostDreamReflectionPrompt,
  buildDirectedExplorationPrompt,
  buildDreamSystemPrompt,
  EXPLORATION_SYSTEM_PROMPT,
  EXPLORATION_BUDGET,
  type DreamContext,
  type TopologyContext,
} from "../prompts/dream";
import type Anthropic from "@anthropic-ai/sdk";

// Pricing per million tokens (Sonnet 4.5)
const PRICING = {
  input: 3,   // $3 / MTok
  output: 15  // $15 / MTok
};

/**
 * Check if user has budget remaining before running scheduled job
 * Returns true if job should proceed, false if budget exceeded
 */
async function checkScheduledBudget(
  supabase: SupabaseService,
  userId: string,
  jobName: string
): Promise<boolean> {
  const budgetCheck = await supabase.checkBudget(userId);
  if (budgetCheck && !budgetCheck.allowed) {
    console.log(`${jobName}: Skipping - user budget exceeded ($${(budgetCheck.used_cents / 100).toFixed(2)}/$${(budgetCheck.budget_limit_cents / 100).toFixed(2)})`);
    return false;
  }
  return true;
}

/**
 * Track scheduled job usage (fire and forget - don't block)
 */
function trackScheduledUsage(
  supabase: SupabaseService,
  userId: string,
  usage: ClaudeUsage,
  jobName: string
): void {
  const costDollars = (usage.inputTokens / 1_000_000) * PRICING.input +
                      (usage.outputTokens / 1_000_000) * PRICING.output;
  const costCents = Math.ceil(costDollars * 100);

  supabase.trackUsage(userId, usage.inputTokens, usage.outputTokens, costCents)
    .then(() => {
      console.log(`${jobName}: Tracked ${usage.inputTokens} input, ${usage.outputTokens} output tokens ($${costDollars.toFixed(4)})`);
    })
    .catch((err) => {
      console.error(`${jobName}: Failed to track usage:`, err);
    });
}

/**
 * Handle morning check-in (multi-user)
 * Runs hourly, processes users where local time is 8am
 */
export async function handleMorningCheckIn(env: Env): Promise<void> {
  console.log("Starting morning check-in job...");

  const supabase = new SupabaseService(env);
  const telegram = new TelegramService(env);
  const claude = new ClaudeService(env);

  const users = await supabase.getActiveUsers();
  console.log(`Morning check-in: Found ${users.length} active users`);

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);
    if (userHour !== 8) continue;

    console.log(`Morning check-in: Processing user ${user.id} (${user.timezone || "UTC"})`);

    // Check if morning check-in is enabled for this user
    const isEnabled = await supabase.isScheduledEventEnabled(user.id, "morning");
    if (!isEnabled) {
      console.log(`Morning check-in: Skipping user ${user.id} - morning check-in disabled`);
      continue;
    }

    // Budget check - skip if user exceeded budget
    if (!(await checkScheduledBudget(supabase, user.id, "Morning check-in"))) {
      continue;
    }

    // Start cycle metrics tracking
    const metricsService = new CycleMetricsService(env);
    const tracker = await metricsService.startCycle(user.id, "morning");

    try {
      // Load all context in parallel
      const [
        yesterdayMessages,
        todoDoc,
        commPrefsDoc,
        moodDoc,
        internalModelDoc,
        reflectionDoc,
        yesterdayTerritories,
        territoryFlow,
        unexpectedConnections,
        gaps,
      ] = await Promise.all([
        supabase.getYesterdayMessages(user.id),
        supabase.getDocument(user.id, "core/todo"),
        supabase.getDocument(user.id, "core/communication"),
        supabase.getDocument(user.id, "states/mood_energy"),
        supabase.getDocument(user.id, "internal/model"),
        supabase.getDocument(user.id, "internal/reflection_log"),
        supabase.getTodayTerritories(user.id, 24), // Last 24h = yesterday
        supabase.getTerritoryFlow(user.id, 24),
        supabase.getUnexpectedConnections(user.id, 0.35, 0.5, 3),
        supabase.getTopGaps(user.id, 0.65, 0.2, 3),
      ]);

      console.log(`Morning: Found ${yesterdayMessages.length} messages from yesterday for user ${user.id}`);

      // Extract people mentioned
      const yesterdayPeople = [...new Set(yesterdayMessages.flatMap((m) => m.entities_people || []))];

      // Parse internal model
      const internalModel = internalModelDoc
        ? parseInternalModel(internalModelDoc.content)
        : null;

      // Get flagged topics
      const flaggedTopics = extractFlaggedTopics(reflectionDoc?.content || "");

      const dayOfWeek = new Date().toLocaleDateString("en-US", { weekday: "long" });

      // Build morning context
      const context: MorningContext = {
        userName: user.display_name || user.username || "there",
        dayOfWeek,
        todoContent: todoDoc?.content || null,
        commPrefsContent: commPrefsDoc?.content || null,
        recentMood: extractRecentMood(moodDoc?.content || ""),
        yesterdayMessages: yesterdayMessages.map((m) => ({
          role: m.role,
          content: m.content,
          tags: m.tags || [],
          timestamp: new Date(m.created_at).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          }),
        })),
        yesterdayMentionedPeople: yesterdayPeople,
        internalModel,
        flaggedTopics,
        topology: {
          yesterdayTerritories: yesterdayTerritories.map((t) => ({
            name: t.name,
            message_count: t.message_count,
          })),
          territoryFlow: territoryFlow.map((t) => t.name),
          unexpectedConnections: unexpectedConnections.map((c) => ({
            a: c.territory_a_name,
            b: c.territory_b_name,
          })),
          gaps: gaps.map((g) => ({
            a: g.territory_a_name,
            b: g.territory_b_name,
          })),
        },
      };

      // Build prompt and call Claude with tools enabled
      console.log(`Morning: Calling Claude with tools for user ${user.id}...`);
      const prompt = buildMorningPrompt(context);

      // Track total usage across all Claude calls
      const totalUsage: ClaudeUsage = { inputTokens: 0, outputTokens: 0 };

      // Use full conversation context so tools work
      let response = await claude.chat(prompt, {
        masterIndex: null,
        recentMessages: [],
        currentTags: [],
        internalModel: internalModel,
        flaggedItems: flaggedTopics.map((t) => ({ topic: t, context: "", timestamp: "" })),
        todoDoc: todoDoc?.content || null,
        commPrefsDoc: commPrefsDoc?.content || null,
        pinnedDocs: [],
        availableFolders: [],
        availableCanvases: [],
      });
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      tracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);

      // Handle tool calls if any (allow up to 3 rounds)
      const toolExecutor = new ToolExecutor(env, user.id);
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
      let rounds = 0;

      while (response.toolCalls.length > 0 && rounds < 3) {
        console.log(`Morning: Executing ${response.toolCalls.length} tool calls (round ${rounds + 1})`);
        const toolResults = await toolExecutor.executeAll(response.toolCalls);

        // Add assistant's tool calls to message history
        messages.push({
          role: "assistant",
          content: response.toolCalls.map((tc) => ({
            type: "tool_use" as const,
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })),
        });

        // Continue conversation with tool results
        response = await claude.continueWithToolResults(messages, toolResults);
        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;
        tracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);
        rounds++;
      }

      console.log(`Morning: Sending to Telegram for user ${user.id}...`);
      await telegram.sendMessage(String(user.telegram_id), response.content);

      // Track usage (fire and forget - existing budget tracking)
      trackScheduledUsage(supabase, user.id, totalUsage, "Morning check-in");

      // Complete cycle tracking
      await tracker.complete();
      console.log(`Morning check-in completed for user ${user.id}`);
    } catch (error) {
      await tracker.fail(error instanceof Error ? error.message : "Unknown error");
      console.error(`Morning check-in failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      console.error("Stack:", error instanceof Error ? error.stack : "");
      // Continue to next user even if one fails
    }
  }

  console.log("Morning check-in job completed");
}

/**
 * Handle evening check-in (multi-user)
 * Runs hourly, processes users where local time is 9pm
 */
export async function handleEveningCheckIn(env: Env): Promise<void> {
  console.log("Starting evening check-in job...");

  const supabase = new SupabaseService(env);
  const telegram = new TelegramService(env);
  const claude = new ClaudeService(env);

  const users = await supabase.getActiveUsers();
  console.log(`Evening check-in: Found ${users.length} active users`);

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);
    if (userHour !== 21) continue;

    console.log(`Evening check-in: Processing user ${user.id} (${user.timezone || "UTC"})`);

    // Check if evening check-in is enabled for this user
    const isEnabled = await supabase.isScheduledEventEnabled(user.id, "evening");
    if (!isEnabled) {
      console.log(`Evening check-in: Skipping user ${user.id} - evening check-in disabled`);
      continue;
    }

    // Budget check - skip if user exceeded budget
    if (!(await checkScheduledBudget(supabase, user.id, "Evening check-in"))) {
      continue;
    }

    // Start cycle metrics tracking
    const metricsService = new CycleMetricsService(env);
    const tracker = await metricsService.startCycle(user.id, "evening");

    try {
      // Load all context in parallel
      const [
        todayMessages,
        todoDoc,
        commPrefsDoc,
        moodDoc,
        internalModelDoc,
        reflectionDoc,
        todayTerritories,
        territoryFlow,
        unexpectedConnections,
        gaps,
      ] = await Promise.all([
        supabase.getTodayMessages(user.id),
        supabase.getDocument(user.id, "core/todo"),
        supabase.getDocument(user.id, "core/communication"),
        supabase.getDocument(user.id, "states/mood_energy"),
        supabase.getDocument(user.id, "internal/model"),
        supabase.getDocument(user.id, "internal/reflection_log"),
        supabase.getTodayTerritories(user.id, 18), // Today's territories
        supabase.getTerritoryFlow(user.id, 18),
        supabase.getUnexpectedConnections(user.id, 0.35, 0.5, 3),
        supabase.getTopGaps(user.id, 0.65, 0.2, 3),
      ]);

      console.log(`Evening: Found ${todayMessages.length} messages from today for user ${user.id}`);

      // Extract people mentioned
      const todayPeople = [...new Set(todayMessages.flatMap((m) => m.entities_people || []))];

      // Parse internal model
      const internalModel = internalModelDoc
        ? parseInternalModel(internalModelDoc.content)
        : null;

      // Get flagged topics
      const flaggedTopics = extractFlaggedTopics(reflectionDoc?.content || "");

      // Build evening context
      const context: EveningContext = {
        userName: user.display_name || user.username || "there",
        todoContent: todoDoc?.content || null,
        commPrefsContent: commPrefsDoc?.content || null,
        recentMood: extractRecentMood(moodDoc?.content || ""),
        todayMessages: todayMessages.map((m) => ({
          role: m.role,
          content: m.content,
          tags: m.tags || [],
          timestamp: new Date(m.created_at).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          }),
        })),
        todayMentionedPeople: todayPeople,
        internalModel,
        flaggedTopics,
        topology: {
          todayTerritories: todayTerritories.map((t) => ({
            name: t.name,
            message_count: t.message_count,
          })),
          territoryFlow: territoryFlow.map((t) => t.name),
          unexpectedConnections: unexpectedConnections.map((c) => ({
            a: c.territory_a_name,
            b: c.territory_b_name,
          })),
          gaps: gaps.map((g) => ({
            a: g.territory_a_name,
            b: g.territory_b_name,
          })),
        },
      };

      // Build prompt and call Claude with tools enabled
      console.log(`Evening: Calling Claude with tools for user ${user.id}...`);
      const prompt = buildEveningPrompt(context);

      // Track total usage across all Claude calls
      const totalUsage: ClaudeUsage = { inputTokens: 0, outputTokens: 0 };

      // Use full conversation context so tools work
      let response = await claude.chat(prompt, {
        masterIndex: null,
        recentMessages: [],
        currentTags: [],
        internalModel: internalModel,
        flaggedItems: flaggedTopics.map((t) => ({ topic: t, context: "", timestamp: "" })),
        todoDoc: todoDoc?.content || null,
        commPrefsDoc: commPrefsDoc?.content || null,
        pinnedDocs: [],
        availableFolders: [],
        availableCanvases: [],
      });
      totalUsage.inputTokens += response.usage.inputTokens;
      totalUsage.outputTokens += response.usage.outputTokens;
      tracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);

      // Handle tool calls if any (allow up to 3 rounds)
      const toolExecutor = new ToolExecutor(env, user.id);
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
      let rounds = 0;

      while (response.toolCalls.length > 0 && rounds < 3) {
        console.log(`Evening: Executing ${response.toolCalls.length} tool calls (round ${rounds + 1})`);
        const toolResults = await toolExecutor.executeAll(response.toolCalls);

        // Add assistant's tool calls to message history
        messages.push({
          role: "assistant",
          content: response.toolCalls.map((tc) => ({
            type: "tool_use" as const,
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })),
        });

        // Continue conversation with tool results
        response = await claude.continueWithToolResults(messages, toolResults);
        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;
        tracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);
        rounds++;
      }

      console.log(`Evening: Sending to Telegram for user ${user.id}...`);
      await telegram.sendMessage(String(user.telegram_id), response.content);

      // Track usage (fire and forget - existing budget tracking)
      trackScheduledUsage(supabase, user.id, totalUsage, "Evening check-in");

      // Complete cycle tracking
      await tracker.complete();
      console.log(`Evening check-in completed for user ${user.id}`);
    } catch (error) {
      await tracker.fail(error instanceof Error ? error.message : "Unknown error");
      console.error(`Evening check-in failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      console.error("Stack:", error instanceof Error ? error.stack : "");
      // Continue to next user even if one fails
    }
  }

  console.log("Evening check-in job completed");
}

/**
 * Handle weekly review (multi-user)
 * Runs hourly, processes users where local time is Sunday 10am
 */
export async function handleWeeklyReview(env: Env): Promise<void> {
  console.log("Starting weekly review job...");

  const supabase = new SupabaseService(env);
  const telegram = new TelegramService(env);

  const users = await supabase.getActiveUsers();
  console.log(`Weekly review: Found ${users.length} active users`);

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);

    // Check if it's Sunday at 10am in user's timezone
    const now = new Date();
    const userDayFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: user.timezone || "UTC",
      weekday: "long",
    });
    const userDay = userDayFormatter.format(now);

    if (userDay !== "Sunday" || userHour !== 10) continue;

    console.log(`Weekly review: Processing user ${user.id} (${user.timezone || "UTC"})`);

    try {
      // Get week's data (simplified - could be more sophisticated)
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);

      // For now, just get recent messages as approximation
      const recentMessages = await supabase.getRecentMessages(user.id, 100);
      const weekMessages = recentMessages.filter(
        (m) => new Date(m.created_at) >= weekStart
      );

      // Count tags
      const tagCounts = new Map<string, number>();
      weekMessages.forEach((m) => {
        (m.tags || []).forEach((tag) => {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        });
      });

      const topTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag, count]) => ({ tag, count }));

      // Get mentioned people
      const mentionedPeople = [...new Set(
        weekMessages.flatMap((m) => m.entities_people || [])
      )];

      const weekNumber = getWeekNumber(new Date());

      const context: WeeklyContext = {
        userName: user.display_name || user.username || "there",
        weekNumber,
        messageCount: weekMessages.length,
        topTags,
        mentionedPeople,
        completedTasks: 0, // Could fetch from tasks
        openTasks: (await supabase.getOpenTasks(user.id)).length,
        newInsights: [], // Could fetch from phenomena/insights
        dreamCount: 0, // Could count from dreams doc
        moodTrend: null, // Could analyze from mood entries
      };

      const message = buildWeeklyPrompt(context);
      await telegram.sendMessage(String(user.telegram_id), message);
      console.log(`Weekly review sent to user ${user.id}`);
    } catch (error) {
      console.error(`Weekly review failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      // Continue to next user
    }
  }

  console.log("Weekly review job completed");
}

/**
 * Handle autonomous reflection (multi-user)
 * Runs hourly, processes users where local time is divisible by 4 (0, 4, 8, 12, 16, 20)
 * Updates internal model without messaging user
 */
export async function handleReflection(env: Env): Promise<void> {
  console.log("Starting reflection job...");

  const supabase = new SupabaseService(env);
  const claude = new ClaudeService(env);

  const users = await supabase.getActiveUsers();
  console.log(`Reflection: Found ${users.length} active users`);

  // Reflection runs every 4 hours in user's local time
  const REFLECTION_HOURS = [0, 4, 8, 12, 16, 20];

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);
    if (!REFLECTION_HOURS.includes(userHour)) continue;

    console.log(`Reflection: Processing user ${user.id} (${user.timezone || "UTC"}, hour ${userHour})`);

    // Budget check - skip if user exceeded budget
    if (!(await checkScheduledBudget(supabase, user.id, "Autonomous reflection"))) {
      continue;
    }

    try {
      await processReflection(supabase, claude, user, env);
    } catch (error) {
      console.error(`Reflection failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      // Continue to next user
    }
  }

  console.log("Reflection job completed");
}

/**
 * Process reflection for a single user
 */
async function processReflection(
  supabase: SupabaseService,
  claude: ClaudeService,
  user: { id: string; timezone: string | null },
  env: Env
): Promise<void> {
  console.log(`Starting reflection (topology-aware) for user ${user.id}...`);

  // Start cycle metrics tracking
  const metricsService = new CycleMetricsService(env);
  const tracker = await metricsService.startCycle(user.id, "reflection");

  // Initialize decay service for reinforcement detection
  const decayService = new InternalModelDecayService(env);
  const workersAI = new WorkersAIService(env);

  try {
    // Get recent messages (last 48h worth)
    const recentMessages = await supabase.getRecentMessages(user.id, 50);
    const messagesSummary = recentMessages
      .map((m) => `[${m.role}]: ${m.content.substring(0, 300)}`)
      .join("\n\n");

    // Get current internal model
    const internalModel = await supabase.getDocument(user.id, "internal/model");
    const reflectionLog = await supabase.getDocument(user.id, "internal/reflection_log");

    // Query topology data for reflection context
    const recentTerritories = await supabase.getTodayTerritories(user.id, 48); // Last 48h
    const topGaps = await supabase.getTopGaps(user.id, 0.65, 0.2, 5);
    const unexpectedConnections = await supabase.getUnexpectedConnections(user.id, 0.35, 0.5, 5);
    const orphans = await supabase.getOrphanTerritories(user.id, 50, 3, "weekly", 5);

    const context: ReflectionContext = {
      recentMessages: messagesSummary,
      masterIndex: "", // Not needed for reflection
      internalModelSummary: internalModel?.summary || "No internal model yet",
      currentHypotheses: extractHypotheses(internalModel?.content || ""),
      openQuestions: extractQuestions(internalModel?.content || ""),
      lastReflection: extractLastReflection(reflectionLog?.content || ""),
      // Add topology context
      topology: {
        recentTerritories: recentTerritories.map((t) => ({
          name: t.name,
          message_count: t.message_count,
        })),
        topGaps: topGaps.map((g) => ({
          territory_a_name: g.territory_a_name,
          territory_b_name: g.territory_b_name,
          gap_score: g.gap_score,
        })),
        unexpectedConnections: unexpectedConnections.map((c) => ({
          territory_a_name: c.territory_a_name,
          territory_b_name: c.territory_b_name,
        })),
        orphans: orphans.map((o) => ({
          name: o.name,
          message_count: o.message_count,
        })),
      },
    };

    console.log(`Topology context: ${recentTerritories.length} territories, ${topGaps.length} gaps, ${unexpectedConnections.length} unexpected`);

    const prompt = buildReflectionPrompt(context);

    // Run reflection through Claude
    const response = await claude.chat(prompt, {
      masterIndex: null,
      recentMessages: [],
      currentTags: [],
      internalModel: null,
      flaggedItems: [],
      todoDoc: null,
      commPrefsDoc: null,
      pinnedDocs: [],
      availableFolders: [],
      availableCanvases: [],
    });

    // Track usage in cycle metrics
    tracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);

    // Track usage (fire and forget - existing budget tracking)
    trackScheduledUsage(supabase, user.id, response.usage, "Autonomous reflection");

    // Detect and reinforce matching internal model items
    try {
      const responseEmbedding = await workersAI.generateEmbedding(response.content);
      const reinforced = await decayService.detectAndReinforce(user.id, responseEmbedding);
      if (reinforced.reinforced > 0) {
        console.log(`[Decay] Reinforced ${reinforced.reinforced} items from reflection`);
      }
    } catch (e) {
      console.log("[Decay] Could not detect reinforcements:", e);
    }

    // Store reflection in log
    const timestamp = new Date().toISOString();
    const reflectionEntry = `\n\n## ${timestamp.split("T")[0]} ${timestamp.split("T")[1].substring(0, 5)}\n\n${response.content}`;

    if (reflectionLog) {
      await supabase.upsertDocument({
        user_id: user.id,
        path: "internal/reflection_log",
        title: "Reflection Log",
        content: reflectionLog.content + reflectionEntry,
        summary: `Last reflection: ${timestamp}`,
        is_internal: true,
        metadata: { lastReflection: timestamp },
      });
    }

    // Check for topology note in reflection output
    const topologyNoteMatch = response.content.match(/- topology_note:\s*([^\n]+)/);
    if (topologyNoteMatch && topologyNoteMatch[1].toLowerCase() !== "null") {
      try {
        const note = topologyNoteMatch[1].trim();
        const dateStr = timestamp.split("T")[0];

        let topologyDoc = await supabase.getDocument(user.id, "internal/topology_notes");
        if (topologyDoc) {
          const explorationLogMarker = "## Exploration Log";
          const content = topologyDoc.content;

          if (content.includes(explorationLogMarker)) {
            const newEntry = `\n\n### ${dateStr} (reflection)\n${note}`;
            const updated = content.replace(
              explorationLogMarker + "\n",
              explorationLogMarker + "\n" + newEntry + "\n"
            );
            await supabase.upsertDocument({
              user_id: user.id,
              path: "internal/topology_notes",
              title: "Topology Notes",
              content: updated,
              summary: "Spatial understanding of the mental geography",
              is_internal: true,
              metadata: { lastUpdate: timestamp },
            });
            console.log("Added topology note from reflection");
            tracker.recordItemCreated("observations");
          }
        }
      } catch (e) {
        console.log("Could not add topology note:", e);
      }
    }

    // Complete cycle tracking
    await tracker.complete();
    console.log("Reflection completed:", timestamp);
  } catch (error) {
    await tracker.fail(error instanceof Error ? error.message : "Unknown error");
    throw error;
  }
}

/**
 * Handle 3am "dream" (multi-user) - deep integration and pattern synthesis
 * Runs hourly, processes users where local time is 3am
 * Three-stage process:
 * 1. Free association (high temperature, no structure) - NO topology data
 * 2. Grounded reflection (topology-aware) - inject spatial data
 * 3. Directed exploration with tool budget
 */
export async function handleDream(env: Env): Promise<void> {
  console.log("Starting dream cycle job...");

  const supabase = new SupabaseService(env);
  const claude = new ClaudeService(env);
  const docManager = new DocumentManager(env);
  const workersAI = new WorkersAIService(env);

  const users = await supabase.getActiveUsers();
  console.log(`Dream cycle: Found ${users.length} active users`);

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);
    if (userHour !== 3) continue;

    console.log(`Dream cycle: Processing user ${user.id} (${user.timezone || "UTC"})`);

    // Budget check - skip if user exceeded budget
    if (!(await checkScheduledBudget(supabase, user.id, "Dream cycle"))) {
      continue;
    }

    try {
      await processDream(supabase, claude, docManager, workersAI, user.id, env);
    } catch (error) {
      console.error(`Dream cycle failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      // Continue to next user
    }
  }

  console.log("Dream cycle job completed");
}

/**
 * Process dream cycle for a single user
 */
async function processDream(
  supabase: SupabaseService,
  claude: ClaudeService,
  docManager: DocumentManager,
  workersAI: WorkersAIService,
  userId: string,
  env: Env
): Promise<void> {
  console.log(`Starting 3am dream cycle (topology-aware) for user ${userId}...`);

  // Start cycle metrics tracking
  const metricsService = new CycleMetricsService(env);
  const tracker = await metricsService.startCycle(userId, "dream", {
    explorationBudget: EXPLORATION_BUDGET,
  });

  // Track total usage across all dream phases
  const totalUsage: ClaudeUsage = { inputTokens: 0, outputTokens: 0 };

  try {
  // Get recent messages (last 24-48h)
  const recentMessages = await supabase.getRecentMessages(userId, 50);
  const messagesSummary = recentMessages
    .map((m) => `[${m.role}]: ${m.content.substring(0, 400)}`)
    .join("\n\n");

  // Get today's tags
  const todayMessages = await supabase.getTodayMessages(userId);
  const todayTags = [...new Set(todayMessages.flatMap((m) => m.tags || []))];

  // Get dreams document
  const dreamsDoc = await supabase.getDocument(userId, "states/dreams");
  const recentDreams = extractRecentDreams(dreamsDoc?.content || "");

  // Get synchronicities
  const syncDoc = await supabase.getDocument(userId, "phenomena/synchronicities");
  const recentSyncs = extractRecentSynchronicities(syncDoc?.content || "");

  // Get internal model
  const internalModel = await supabase.getDocument(userId, "internal/model");
  const masterIndex = await supabase.getMasterIndex(userId);

  const context: DreamContext = {
    recentMessages: messagesSummary,
    dreamsLogged: recentDreams,
    synchronicities: recentSyncs,
    currentHypotheses: extractHypotheses(internalModel?.content || ""),
    openQuestions: extractQuestions(internalModel?.content || ""),
    internalModelContent: internalModel?.content || "",
    masterIndex: masterIndex?.content || "",
    todayTags,
  };

  const timestamp = new Date().toISOString();

  // ============ PHASE 1: FREE ASSOCIATION ============
  // High temperature, no structure, pure dreaming - NO topology data here
  console.log("Phase 1: Free association dream...");

  const ownerName = env.OWNER_NAME || "User";
  const freeformPrompt = buildFreeformDreamPrompt(context, ownerName);
  const dreamResponse = await claude.dream(freeformPrompt, buildDreamSystemPrompt(ownerName), 1.0);
  totalUsage.inputTokens += dreamResponse.usage.inputTokens;
  totalUsage.outputTokens += dreamResponse.usage.outputTokens;
  tracker.addUsage(dreamResponse.usage.inputTokens, dreamResponse.usage.outputTokens);
  const rawDream = dreamResponse.content;

  // Store the raw dream - marked clearly as unprocessed dream content
  const reflectionLog = await supabase.getDocument(userId, "internal/reflection_log");
  if (reflectionLog) {
    const rawDreamEntry = `\n\n## ${timestamp.split("T")[0]} 03:00 [RAW DREAM]\n\n*This is unprocessed dream content - associative, possibly meaningful, possibly noise.*\n\n${rawDream}`;

    await supabase.upsertDocument({
      user_id: userId,
      path: "internal/reflection_log",
      title: "Reflection Log",
      content: reflectionLog.content + rawDreamEntry,
      summary: `Last dream: ${timestamp}`,
      is_internal: true,
      metadata: { lastDream: timestamp },
    });
  }

  console.log("Phase 1 complete. Raw dream logged.");

  // ============ QUERY TOPOLOGY DATA ============
  console.log("Querying topology data...");

  // Get today's territories
  const todayTerritories = await supabase.getTodayTerritories(userId, 24);

  // Get territory flow sequence
  const territoryFlow = await supabase.getTerritoryFlow(userId, 24);

  // Get orphan territories (high content, low connectivity)
  const orphans = await supabase.getOrphanTerritories(userId, 50, 3, "weekly", 10);

  // Get bridge territories
  const bridges = await supabase.getBridgeTerritories(userId, 2, "weekly", 10);

  // Get unexplored gaps (high semantic, low cofire)
  const gaps = await supabase.getTopGaps(userId, 0.65, 0.2, 10);

  // Get unexpected connections (high cofire, low semantic)
  const unexpectedConnections = await supabase.getUnexpectedConnections(userId, 0.35, 0.5, 10);

  // Get current topology notes
  const topologyNotesDoc = await supabase.getDocument(userId, "internal/topology_notes");

  const topology: TopologyContext = {
    todayTerritories,
    unexpectedConnections: unexpectedConnections.map((c) => ({
      territory_a_name: c.territory_a_name,
      territory_b_name: c.territory_b_name,
      semantic_similarity: c.semantic_similarity,
      cofire_strength: c.cofire_strength,
    })),
    gaps: gaps.map((g) => ({
      territory_a_name: g.territory_a_name,
      territory_b_name: g.territory_b_name,
      semantic_similarity: g.semantic_similarity,
      cofire_strength: g.cofire_strength,
      gap_score: g.gap_score,
    })),
    orphans: orphans.map((o) => ({
      name: o.name,
      essence: o.essence,
      message_count: o.message_count,
      connection_count: o.connection_count,
    })),
    bridges: bridges.map((b) => ({
      name: b.name,
      connected_realms: b.connected_realms,
      total_strength: b.total_cofire_strength,
    })),
    territoryFlow: territoryFlow.map((t) => ({
      name: t.name,
      timestamp: t.timestamp,
    })),
    topologyNotesContent: topologyNotesDoc?.content || "",
  };

  console.log(`Topology: ${todayTerritories.length} territories today, ${gaps.length} gaps, ${unexpectedConnections.length} unexpected`);

  // ============ PHASE 2: GROUNDED REFLECTION ============
  // Process the dream, ground against topology data
  console.log("Phase 2: Topology-grounded reflection...");

  const reflectionPrompt = buildPostDreamReflectionPrompt(rawDream, context, topology, ownerName);
  const reflection = await claude.chat(reflectionPrompt, {
    masterIndex: null,
    recentMessages: [],
    currentTags: [],
    internalModel: null,
    flaggedItems: [],
    todoDoc: null,
    commPrefsDoc: null,
    pinnedDocs: [],
    availableFolders: [],
    availableCanvases: [],
  });
  totalUsage.inputTokens += reflection.usage.inputTokens;
  totalUsage.outputTokens += reflection.usage.outputTokens;
  tracker.addUsage(reflection.usage.inputTokens, reflection.usage.outputTokens);

  // Append structured reflection to log
  const updatedLog = await supabase.getDocument(userId, "internal/reflection_log");
  if (updatedLog) {
    const reflectionEntry = `\n\n### Post-Dream Reflection (Topology-Grounded)\n\n${reflection.content}`;

    await supabase.upsertDocument({
      user_id: userId,
      path: "internal/reflection_log",
      title: "Reflection Log",
      content: updatedLog.content + reflectionEntry,
      summary: `Last dream: ${timestamp}`,
      is_internal: true,
      metadata: { lastDream: timestamp },
    });
  }

  // Parse reflection for updates to internal model
  // Look for "New topology hypothesis:" and add to internal model
  const hypothesisMatch = reflection.content.match(/\*\*New topology hypothesis:\*\*\s*([^\n]+)/);
  if (hypothesisMatch && hypothesisMatch[1].toLowerCase() !== "null") {
    try {
      await docManager.updateInternalModel(userId, "hypotheses", hypothesisMatch[1].trim());
      console.log("Added new topology hypothesis from dream");
      tracker.recordItemCreated("hypotheses");
    } catch (e) {
      console.log("Could not add hypothesis:", e);
    }
  }

  // Look for "Question to hold:" and add to questions
  const questionMatch = reflection.content.match(/\*\*Question to hold:\*\*\s*([^\n]+)/);
  if (questionMatch && questionMatch[1].toLowerCase() !== "null") {
    try {
      await docManager.updateInternalModel(userId, "questions", questionMatch[1].trim());
      console.log("Added new question from dream");
      tracker.recordItemCreated("questions");
    } catch (e) {
      console.log("Could not add question:", e);
    }
  }

  // Look for "Dream fragment to keep:" and add to dream_fragments
  const fragmentMatch = reflection.content.match(/\*\*Dream fragment to keep:\*\*\s*([^\n]+)/);
  if (fragmentMatch && fragmentMatch[1].toLowerCase() !== "null") {
    try {
      await docManager.updateInternalModel(userId, "dream_fragments", fragmentMatch[1].trim());
      console.log("Added dream fragment");
      tracker.recordItemCreated("dream_fragments");
    } catch (e) {
      console.log("Could not add dream fragment:", e);
    }
  }

  // Look for "Topology note:" and add to topology_notes.md
  const topologyNoteMatch = reflection.content.match(/\*\*Topology note:\*\*\s*([^\n]+)/);
  if (topologyNoteMatch && topologyNoteMatch[1].toLowerCase() !== "null") {
    try {
      const note = topologyNoteMatch[1].trim();
      const dateStr = timestamp.split("T")[0];

      // Get or create topology notes document
      let topologyDoc = await supabase.getDocument(userId, "internal/topology_notes");
      if (!topologyDoc) {
        // Create the document using the template
        const { TOPOLOGY_NOTES_TEMPLATE } = await import("../documents/templates");
        await supabase.upsertDocument({
          user_id: userId,
          path: TOPOLOGY_NOTES_TEMPLATE.path,
          title: TOPOLOGY_NOTES_TEMPLATE.title,
          content: TOPOLOGY_NOTES_TEMPLATE.content,
          summary: "Spatial understanding of the mental geography",
          is_internal: true,
          metadata: {},
        });
        topologyDoc = await supabase.getDocument(userId, "internal/topology_notes");
      }

      if (topologyDoc) {
        // Append to exploration log section
        const explorationLogMarker = "## Exploration Log";
        const content = topologyDoc.content;

        if (content.includes(explorationLogMarker)) {
          const newEntry = `\n\n### ${dateStr}\n${note}`;
          const updated = content.replace(
            explorationLogMarker + "\n",
            explorationLogMarker + "\n" + newEntry + "\n"
          );
          await supabase.upsertDocument({
            user_id: userId,
            path: "internal/topology_notes",
            title: "Topology Notes",
            content: updated,
            summary: "Spatial understanding of the mental geography",
            is_internal: true,
            metadata: { lastUpdate: timestamp },
          });
          console.log("Added topology note");
          tracker.recordItemCreated("observations");
        }
      }
    } catch (e) {
      console.log("Could not add topology note:", e);
    }
  }

  // ============ PHASE 2.5: DIRECTED EXPLORATION ============
  // Active tool calls with budget tracking
  console.log("Phase 2.5: Directed exploration (5-call budget)...");

  let callsUsed = 0;
  let explorationOutput = "";
  const explorationMessages: Anthropic.MessageParam[] = [];

  // Initial prompt with budget display
  const explorationPrompt = buildDirectedExplorationPrompt(reflection.content, topology, callsUsed);
  explorationMessages.push({ role: "user", content: explorationPrompt });

  // First exploration call
  let explorationResponse = await claude.explore(explorationPrompt, EXPLORATION_SYSTEM_PROMPT);
  totalUsage.inputTokens += explorationResponse.usage.inputTokens;
  totalUsage.outputTokens += explorationResponse.usage.outputTokens;
  tracker.addUsage(explorationResponse.usage.inputTokens, explorationResponse.usage.outputTokens);

  // Exploration loop - continue while there are tool calls and budget remains
  while (explorationResponse.toolCalls.length > 0 && callsUsed < EXPLORATION_BUDGET) {
    // Execute all tool calls from this response
    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const toolCall of explorationResponse.toolCalls) {
      if (callsUsed >= EXPLORATION_BUDGET) {
        toolResults.push({
          tool_use_id: toolCall.id,
          content: `[Budget exhausted: ${callsUsed}/${EXPLORATION_BUDGET} calls used]`,
        });
        break;
      }

      callsUsed++;
      console.log(`Exploration ${callsUsed}/${EXPLORATION_BUDGET}: ${toolCall.name}`);

      // Execute the exploration tool
      const result = await executeExplorationTool(supabase, workersAI, userId, toolCall.name, toolCall.input);
      toolResults.push({
        tool_use_id: toolCall.id,
        content: `[${callsUsed}/${EXPLORATION_BUDGET} calls used]\n\n${result}`,
      });
    }

    // Add assistant message with tool calls to history
    explorationMessages.push({
      role: "assistant",
      content: explorationResponse.toolCalls.map((tc) => ({
        type: "tool_use" as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    });

    // Continue exploration with results
    explorationResponse = await claude.continueExploration(
      explorationMessages,
      toolResults,
      EXPLORATION_SYSTEM_PROMPT
    );
    totalUsage.inputTokens += explorationResponse.usage.inputTokens;
    totalUsage.outputTokens += explorationResponse.usage.outputTokens;
    tracker.addUsage(explorationResponse.usage.inputTokens, explorationResponse.usage.outputTokens);
  }

  // Capture final exploration output
  explorationOutput = explorationResponse.content;
  console.log(`Exploration completed: ${callsUsed}/${EXPLORATION_BUDGET} calls used`);

  // Record exploration stats
  tracker.setExplorationStats(callsUsed, EXPLORATION_BUDGET);

  // Log exploration results
  if (explorationOutput) {
    const finalLog = await supabase.getDocument(userId, "internal/reflection_log");
    if (finalLog) {
      const explorationEntry = `\n\n### Directed Exploration (${callsUsed}/${EXPLORATION_BUDGET} calls)\n\n${explorationOutput}`;

      await supabase.upsertDocument({
        user_id: userId,
        path: "internal/reflection_log",
        title: "Reflection Log",
        content: finalLog.content + explorationEntry,
        summary: `Last dream: ${timestamp}`,
        is_internal: true,
        metadata: { lastDream: timestamp, explorationCalls: callsUsed },
      });
    }

    // Parse exploration output for topology notes updates
    const explorationNoteMatch = explorationOutput.match(/\*\*New observation:\*\*\s*([^\n]+)/);
    if (explorationNoteMatch && explorationNoteMatch[1].toLowerCase() !== "null") {
      try {
        const note = explorationNoteMatch[1].trim();
        const dateStr = timestamp.split("T")[0];
        let topologyDoc = await supabase.getDocument(userId, "internal/topology_notes");

        if (topologyDoc) {
          const explorationLogMarker = "## Exploration Log";
          const content = topologyDoc.content;

          if (content.includes(explorationLogMarker)) {
            const newEntry = `\n\n### ${dateStr} (exploration)\n${note}`;
            const updated = content.replace(
              explorationLogMarker + "\n",
              explorationLogMarker + "\n" + newEntry + "\n"
            );
            await supabase.upsertDocument({
              user_id: userId,
              path: "internal/topology_notes",
              title: "Topology Notes",
              content: updated,
              summary: "Spatial understanding of the mental geography",
              is_internal: true,
              metadata: { lastUpdate: timestamp },
            });
            console.log("Added exploration observation to topology notes");
            tracker.recordItemCreated("observations");
          }
        }
      } catch (e) {
        console.log("Could not add exploration observation:", e);
      }
    }
  }

  // Track usage (fire and forget - existing budget tracking)
  trackScheduledUsage(supabase, userId, totalUsage, "Dream cycle");

  // Complete cycle tracking
  await tracker.complete();
  console.log("Dream cycle completed:", timestamp);
  } catch (error) {
    await tracker.fail(error instanceof Error ? error.message : "Unknown error");
    throw error;
  }
}

/**
 * Execute exploration tool calls
 */
async function executeExplorationTool(
  supabase: SupabaseService,
  workersAI: WorkersAIService,
  userId: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  type CofireScale = "weekly" | "immediate" | "session" | "daily";

  try {
    switch (toolName) {
      case "search": {
        const query = input.query as string;
        const limit = (input.limit as number) || 5;

        // Generate embedding and search territories
        const embedding = await workersAI.generateEmbedding(query);
        const territories = await supabase.matchTerritories(userId, embedding, limit);

        if (territories.length > 0) {
          return territories.map((t: { name: string; territory_id: number; essence?: string | null; message_count?: number }) =>
            `**${t.name}** (ID: ${t.territory_id})${t.essence ? `\n${t.essence}` : ""}\n*${t.message_count || 0} messages*`
          ).join("\n\n");
        }
        return "No results found for query: " + query;
      }

      case "getCofire": {
        const territoryId = input.territory_id as number;
        const scale = ((input.scale as string) || "weekly") as CofireScale;
        const limit = (input.limit as number) || 10;

        const results = await supabase.getCofireTerritories(userId, territoryId, scale, 0.1, limit);
        if (results.length > 0) {
          return results.map((r) =>
            `**${r.name}** (ID: ${r.territory_id}) - cofire: ${Math.round(r.cofire_strength * 100)}%${r.semantic_similarity ? `, semantic: ${Math.round(r.semantic_similarity * 100)}%` : ""}`
          ).join("\n");
        }
        return "No co-firing territories found";
      }

      case "getGaps": {
        const territoryId = input.territory_id as number;
        const limit = (input.limit as number) || 10;

        const results = await supabase.getTopGaps(userId, 0.65, 0.2, limit);
        const relevant = results.filter((r) =>
          r.territory_a_id === territoryId || r.territory_b_id === territoryId
        );
        if (relevant.length > 0) {
          return relevant.map((r) =>
            `**${r.territory_a_name}** ↔ **${r.territory_b_name}**\nSemantic: ${Math.round(r.semantic_similarity * 100)}%, Cofire: ${Math.round(r.cofire_strength * 100)}%\nGap score: ${r.gap_score.toFixed(2)}`
          ).join("\n\n");
        }
        return "No gaps found for this territory";
      }

      case "getCluster": {
        const territoryId = input.territory_id as number;
        const depth = (input.depth as number) || 2;

        // Walk outward from the territory
        const visited = new Set<number>();
        const cluster: Array<{ id: number; name: string; depth: number }> = [];

        async function walk(id: number, currentDepth: number): Promise<void> {
          if (currentDepth > depth || visited.has(id)) return;
          visited.add(id);

          const neighbors = await supabase.getCofireTerritories(userId, id, "weekly", 0.3, 5);
          for (const n of neighbors) {
            if (!visited.has(n.territory_id)) {
              cluster.push({ id: n.territory_id, name: n.name, depth: currentDepth });
              await walk(n.territory_id, currentDepth + 1);
            }
          }
        }

        await walk(territoryId, 1);

        if (cluster.length > 0) {
          return cluster.map((c) =>
            `${"  ".repeat(c.depth - 1)}↳ **${c.name}** (depth ${c.depth})`
          ).join("\n");
        }
        return "No connected cluster found";
      }

      case "getOrphans": {
        const limit = (input.limit as number) || 10;
        const orphans = await supabase.getOrphanTerritories(userId, 50, 3, "weekly", limit);

        if (orphans.length > 0) {
          return orphans.map((o) =>
            `**${o.name}**\n*${o.message_count} messages, ${o.connection_count} connections*${o.essence ? `\n${o.essence}` : ""}`
          ).join("\n\n");
        }
        return "No orphan territories found";
      }

      case "getBridges": {
        const limit = (input.limit as number) || 10;
        const bridges = await supabase.getBridgeTerritories(userId, 2, "weekly", limit);

        if (bridges.length > 0) {
          return bridges.map((b) =>
            `**${b.name}**\n*Connects ${b.connected_realms} realms, total strength: ${Math.round(b.total_cofire_strength)}`
          ).join("\n\n");
        }
        return "No bridge territories found";
      }

      default:
        return `Unknown exploration tool: ${toolName}`;
    }
  } catch (error) {
    return `Error executing ${toolName}: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

/**
 * Handle end-of-day triage (multi-user)
 * Runs hourly, processes users where local time is 11pm
 * Processes day's messages into living documents
 */
export async function handleEndOfDayTriage(env: Env): Promise<void> {
  console.log("Starting end-of-day triage job...");

  const supabase = new SupabaseService(env);
  const claude = new ClaudeService(env);
  const masterIndexGen = new MasterIndexGenerator(env);

  const users = await supabase.getActiveUsers();
  console.log(`End-of-day triage: Found ${users.length} active users`);

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);
    if (userHour !== 23) continue;

    console.log(`End-of-day triage: Processing user ${user.id} (${user.timezone || "UTC"})`);

    // Budget check - skip if user exceeded budget
    if (!(await checkScheduledBudget(supabase, user.id, "End-of-day triage"))) {
      continue;
    }

    // Start cycle metrics tracking
    const metricsService = new CycleMetricsService(env);
    const tracker = await metricsService.startCycle(user.id, "triage");

    try {
      // Get today's messages
      const todayMessages = await supabase.getTodayMessages(user.id);

      if (todayMessages.length === 0) {
        console.log(`No messages to triage today for user ${user.id}`);
        await tracker.skip("No messages to triage");
        continue;
      }

      // Get existing document paths
      const allDocs = await supabase.getAllDocumentSummaries(user.id);
      const existingPaths = allDocs.map((d) => d.path);

      const context: TriageContext = {
        todayMessages: todayMessages.map((m) => ({
          role: m.role,
          content: m.content,
          tags: m.tags || [],
          timestamp: new Date(m.created_at).toLocaleTimeString(),
        })),
        existingDocuments: existingPaths,
      };

      const prompt = buildTriagePrompt(context);

      // Run triage through Claude
      const response = await claude.chat(prompt, {
        masterIndex: null,
        recentMessages: [],
        currentTags: [],
        internalModel: null,
        flaggedItems: [],
        todoDoc: null,
        commPrefsDoc: null,
        pinnedDocs: [],
        availableFolders: [],
        availableCanvases: [],
      });

      // Track usage in cycle metrics
      tracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);

      // Track usage (fire and forget - existing budget tracking)
      trackScheduledUsage(supabase, user.id, response.usage, "End-of-day triage");

      // Parse and apply results (simplified - would need proper parsing)
      console.log(`Triage results for user ${user.id}:`, response.content);

      // Regenerate master index
      await masterIndexGen.regenerate(user.id);

      // Complete cycle tracking
      await tracker.complete();
      console.log(`End-of-day triage completed for user ${user.id}`);
    } catch (error) {
      await tracker.fail(error instanceof Error ? error.message : "Unknown error");
      console.error(`End-of-day triage failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      // Continue to next user
    }
  }

  console.log("End-of-day triage job completed");
}

/**
 * Handle weekly decay cycle (multi-user)
 * Runs hourly, processes users where local time is Sunday 4am
 * Archives items not reinforced, promotes well-reinforced items
 */
export async function handleWeeklyDecay(env: Env): Promise<void> {
  console.log("Starting weekly decay cycle...");

  const supabase = new SupabaseService(env);
  const decayService = new InternalModelDecayService(env);

  const users = await supabase.getActiveUsers();
  console.log(`Weekly decay: Found ${users.length} active users`);

  for (const user of users) {
    const userHour = getCurrentHourInTimezone(user.timezone);

    // Check if it's Sunday at 4am in user's timezone (after 3am dream cycle)
    const now = new Date();
    const userDayFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: user.timezone || "UTC",
      weekday: "long",
    });
    const userDay = userDayFormatter.format(now);

    if (userDay !== "Sunday" || userHour !== 4) continue;

    console.log(`Weekly decay: Processing user ${user.id} (${user.timezone || "UTC"})`);

    // Start cycle metrics tracking
    const metricsService = new CycleMetricsService(env);
    const tracker = await metricsService.startCycle(user.id, "weekly");

    try {
      // Run the decay cycle
      const results = await decayService.runDecayCycle(user.id);

      // Record items pruned
      tracker.recordItemsPruned(results.archived);

      // Get stats for metadata
      const stats = await decayService.getDecayStats(user.id);

      // Complete cycle tracking with metadata
      await tracker.complete({
        archived: results.archived,
        promoted: results.promoted,
        total_active: results.total_active,
        stats,
      });

      console.log(`Weekly decay completed for user ${user.id}: ${results.archived} archived, ${results.promoted} promoted`);
    } catch (error) {
      await tracker.fail(error instanceof Error ? error.message : "Unknown error");
      console.error(`Weekly decay failed for user ${user.id}:`, error instanceof Error ? error.message : error);
      // Continue to next user
    }
  }

  console.log("Weekly decay cycle completed");
}

// ============ HELPER FUNCTIONS ============

/**
 * Get current hour in user's timezone (0-23)
 * Falls back to UTC if timezone is invalid
 */
function getCurrentHourInTimezone(timezone: string | null): number {
  const tz = timezone || "UTC";
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    return parseInt(formatter.format(now), 10);
  } catch {
    // Invalid timezone, fall back to UTC
    return new Date().getUTCHours();
  }
}

async function getOwnerUser(supabase: SupabaseService, env: Env) {
  const ownerId = parseInt(env.OWNER_TELEGRAM_ID);

  if (isNaN(ownerId)) {
    console.error("OWNER_TELEGRAM_ID is not set or invalid");
    return null;
  }

  const user = await supabase.getUserByTelegramId(ownerId);

  if (!user) {
    console.error(`User not found for telegram_id: ${ownerId}`);
    return null;
  }

  return user;
}

function extractRecentMood(content: string): string | null {
  const match = content.match(/Mood:\s*([^\n]+)/i);
  return match?.[1]?.trim() || null;
}

function extractFlaggedTopics(content: string): string[] {
  const topics: string[] = [];
  const regex = /\*\*Something I want to bring up:\*\* ([^\n]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    topics.push(match[1].trim());
  }
  return topics.slice(0, 3);
}

function extractHypotheses(content: string): string[] {
  const section = extractSection(content, "## Working Hypotheses");
  return extractBulletPoints(section);
}

function extractQuestions(content: string): string[] {
  const section = extractSection(content, "## Open Questions");
  return extractBulletPoints(section);
}

function extractLastReflection(content: string): string | null {
  const match = content.match(/## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\n\n([\s\S]*?)(?=\n\n##|$)/);
  if (match) {
    return `${match[1]}: ${match[2].substring(0, 200)}...`;
  }
  return null;
}

function extractSection(content: string, header: string): string {
  const index = content.indexOf(header);
  if (index === -1) return "";

  const afterHeader = content.slice(index + header.length);
  const nextSection = afterHeader.search(/\n## /);

  return nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
}

function extractBulletPoints(content: string): string[] {
  const matches = content.match(/\n- ([^\n]+)/g);
  return (matches || []).map((m) => m.replace(/\n- /, "").trim());
}

function getWeekNumber(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const diff = date.getTime() - start.getTime();
  const oneWeek = 604800000;
  return Math.ceil(diff / oneWeek);
}

function extractRecentDreams(content: string): string[] {
  const dreams: string[] = [];
  // Match dream entries (## YYYY-MM-DD | time)
  const regex = /## (\d{4}-\d{2}-\d{2} \| [\d:apm ]+)\n\n([\s\S]*?)(?=\n\n## |\n\n---|\n## Recurring|$)/gi;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const dreamDate = match[1];
    const dreamContent = match[2].substring(0, 500);
    dreams.push(`${dreamDate}\n${dreamContent}`);
    if (dreams.length >= 3) break; // Only last 3 dreams
  }
  return dreams;
}

function extractRecentSynchronicities(content: string): string[] {
  const syncs: string[] = [];
  // Match synchronicity entries (## YYYY-MM-DD)
  const regex = /## (\d{4}-\d{2}-\d{2})\n\n([\s\S]*?)(?=\n\n## |$)/gi;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const date = match[1];
    const syncContent = match[2].substring(0, 300);
    syncs.push(`${date}: ${syncContent}`);
    if (syncs.length >= 5) break; // Only last 5
  }
  return syncs;
}

/**
 * Parse internal model document into structured format
 */
function parseInternalModel(content: string): InternalModel | null {
  if (!content) return null;

  return {
    hypotheses: extractBulletPoints(extractSection(content, "## Working Hypotheses")),
    openQuestions: extractBulletPoints(extractSection(content, "## Open Questions")),
    contradictions: extractBulletPoints(extractSection(content, "## Contradictions I'm Tracking")),
    uncertainty: extractBulletPoints(extractSection(content, "## Where I Might Be Wrong")),
  };
}
