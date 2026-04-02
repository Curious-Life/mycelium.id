import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types/env";
import type {
  User,
  Message,
  Document,
  TagVocabulary,
  SuggestedTag,
  Realm,
  SemanticTheme,
  TerritoryProfile,
  InsertMessage,
  InsertDocument,
  InsertTagVocabulary,
  InsertSuggestedTag,
} from "../types/database";
import type { AgentId, MemoryScope } from "../config/mya-agents";

export class SupabaseService {
  private client: SupabaseClient;

  constructor(env: Env) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /**
   * Get the raw Supabase client for direct queries
   * Use sparingly - prefer adding typed methods to this service
   */
  getClient(): SupabaseClient {
    return this.client;
  }

  // ============ Agent Scope Helpers ============

  /**
   * Build agent scope filter for queries
   * - 'all' scope: no filtering (sees everything)
   * - specific scope: sees own agent's data + legacy data (null agent_id)
   */
  private buildAgentScopeFilter(agentScope?: MemoryScope): string | null {
    if (!agentScope || agentScope === 'all') {
      return null; // No filtering needed
    }
    // Include messages from this agent OR legacy messages (null agent_id)
    return `agent_id.eq.mya-${agentScope},agent_id.is.null`;
  }

  // ============ Users ============

  async getUserByTelegramId(telegramId: number): Promise<User | null> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    if (error || !data) return null;
    return data as User;
  }

  async getOrCreateUser(telegramId: number, username?: string, displayName?: string): Promise<User> {
    // Try to get existing user
    const { data: existing } = await this.client
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    if (existing) return existing as User;

    // Create new user
    const { data: created, error } = await this.client
      .from("users")
      .insert({
        telegram_id: telegramId,
        username,
        display_name: displayName,
        timezone: "UTC",
        settings: {},
      })
      .select()
      .single();

    if (error) throw error;
    return created as User;
  }

  /**
   * Get all active users for scheduled job processing
   * Returns users with status='active' (or no status, for backwards compatibility)
   */
  async getActiveUsers(): Promise<User[]> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .or("status.eq.active,status.is.null");

    if (error) {
      console.error("Failed to get active users:", error);
      return [];
    }
    return (data || []) as User[];
  }

  /**
   * Get user by ID
   */
  async getUserById(userId: string): Promise<User | null> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (error || !data) return null;
    return data as User;
  }

  /**
   * Update user settings (merge with existing)
   */
  async updateUserSettings(userId: string, settings: Record<string, unknown>): Promise<void> {
    // Get existing settings first
    const user = await this.getUserById(userId);
    const existingSettings = user?.settings || {};

    const { error } = await this.client
      .from("users")
      .update({ settings: { ...existingSettings, ...settings } })
      .eq("id", userId);

    if (error) {
      console.error("Failed to update user settings:", error);
      throw error;
    }
  }

  /**
   * Check rate limit for registration attempts
   * Returns whether the user is allowed to attempt registration
   */
  async checkRegisterRateLimit(telegramId: number): Promise<{
    allowed: boolean;
    attemptsUsed: number;
    lockoutUntil: Date | null;
  }> {
    const { data, error } = await this.client.rpc("check_register_rate_limit", {
      p_telegram_id: telegramId,
      p_window_minutes: 15,
      p_max_attempts: 5,
    });

    if (error || !data || data.length === 0) {
      console.error("Rate limit check failed:", error);
      // Fail closed - deny if we can't check
      return { allowed: false, attemptsUsed: 0, lockoutUntil: null };
    }

    const result = data[0];
    return {
      allowed: result.allowed,
      attemptsUsed: result.attempts_used,
      lockoutUntil: result.lockout_until ? new Date(result.lockout_until) : null,
    };
  }

  /**
   * Securely claim an invite code using database RPC
   * Handles atomicity and timing attack prevention
   */
  async claimInviteCodeSecure(
    inviteCode: string,
    telegramId: number,
    username?: string,
    displayName?: string
  ): Promise<{ success: boolean; userId: string | null; errorCode: string | null }> {
    const { data, error } = await this.client.rpc("claim_invite_code_secure", {
      p_invite_code: inviteCode,
      p_telegram_id: telegramId,
      p_username: username || null,
      p_display_name: displayName || null,
    });

    if (error || !data || data.length === 0) {
      console.error("Claim invite code RPC failed:", error);
      return { success: false, userId: null, errorCode: "RPC_ERROR" };
    }

    const result = data[0];
    return {
      success: result.success,
      userId: result.user_id,
      errorCode: result.error_code,
    };
  }

  /**
   * Log an authentication event for audit trail
   */
  async logAuthEvent(
    telegramId: number,
    telegramUsername: string | undefined,
    action: string,
    success: boolean,
    inviteCode?: string | null,
    failureReason?: string | null,
    ipAddress?: string | null
  ): Promise<void> {
    try {
      await this.client.rpc("log_auth_event", {
        p_telegram_id: telegramId,
        p_telegram_username: telegramUsername || null,
        p_action: action,
        p_success: success,
        p_invite_code: inviteCode || null,
        p_failure_reason: failureReason || null,
        p_ip_address: ipAddress || null,
      });
    } catch (e) {
      console.error("Failed to log auth event:", e);
      // Don't fail the request if logging fails
    }
  }

  /**
   * Claim an invite code for a new user
   * Links the telegram_id to a pre-created user with matching invite_code
   * Returns the updated user if successful, null if invite code invalid/already used
   * @deprecated Use claimInviteCodeSecure for better security
   */
  async claimInviteCode(
    inviteCode: string,
    telegramId: number,
    username?: string,
    displayName?: string
  ): Promise<User | null> {
    // Find user with matching invite code that hasn't been claimed yet
    const { data: user, error: findError } = await this.client
      .from("users")
      .select("*")
      .eq("invite_code", inviteCode)
      .is("telegram_id", null)  // Not yet claimed
      .single();

    if (findError || !user) {
      console.log("Invite code not found or already claimed:", inviteCode);
      return null;
    }

    // Claim the invite code by linking telegram_id
    const { data: updated, error: updateError } = await this.client
      .from("users")
      .update({
        telegram_id: telegramId,
        username: username || user.username,
        display_name: displayName || user.display_name,
        status: "active",
        onboarded_at: new Date().toISOString(),
      })
      .eq("id", user.id)
      .select()
      .single();

    if (updateError) {
      console.error("Failed to claim invite code:", updateError);
      return null;
    }

    return updated as User;
  }

  // ============ Sessions ============

  async getSession(token: string): Promise<{ user_id: string; expires_at: string } | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("user_id, expires_at")
      .eq("token", token)
      .single();

    if (error || !data) return null;
    return data as { user_id: string; expires_at: string };
  }

  // ============ Messages ============

  async insertMessage(message: InsertMessage): Promise<Message> {
    const { data, error } = await this.client
      .from("messages")
      .insert(message)
      .select()
      .single();

    if (error) throw error;
    return data as Message;
  }

  /**
   * Batch insert messages for efficient bulk imports (e.g., Claude export)
   * Inserts in batches of 500 to avoid request size limits
   * Returns count of successfully inserted messages
   */
  async insertMessagesBatch(messages: InsertMessage[]): Promise<number> {
    if (messages.length === 0) return 0;

    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);

      const { data, error } = await this.client
        .from("messages")
        .insert(batch)
        .select("id");

      if (error) {
        console.error(`Batch insert error at ${i}:`, error);
        // Continue with next batch rather than failing entirely
        continue;
      }

      inserted += data?.length || 0;
    }

    return inserted;
  }

  /**
   * Batch insert documents (for imports)
   */
  async insertDocumentsBatch(documents: InsertDocument[]): Promise<number> {
    if (documents.length === 0) return 0;

    const BATCH_SIZE = 100; // Smaller batches for documents (they're larger)
    let inserted = 0;

    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batch = documents.slice(i, i + BATCH_SIZE);

      const { data, error } = await this.client
        .from("documents")
        .insert(batch)
        .select("id");

      if (error) {
        console.error(`Document batch insert error at ${i}:`, error);
        continue;
      }

      inserted += data?.length || 0;
    }

    return inserted;
  }

  /**
   * Update message with NLP extraction results from GLiNER
   */
  async updateMessageNlp(
    messageId: string,
    update: {
      entities: Array<{ label: string; text: string; start: number; end: number; score: number }> | null;
      relations: Array<{ head: string; tail: string; label: string; score: number }> | null;
      entity_summary: string | null;
      nlp_processed: boolean;
      nlp_processed_at: string | null;
      nlp_error: string | null;
    }
  ): Promise<void> {
    const { error } = await this.client
      .from("messages")
      .update(update)
      .eq("id", messageId);

    if (error) throw error;
  }

  /**
   * Get messages that need NLP processing
   */
  async getUnprocessedMessages(limit: number = 100): Promise<Array<{ id: string; content: string; user_id: string }>> {
    const { data, error } = await this.client
      .from("messages")
      .select("id, content, user_id")
      .eq("nlp_processed", false)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  /**
   * Get messages by metadata field for duplicate detection
   * Used for imports like Claude export to skip already-imported messages
   * @deprecated Use getExistingClaudeUuids for better performance with large datasets
   */
  async getMessagesByMetadataField(
    userId: string,
    field: string
  ): Promise<Array<{ id: string; metadata: Record<string, unknown> }>> {
    const { data, error } = await this.client
      .from("messages")
      .select("id, metadata")
      .eq("user_id", userId)
      .not("metadata", "is", null);

    if (error) throw error;

    // Filter for messages that have the specified field in metadata
    return (data || []).filter((msg) => {
      const meta = msg.metadata as Record<string, unknown>;
      return meta && field in meta;
    });
  }

  /**
   * Check which claude_uuids already exist in the database.
   * Uses the idx_messages_claude_uuid index for O(batch_size) lookups
   * instead of paginating through all messages.
   */
  async getExistingClaudeUuids(
    userId: string,
    uuidsToCheck: string[]
  ): Promise<Set<string>> {
    const existingUuids = new Set<string>();

    if (uuidsToCheck.length === 0) return existingUuids;

    // Query in batches using the indexed metadata->>claude_uuid column
    // PostgREST IN filter uses the index directly
    const BATCH_SIZE = 200;
    for (let i = 0; i < uuidsToCheck.length; i += BATCH_SIZE) {
      const batch = uuidsToCheck.slice(i, i + BATCH_SIZE);

      try {
        const filterValue = `(${batch.map(u => `"${u}"`).join(',')})`;
        const { data, error } = await this.client
          .from("messages")
          .select("metadata")
          .eq("user_id", userId)
          .filter("metadata->>claude_uuid", "in", filterValue);

        if (error) {
          console.error("Error checking UUIDs batch:", error);
          continue;
        }

        for (const row of data || []) {
          const meta = row.metadata as Record<string, unknown>;
          const uuid = meta?.claude_uuid as string;
          if (uuid) existingUuids.add(uuid);
        }
      } catch (err) {
        console.error("Error in UUID batch check:", err);
      }
    }

    return existingUuids;
  }

  async getRecentMessages(userId: string, limit: number = 20, agentScope?: MemoryScope): Promise<Message[]> {
    let query = this.client
      .from("messages")
      .select("*")
      .eq("user_id", userId);

    // Apply agent scope filtering
    const scopeFilter = this.buildAgentScopeFilter(agentScope);
    if (scopeFilter) {
      query = query.or(scopeFilter);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data as Message[]).reverse();
  }

  async getTodayMessages(userId: string, agentScope?: MemoryScope): Promise<Message[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let query = this.client
      .from("messages")
      .select("*")
      .eq("user_id", userId)
      .gte("created_at", today.toISOString());

    // Apply agent scope filtering
    const scopeFilter = this.buildAgentScopeFilter(agentScope);
    if (scopeFilter) {
      query = query.or(scopeFilter);
    }

    const { data, error } = await query.order("created_at", { ascending: true });

    if (error) throw error;
    return data as Message[];
  }

  async getYesterdayMessages(userId: string, agentScope?: MemoryScope): Promise<Message[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let query = this.client
      .from("messages")
      .select("*")
      .eq("user_id", userId)
      .gte("created_at", yesterday.toISOString())
      .lt("created_at", today.toISOString());

    // Apply agent scope filtering
    const scopeFilter = this.buildAgentScopeFilter(agentScope);
    if (scopeFilter) {
      query = query.or(scopeFilter);
    }

    const { data, error } = await query.order("created_at", { ascending: true });

    if (error) throw error;
    return data as Message[];
  }

  // ============ Documents ============

  /**
   * Get a document by path
   * @param trackAccess - If true, updates last_accessed and access_count in metadata (default: false)
   */
  async getDocument(userId: string, path: string, trackAccess: boolean = false): Promise<Document | null> {
    const { data } = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .eq("path", path)
      .single();

    if (data && trackAccess) {
      // Fire and forget - don't block on access tracking
      this.trackDocumentAccess(userId, path, data.metadata as Record<string, unknown>).catch((err) => {
        console.error("Failed to track document access:", err);
      });
    }

    return data as Document | null;
  }

  /**
   * Track document access - updates last_accessed timestamp and increments access_count
   * Used for activation-based retrieval scoring
   */
  async trackDocumentAccess(userId: string, path: string, currentMetadata?: Record<string, unknown>): Promise<void> {
    const metadata = currentMetadata || {};
    const accessCount = (metadata.access_count as number) || 0;

    const { error } = await this.client
      .from("documents")
      .update({
        metadata: {
          ...metadata,
          last_accessed: new Date().toISOString(),
          access_count: accessCount + 1,
        },
      })
      .eq("user_id", userId)
      .eq("path", path);

    if (error) throw error;
  }

  /**
   * Get document access metadata for scoring
   */
  async getDocumentAccessStats(userId: string, paths: string[]): Promise<Map<string, { lastAccessed: Date | null; accessCount: number }>> {
    if (paths.length === 0) return new Map();

    const { data, error } = await this.client
      .from("documents")
      .select("path, metadata")
      .eq("user_id", userId)
      .in("path", paths);

    if (error) throw error;

    const stats = new Map<string, { lastAccessed: Date | null; accessCount: number }>();
    for (const doc of data || []) {
      const metadata = doc.metadata as Record<string, unknown>;
      stats.set(doc.path, {
        lastAccessed: metadata?.last_accessed ? new Date(metadata.last_accessed as string) : null,
        accessCount: (metadata?.access_count as number) || 0,
      });
    }
    return stats;
  }

  async upsertDocument(doc: InsertDocument): Promise<Document> {
    const { data, error } = await this.client
      .from("documents")
      .upsert(doc, { onConflict: "user_id,path" })
      .select()
      .single();

    if (error) throw error;
    return data as Document;
  }

  async getAllDocumentSummaries(userId: string): Promise<Pick<Document, "path" | "summary">[]> {
    const { data, error } = await this.client
      .from("documents")
      .select("path, summary")
      .eq("user_id", userId)
      .eq("is_internal", false);

    if (error) throw error;
    return data as Pick<Document, "path" | "summary">[];
  }

  async getMasterIndex(userId: string): Promise<Document | null> {
    return this.getDocument(userId, "_master_index");
  }

  /**
   * Get the internal model document (Mya's private hypotheses and questions)
   * Always tracks access since this is a core context document
   */
  async getInternalModel(userId: string): Promise<Document | null> {
    return this.getDocument(userId, "internal/model", true);
  }

  /**
   * Get the reflection log document (contains flagged items)
   * Always tracks access since this is a core context document
   */
  async getReflectionLog(userId: string): Promise<Document | null> {
    return this.getDocument(userId, "internal/reflection_log", true);
  }

  /**
   * Get all document paths and summaries (including internal)
   */
  async listAllDocuments(userId: string): Promise<Array<{ path: string; title: string | null; summary: string | null; is_internal: boolean }>> {
    const { data, error } = await this.client
      .from("documents")
      .select("path, title, summary, is_internal")
      .eq("user_id", userId)
      .order("path");

    if (error) throw error;
    return data || [];
  }

  /**
   * Get pinned document paths from user settings
   */
  async getPinnedDocuments(userId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("users")
      .select("settings")
      .eq("id", userId)
      .single();

    if (error || !data) return [];
    const settings = data.settings as Record<string, unknown>;
    return (settings?.pinned_documents as string[]) || [];
  }

  /**
   * Set pinned document paths in user settings
   */
  async setPinnedDocuments(userId: string, paths: string[]): Promise<void> {
    // First get current settings
    const { data } = await this.client
      .from("users")
      .select("settings")
      .eq("id", userId)
      .single();

    const currentSettings = (data?.settings as Record<string, unknown>) || {};
    const newSettings = { ...currentSettings, pinned_documents: paths };

    await this.client
      .from("users")
      .update({ settings: newSettings })
      .eq("id", userId);
  }

  /**
   * Get the user's Inbox folder ID (system folder)
   */
  async getInboxFolderId(userId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("folders")
      .select("id")
      .eq("user_id", userId)
      .eq("name", "Inbox")
      .eq("folder_type", "system")
      .single();

    if (error || !data) return null;
    return data.id;
  }

  /**
   * Get a folder by name (case-insensitive)
   */
  async getFolderByName(userId: string, folderName: string): Promise<{ id: string; name: string } | null> {
    const { data, error } = await this.client
      .from("folders")
      .select("id, name")
      .eq("user_id", userId)
      .ilike("name", folderName)
      .limit(1)
      .single();

    if (error) {
      console.log(`[getFolderByName] Query error for "${folderName}":`, error.message, error.code);
      return null;
    }
    if (!data) {
      console.log(`[getFolderByName] No data returned for "${folderName}" (user: ${userId})`);
      return null;
    }
    console.log(`[getFolderByName] Found: ${data.name} (${data.id})`);
    return data;
  }

  /**
   * Get a canvas by name (case-insensitive)
   */
  async getCanvasByName(userId: string, canvasName: string): Promise<{ id: string; name: string } | null> {
    const { data, error } = await this.client
      .from("canvas_workspaces")
      .select("id, name")
      .eq("user_id", userId)
      .ilike("name", canvasName)
      .limit(1)
      .single();

    if (error || !data) return null;
    return data;
  }

  /**
   * Add a node (document, message, attachment) to a canvas
   */
  async addNodeToCanvas(
    canvasId: string,
    nodeId: string,
    nodeType: "document" | "message" | "attachment"
  ): Promise<void> {
    const { error } = await this.client
      .from("canvas_workspace_nodes")
      .upsert({
        canvas_id: canvasId,
        node_id: nodeId,
        node_type: nodeType,
      }, { onConflict: "canvas_id,node_id" });

    if (error) throw error;
  }

  /**
   * List all folders for a user
   */
  async listFolders(userId: string): Promise<Array<{
    id: string;
    name: string;
    folder_type: string;
    parent_id: string | null;
    icon: string | null;
  }>> {
    const { data, error } = await this.client
      .from("folders")
      .select("id, name, folder_type, parent_id, icon")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * List all canvases for a user
   */
  async listCanvases(userId: string): Promise<Array<{
    id: string;
    name: string;
    is_public: boolean;
  }>> {
    const { data, error } = await this.client
      .from("canvas_workspaces")
      .select("id, name, is_public")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get pinned documents with full content
   * Tracks access for all retrieved documents (activation scoring)
   */
  async getPinnedDocumentsWithContent(userId: string): Promise<Document[]> {
    const pinnedPaths = await this.getPinnedDocuments(userId);
    if (pinnedPaths.length === 0) return [];

    const { data, error } = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .in("path", pinnedPaths);

    if (error) throw error;
    const docs = (data as Document[]) || [];

    // Track access for all pinned documents (fire and forget)
    for (const doc of docs) {
      this.trackDocumentAccess(userId, doc.path, doc.metadata as Record<string, unknown>).catch((err) => {
        console.error("Failed to track pinned doc access:", err);
      });
    }

    return docs;
  }

  /**
   * Parse internal model document to extract structured content
   */
  parseInternalModel(content: string): {
    hypotheses: string[];
    openQuestions: string[];
    contradictions: string[];
    uncertainty: string[];
  } {
    const extractSection = (header: string): string[] => {
      const sectionIndex = content.indexOf(header);
      if (sectionIndex === -1) return [];

      const afterSection = content.slice(sectionIndex + header.length);
      const nextSection = afterSection.search(/\n## /);
      const sectionContent = nextSection === -1 ? afterSection : afterSection.slice(0, nextSection);

      const bullets: string[] = [];
      const regex = /^- (.+)$/gm;
      let match;
      while ((match = regex.exec(sectionContent)) !== null) {
        bullets.push(match[1].trim());
      }
      return bullets;
    };

    return {
      hypotheses: extractSection("## Working Hypotheses"),
      openQuestions: extractSection("## Open Questions"),
      contradictions: extractSection("## Contradictions"),
      uncertainty: extractSection("## Uncertainty"),
    };
  }

  /**
   * Parse reflection log to extract flagged items for discussion
   */
  parseFlaggedItems(content: string): Array<{ topic: string; context: string; timestamp: string }> {
    const flagged: Array<{ topic: string; context: string; timestamp: string }> = [];

    // Match reflection entries with flagged items
    // Format: ## YYYY-MM-DD HH:MM followed by **Something I want to bring up:** ...
    const entryRegex = /## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})[\s\S]*?\*\*Something I want to bring up:\*\* ([^\n]+)/g;
    let match;
    while ((match = entryRegex.exec(content)) !== null) {
      const timestamp = match[1];
      const topic = match[2].trim();

      // Try to extract surrounding context (the reflection entry)
      const entryStart = match.index;
      const nextEntry = content.slice(entryStart + 10).search(/\n## \d{4}/);
      const entryContent = nextEntry === -1
        ? content.slice(entryStart)
        : content.slice(entryStart, entryStart + 10 + nextEntry);

      // Extract the "What's emerging" or similar context
      const contextMatch = entryContent.match(/\*\*What's emerging:\*\* ([^\n]+)/);
      const context = contextMatch ? contextMatch[1].trim() : "";

      flagged.push({ topic, context, timestamp });
    }

    return flagged;
  }

  // ============ Mindscape (Realms & Territories) ============

  /**
   * Get all realms for a user, ordered by message count
   */
  async getRealms(userId: string): Promise<Realm[]> {
    const { data, error } = await this.client
      .from("realms")
      .select(`
        id, realm_id, user_id,
        name, essence, archetype_type, archetype_character,
        territory_count, message_count, territory_ids,
        top_entities, signature_patterns,
        story_birth, story_arc, story_peak_moments, story_current_chapter,
        uncertainty_open_questions, uncertainty_edges,
        agent_expertise, agent_curious_about, agent_can_help_with,
        generated_at, created_at, updated_at
      `)
      .eq("user_id", userId)
      .order("message_count", { ascending: false });

    if (error) throw error;
    return (data || []) as Realm[];
  }

  /**
   * Get a specific realm by realm_id
   */
  async getRealm(userId: string, realmId: number): Promise<Realm | null> {
    const { data, error } = await this.client
      .from("realms")
      .select("*")
      .eq("user_id", userId)
      .eq("realm_id", realmId)
      .single();

    if (error && error.code !== "PGRST116") throw error; // PGRST116 = not found
    return data as Realm | null;
  }

  /**
   * Get all semantic themes for a user
   */
  async getSemanticThemes(userId: string): Promise<SemanticTheme[]> {
    const { data, error } = await this.client
      .from("semantic_themes")
      .select(`
        id, realm_id, semantic_theme_id, user_id,
        name, essence,
        territory_count, message_count, territory_ids,
        included_territory_count, coverage_percent,
        top_entities, signature_patterns,
        story_birth, story_arc, story_current_chapter,
        uncertainty_open_questions,
        generated_at, created_at, updated_at
      `)
      .eq("user_id", userId)
      .order("message_count", { ascending: false });

    if (error) throw error;
    return (data || []) as SemanticTheme[];
  }

  /**
   * Get all territory profiles for a user
   */
  async getTerritoryProfiles(userId: string): Promise<TerritoryProfile[]> {
    const { data, error } = await this.client
      .from("territory_profiles")
      .select(`
        id, territory_id, user_id, realm_id,
        name, essence, archetype_type, archetype_character,
        message_count, explored_count, explored_percent,
        top_entities, signature_patterns,
        story_birth, story_arc, story_peak_moments, story_current_chapter,
        uncertainty_open_questions, uncertainty_edges,
        agent_expertise, agent_curious_about, agent_can_help_with, agent_would_consult,
        generated_at, created_at, updated_at
      `)
      .eq("user_id", userId)
      .order("message_count", { ascending: false });

    if (error) throw error;
    return (data || []) as TerritoryProfile[];
  }

  /**
   * Get territories for a specific realm
   */
  async getTerritoriesByRealm(userId: string, realmId: number): Promise<TerritoryProfile[]> {
    const { data, error } = await this.client
      .from("territory_profiles")
      .select("*")
      .eq("user_id", userId)
      .eq("realm_id", realmId)
      .order("message_count", { ascending: false });

    if (error) throw error;
    return (data || []) as TerritoryProfile[];
  }

  /**
   * Get a specific territory profile
   */
  async getTerritoryProfile(userId: string, territoryId: number): Promise<TerritoryProfile | null> {
    const { data, error } = await this.client
      .from("territory_profiles")
      .select("*")
      .eq("user_id", userId)
      .eq("territory_id", territoryId)
      .single();

    if (error && error.code !== "PGRST116") throw error;
    return data as TerritoryProfile | null;
  }

  /**
   * Get total message count for a user (for mindscape stats)
   */
  async getMessageCount(userId: string): Promise<number> {
    const { count, error } = await this.client
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    if (error) throw error;
    return count || 0;
  }

  /**
   * Get mindscape overview for context - counts and top-level structure
   * This provides a map without pre-loading semantic matches
   */
  async getMindscapeOverview(userId: string): Promise<{
    totalMessages: number;
    realms: Array<{
      realm_id: number;
      name: string;
      essence: string | null;
      territory_count: number;
      message_count: number;
    }>;
    territoryCount: number;
    themeCount: number;
  }> {
    // Fetch counts and top realms in parallel
    const [messageCount, realms, territoryCount, themeCount] = await Promise.all([
      this.getMessageCount(userId),
      this.client
        .from("realms")
        .select("realm_id, name, essence, territory_count, message_count")
        .eq("user_id", userId)
        .order("message_count", { ascending: false }),
      this.client
        .from("territory_profiles")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId),
      this.client
        .from("semantic_themes")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId),
    ]);

    return {
      totalMessages: messageCount,
      realms: (realms.data || []) as Array<{
        realm_id: number;
        name: string;
        essence: string | null;
        territory_count: number;
        message_count: number;
      }>,
      territoryCount: territoryCount.count || 0,
      themeCount: themeCount.count || 0,
    };
  }

  // ============ Document Versions ============

  async insertDocumentVersion(
    documentId: string,
    diff: string,
    changedBy: "user" | "bot" | "reflection",
    changeSummary?: string
  ): Promise<void> {
    const { error } = await this.client.from("document_versions").insert({
      document_id: documentId,
      diff,
      changed_by: changedBy,
      change_summary: changeSummary,
    });

    if (error) throw error;
  }

  async getDocumentVersions(documentId: string, limit: number = 10): Promise<Array<{
    id: string;
    diff: string;
    changed_by: string;
    change_summary: string | null;
    created_at: string;
  }>> {
    const { data, error } = await this.client
      .from("document_versions")
      .select("*")
      .eq("document_id", documentId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // ============ Tag Vocabulary ============

  async getTagVocabulary(userId: string): Promise<TagVocabulary[]> {
    const { data, error } = await this.client
      .from("tag_vocabulary")
      .select("*")
      .eq("user_id", userId)
      .order("usage_count", { ascending: false });

    if (error) throw error;
    return data as TagVocabulary[];
  }

  async incrementTagUsage(userId: string, tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.client.rpc("increment_tag_usage", { p_user_id: userId, p_tag: tag });
    }
  }

  async addTagToVocabulary(tag: InsertTagVocabulary): Promise<TagVocabulary> {
    const { data, error } = await this.client
      .from("tag_vocabulary")
      .insert(tag)
      .select()
      .single();

    if (error) throw error;
    return data as TagVocabulary;
  }

  async seedInitialTags(userId: string): Promise<void> {
    const initialTags = [
      "dreams", "health", "mood", "business", "relationships",
      "synchronicity", "insight", "question", "priorities", "ideas",
      "gratitude", "conflict", "decision", "energy", "creativity",
    ];

    for (const tag of initialTags) {
      await this.client
        .from("tag_vocabulary")
        .upsert({
          user_id: userId,
          tag,
          description: null,
          usage_count: 0,
          created_by: "system",
        }, { onConflict: "user_id,tag" });
    }
  }

  // ============ Suggested Tags ============

  async insertSuggestedTag(suggestion: InsertSuggestedTag): Promise<SuggestedTag> {
    const { data, error } = await this.client
      .from("suggested_tags")
      .insert(suggestion)
      .select()
      .single();

    if (error) throw error;
    return data as SuggestedTag;
  }

  async getPendingSuggestedTags(userId: string): Promise<SuggestedTag[]> {
    const { data, error } = await this.client
      .from("suggested_tags")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending");

    if (error) throw error;
    return data as SuggestedTag[];
  }

  // ============ People ============

  async getKnownPeople(userId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("people")
      .select("name")
      .eq("user_id", userId)
      .in("status", ["active", "background"]);

    if (error) throw error;
    return (data || []).map((p) => p.name);
  }

  async upsertPerson(person: {
    user_id: string;
    name: string;
    document_path: string;
    relationship?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.client
      .from("people")
      .upsert(
        {
          user_id: person.user_id,
          name: person.name,
          document_path: person.document_path,
          relationship: person.relationship || null,
          status: person.status || "active",
          metadata: person.metadata || {},
        },
        { onConflict: "user_id,name" }
      );

    if (error) throw error;
  }

  async seedPeople(
    userId: string,
    people: Array<{ name: string; relationship?: string; status?: string }>
  ): Promise<number> {
    let count = 0;
    for (const person of people) {
      const documentPath = `people/${person.name.toLowerCase().replace(/\s+/g, "_")}`;
      await this.upsertPerson({
        user_id: userId,
        name: person.name,
        document_path: documentPath,
        relationship: person.relationship,
        status: person.status,
      });
      count++;
    }
    return count;
  }

  // ============ Projects ============

  async getKnownProjects(userId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("documents")
      .select("title")
      .eq("user_id", userId)
      .like("path", "business/%")
      .not("title", "is", null);

    if (error) throw error;
    return (data || []).map((d) => d.title as string);
  }

  // ============ Tasks ============

  async insertTask(task: {
    user_id: string;
    content: string;
    context: string | null;
    priority: number;
    deadline: string | null;
    status: string;
    project_path: string | null;
    source_message_id: string | null;
    completed_at: string | null;
  }): Promise<{ error: Error | null }> {
    const { error } = await this.client.from("tasks").insert(task);
    return { error: error as Error | null };
  }

  async getOpenTasks(userId: string): Promise<Array<{
    id: string;
    content: string;
    priority: number;
    deadline: string | null;
    created_at: string;
  }>> {
    const { data, error } = await this.client
      .from("tasks")
      .select("id, content, priority, deadline, created_at")
      .eq("user_id", userId)
      .eq("status", "open")
      .order("priority", { ascending: true })
      .order("deadline", { ascending: true, nullsFirst: false });

    if (error) throw error;
    return data || [];
  }

  // ============ Attachments ============

  async insertAttachment(attachment: {
    user_id: string;
    attachment_type: "voice" | "image" | "video" | "file";
    r2_key?: string; // Optional when using Stream for videos
    stream_uid?: string; // Cloudflare Stream video UID for iOS-compatible playback
    transcript?: string;
    description?: string | null;
    tags?: string[]; // Tags from AI tagging pipeline
    file_size: number;
    mime_type?: string;
    folder_id?: string; // Optional folder to place attachment in
    metadata?: Record<string, unknown>;
  }): Promise<{ data: { id: string } | null; error: Error | null }> {
    const { data, error } = await this.client
      .from("attachments")
      .insert(attachment)
      .select("id")
      .single();

    return { data, error: error as Error | null };
  }

  async getAttachment(
    userId: string,
    attachmentId: string
  ): Promise<{
    id: string;
    r2_key: string | null;
    stream_uid: string | null;
    attachment_type: string;
  } | null> {
    const { data } = await this.client
      .from("attachments")
      .select("id, r2_key, stream_uid, attachment_type")
      .eq("id", attachmentId)
      .eq("user_id", userId)
      .single();

    return data;
  }

  // ============ Delete Operations ============

  /**
   * Delete a message by ID
   * Returns the attachment_id if one was linked (for R2 cleanup)
   */
  async deleteMessage(
    userId: string,
    messageId: string
  ): Promise<{ deleted: boolean; attachmentId?: string }> {
    // First get the message to check for attachment
    const { data: message } = await this.client
      .from("messages")
      .select("id, attachment_id")
      .eq("id", messageId)
      .eq("user_id", userId)
      .single();

    if (!message) return { deleted: false };

    // Delete the message
    const { error } = await this.client
      .from("messages")
      .delete()
      .eq("id", messageId)
      .eq("user_id", userId);

    if (error) throw error;
    return { deleted: true, attachmentId: message.attachment_id || undefined };
  }

  /**
   * Delete a document by ID
   */
  async deleteDocument(userId: string, documentId: string): Promise<boolean> {
    const { error } = await this.client
      .from("documents")
      .delete()
      .eq("id", documentId)
      .eq("user_id", userId);

    if (error) throw error;
    return true;
  }

  /**
   * Delete an attachment record by ID
   * Returns the r2_key for R2 cleanup
   */
  async deleteAttachment(
    userId: string,
    attachmentId: string
  ): Promise<{ deleted: boolean; r2Key?: string }> {
    // Get attachment to retrieve r2_key
    const { data: attachment } = await this.client
      .from("attachments")
      .select("id, r2_key")
      .eq("id", attachmentId)
      .eq("user_id", userId)
      .single();

    if (!attachment) return { deleted: false };

    // Delete the attachment record
    const { error } = await this.client
      .from("attachments")
      .delete()
      .eq("id", attachmentId)
      .eq("user_id", userId);

    if (error) throw error;
    return { deleted: true, r2Key: attachment.r2_key };
  }

  // ============ Semantic Search ============

  async searchMessages(
    userId: string,
    embedding: number[],
    limit: number = 5
  ): Promise<Message[]> {
    const { data, error } = await this.client.rpc("match_messages", {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: limit,
    });

    if (error) throw error;
    return data as Message[];
  }

  async searchDocuments(
    userId: string,
    embedding: number[],
    limit: number = 5,
    includeInternal: boolean = false
  ): Promise<Array<{ path: string; title: string; summary: string; similarity: number }>> {
    const { data, error } = await this.client.rpc("match_documents", {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: limit,
      include_internal: includeInternal,
    });

    if (error) throw error;
    return data || [];
  }

  /**
   * Search for relevant territories by embedding similarity
   */
  async matchTerritories(
    userId: string,
    embedding: number[],
    limit: number = 3
  ): Promise<Array<{
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
  }>> {
    const { data, error } = await this.client.rpc("match_territories", {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: limit,
    });

    if (error) {
      console.error("match_territories error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Search for relevant semantic themes by embedding similarity
   */
  async matchSemanticThemes(
    userId: string,
    embedding: number[],
    limit: number = 3
  ): Promise<Array<{
    realm_id: number;
    semantic_theme_id: number;
    name: string;
    essence: string | null;
    territory_count: number;
    message_count: number;
    story_current_chapter: string | null;
    similarity: number;
  }>> {
    const { data, error } = await this.client.rpc("match_semantic_themes", {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: limit,
    });

    if (error) {
      console.error("match_semantic_themes error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Search for relevant realms by embedding similarity
   */
  async matchRealms(
    userId: string,
    embedding: number[],
    limit: number = 2
  ): Promise<Array<{
    realm_id: number;
    name: string;
    essence: string | null;
    territory_count: number;
    message_count: number;
    story_current_chapter: string | null;
    agent_expertise: string | null;
    agent_can_help_with: string[] | null;
    similarity: number;
  }>> {
    const { data, error } = await this.client.rpc("match_realms", {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: limit,
    });

    if (error) {
      console.error("match_realms error:", error);
      return [];
    }
    return data || [];
  }

  // ============ Message Buffer (for long message batching) ============

  /**
   * Add a message chunk to the buffer
   */
  async addToBuffer(
    userId: string,
    chatId: number,
    text: string
  ): Promise<void> {
    // Get current chunk count for ordering
    const { count } = await this.client
      .from("message_buffer")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("telegram_chat_id", chatId)
      .gte("created_at", new Date(Date.now() - 10000).toISOString()); // Last 10 seconds

    const { error } = await this.client.from("message_buffer").insert({
      user_id: userId,
      telegram_chat_id: chatId,
      chunk_text: text,
      chunk_order: count || 0,
    });

    if (error) throw error;
  }

  /**
   * Get all buffered chunks for a user/chat from the last few seconds
   */
  async getBufferedChunks(
    userId: string,
    chatId: number,
    windowMs: number = 10000
  ): Promise<string[]> {
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const { data, error } = await this.client
      .from("message_buffer")
      .select("chunk_text, chunk_order")
      .eq("user_id", userId)
      .eq("telegram_chat_id", chatId)
      .gte("created_at", cutoff)
      .order("chunk_order", { ascending: true });

    if (error) throw error;
    return (data || []).map((d) => d.chunk_text);
  }

  /**
   * Clear the buffer for a user/chat
   */
  async clearBuffer(userId: string, chatId: number): Promise<void> {
    const { error } = await this.client
      .from("message_buffer")
      .delete()
      .eq("user_id", userId)
      .eq("telegram_chat_id", chatId);

    if (error) throw error;
  }

  /**
   * Get the timestamp of the last buffered chunk
   */
  async getLastBufferTime(userId: string, chatId: number): Promise<Date | null> {
    const { data } = await this.client
      .from("message_buffer")
      .select("created_at")
      .eq("user_id", userId)
      .eq("telegram_chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    return data ? new Date(data.created_at) : null;
  }

  // ============ Portal Registration Tokens ============

  /**
   * Create a registration token for portal passkey setup
   */
  async createRegistrationToken(
    userId: string,
    token: string,
    expiresAt: Date
  ): Promise<void> {
    const { error } = await this.client.from("registration_tokens").insert({
      user_id: userId,
      token,
      expires_at: expiresAt.toISOString(),
    });

    if (error) throw error;
  }

  /**
   * Delete all registration tokens for a user
   */
  async deleteRegistrationTokens(userId: string): Promise<void> {
    const { error } = await this.client
      .from("registration_tokens")
      .delete()
      .eq("user_id", userId);

    if (error) throw error;
  }

  /**
   * Verify and consume a registration token
   * Returns the user_id if valid, null otherwise
   */
  async verifyRegistrationToken(token: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("registration_tokens")
      .select("user_id, expires_at")
      .eq("token", token)
      .single();

    if (error || !data) return null;
    if (new Date(data.expires_at) < new Date()) return null;

    return data.user_id;
  }

  // ============ Co-firing Substrate (Graph Traversal) ============

  /**
   * Get territories that co-fire with a given territory
   */
  async getCofireTerritories(
    userId: string,
    territoryId: number,
    scale: "immediate" | "session" | "daily" | "weekly" = "session",
    minStrength: number = 0.1,
    limit: number = 10
  ): Promise<Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    cofire_strength: number;
    semantic_similarity: number | null;
    last_cofire_at: string | null;
    message_count: number;
  }>> {
    const { data, error } = await this.client.rpc("get_cofire_territories", {
      p_user_id: userId,
      p_territory_id: territoryId,
      p_scale: scale,
      p_min_strength: minStrength,
      p_limit: limit,
    });

    if (error) {
      console.error("get_cofire_territories error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Get orphan territories (high content but low connectivity)
   */
  async getOrphanTerritories(
    userId: string,
    minMessages: number = 50,
    maxConnections: number = 3,
    scale: "immediate" | "session" | "daily" | "weekly" = "weekly",
    limit: number = 10
  ): Promise<Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    message_count: number;
    connection_count: number;
    total_cofire_strength: number;
  }>> {
    const { data, error } = await this.client.rpc("get_orphan_territories", {
      p_user_id: userId,
      p_min_messages: minMessages,
      p_max_connections: maxConnections,
      p_scale: scale,
      p_limit: limit,
    });

    if (error) {
      console.error("get_orphan_territories error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Get bridge territories (connect different clusters/realms)
   */
  async getBridgeTerritories(
    userId: string,
    minConnections: number = 5,
    scale: "immediate" | "session" | "daily" | "weekly" = "weekly",
    limit: number = 10
  ): Promise<Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    message_count: number;
    connection_count: number;
    connected_realms: number;
    total_cofire_strength: number;
  }>> {
    const { data, error } = await this.client.rpc("get_bridge_territories", {
      p_user_id: userId,
      p_min_connections: minConnections,
      p_scale: scale,
      p_limit: limit,
    });

    if (error) {
      console.error("get_bridge_territories error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Get gaps: territories with high semantic similarity but low co-firing
   */
  async getCofireGaps(
    userId: string,
    territoryId: number,
    minSimilarity: number = 0.7,
    maxCofire: number = 0.5,
    scale: "immediate" | "session" | "daily" | "weekly" = "weekly",
    limit: number = 10
  ): Promise<Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    semantic_similarity: number;
    cofire_strength: number;
    gap_score: number;
    message_count: number;
  }>> {
    const { data, error } = await this.client.rpc("get_cofire_gaps", {
      p_user_id: userId,
      p_territory_id: territoryId,
      p_min_similarity: minSimilarity,
      p_max_cofire: maxCofire,
      p_scale: scale,
      p_limit: limit,
    });

    if (error) {
      console.error("get_cofire_gaps error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Get territory cluster by walking outward from a starting territory
   */
  async getTerritoryCluster(
    userId: string,
    territoryId: number,
    depth: number = 2,
    minStrength: number = 0.3,
    scale: "immediate" | "session" | "daily" | "weekly" = "session"
  ): Promise<Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    depth: number;
    path_strength: number;
    message_count: number;
  }>> {
    const { data, error } = await this.client.rpc("get_territory_cluster", {
      p_user_id: userId,
      p_territory_id: territoryId,
      p_depth: depth,
      p_min_strength: minStrength,
      p_scale: scale,
    });

    if (error) {
      console.error("get_territory_cluster error:", error);
      return [];
    }
    return data || [];
  }

  /**
   * Trigger co-fire computation for a user (typically run by scheduled job)
   */
  async computeCofire(userId: string): Promise<{ pairs_updated: number; duration_ms: number } | null> {
    const { data, error } = await this.client.rpc("compute_territory_cofire", {
      p_user_id: userId,
    });

    if (error) {
      console.error("compute_territory_cofire error:", error);
      return null;
    }
    return data?.[0] || null;
  }

  // ============ TOPOLOGY QUERIES FOR DREAM CYCLE ============

  /**
   * Get territories visited in the last N hours with message counts
   * Uses clustering_points table (new unified clustering data)
   */
  async getTodayTerritories(
    userId: string,
    hoursBack: number = 24
  ): Promise<Array<{
    territory_id: number;
    name: string;
    essence: string | null;
    realm_name: string | null;
    message_count: number;
    last_message_at: string;
  }>> {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    // Query from clustering_points instead of messages
    const { data, error } = await this.client
      .from("clustering_points")
      .select(`
        territory_id,
        created_at
      `)
      .eq("user_id", userId)
      .not("territory_id", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("getTodayTerritories clustering_points error:", error);
      return [];
    }

    // Count points per territory
    const territoryCounts: Record<number, { count: number; lastAt: string }> = {};
    for (const point of data || []) {
      const tid = point.territory_id as number;
      if (tid === -1) continue; // Skip liminal points
      if (!territoryCounts[tid]) {
        territoryCounts[tid] = { count: 0, lastAt: point.created_at };
      }
      territoryCounts[tid].count++;
    }

    const territoryIds = Object.keys(territoryCounts).map(Number);
    if (territoryIds.length === 0) return [];

    // Get territory profiles with realm info
    const { data: profiles, error: profileError } = await this.client
      .from("territory_profiles")
      .select(`
        territory_id,
        name,
        essence,
        realm_id,
        realm_profiles!inner(name)
      `)
      .eq("user_id", userId)
      .in("territory_id", territoryIds);

    if (profileError) {
      console.error("getTodayTerritories profiles error:", profileError);
      return [];
    }

    return (profiles || []).map((p) => ({
      territory_id: p.territory_id,
      name: p.name || `Territory ${p.territory_id}`,
      essence: p.essence,
      realm_name: Array.isArray(p.realm_profiles)
        ? (p.realm_profiles[0]?.name || null)
        : ((p.realm_profiles as { name: string } | null)?.name || null),
      message_count: territoryCounts[p.territory_id]?.count || 0,
      last_message_at: territoryCounts[p.territory_id]?.lastAt || "",
    })).sort((a, b) => b.message_count - a.message_count);
  }

  /**
   * Get top unexplored gaps across all territories (high semantic, low cofire)
   */
  async getTopGaps(
    userId: string,
    minSemantic: number = 0.65,
    maxCofireRelative: number = 0.2,
    limit: number = 10
  ): Promise<Array<{
    territory_a_id: number;
    territory_a_name: string;
    territory_b_id: number;
    territory_b_name: string;
    semantic_similarity: number;
    cofire_strength: number;
    gap_score: number;
  }>> {
    // Get all territory pairs with semantic similarity above threshold
    const { data: profiles, error: profileError } = await this.client
      .from("territory_profiles")
      .select("territory_id, name, embedding")
      .eq("user_id", userId)
      .not("embedding", "is", null);

    if (profileError || !profiles) {
      console.error("getTopGaps profiles error:", profileError);
      return [];
    }

    // Get cofire data
    const { data: cofireData, error: cofireError } = await this.client
      .from("territory_cofire")
      .select("territory_a, territory_b, cofire_weekly")
      .eq("user_id", userId);

    if (cofireError) {
      console.error("getTopGaps cofire error:", cofireError);
      return [];
    }

    // Build cofire lookup
    const cofireMap: Record<string, number> = {};
    let maxCofire = 0;
    for (const cf of cofireData || []) {
      const key = `${cf.territory_a}-${cf.territory_b}`;
      cofireMap[key] = cf.cofire_weekly;
      if (cf.cofire_weekly > maxCofire) maxCofire = cf.cofire_weekly;
    }

    // Calculate gaps using embedding similarity
    // Note: This is computationally expensive, so we sample
    const gaps: Array<{
      territory_a_id: number;
      territory_a_name: string;
      territory_b_id: number;
      territory_b_name: string;
      semantic_similarity: number;
      cofire_strength: number;
      gap_score: number;
    }> = [];

    // For efficiency, use SQL-based similarity if available, otherwise skip
    // This is a simplified version - full implementation would use RPC
    const { data: gapData, error: gapError } = await this.client
      .rpc("get_global_cofire_gaps", {
        p_user_id: userId,
        p_min_similarity: minSemantic,
        p_max_cofire: maxCofire * maxCofireRelative,
        p_limit: limit,
      });

    if (!gapError && gapData) {
      return gapData;
    }

    // Fallback: return empty if RPC doesn't exist yet
    return gaps;
  }

  /**
   * Get unexpected connections (high cofire, low semantic)
   */
  async getUnexpectedConnections(
    userId: string,
    maxSemantic: number = 0.35,
    minCofireRelative: number = 0.5,
    limit: number = 10
  ): Promise<Array<{
    territory_a_id: number;
    territory_a_name: string;
    territory_b_id: number;
    territory_b_name: string;
    semantic_similarity: number;
    cofire_strength: number;
  }>> {
    const { data, error } = await this.client
      .rpc("get_unexpected_connections", {
        p_user_id: userId,
        p_max_similarity: maxSemantic,
        p_min_cofire_relative: minCofireRelative,
        p_limit: limit,
      });

    if (error) {
      // RPC might not exist yet, return empty
      console.error("getUnexpectedConnections error:", error);
      return [];
    }

    return data || [];
  }

  /**
   * Get territory flow sequence from recent activity
   * Uses clustering_points table (new unified clustering data)
   */
  async getTerritoryFlow(
    userId: string,
    hoursBack: number = 24
  ): Promise<Array<{
    territory_id: number;
    name: string;
    timestamp: string;
  }>> {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    // Query from clustering_points instead of messages
    const { data, error } = await this.client
      .from("clustering_points")
      .select(`
        territory_id,
        created_at
      `)
      .eq("user_id", userId)
      .not("territory_id", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("getTerritoryFlow error:", error);
      return [];
    }

    // Get unique territory IDs (excluding liminal -1)
    const territoryIds = [...new Set((data || [])
      .map(p => p.territory_id as number)
      .filter(tid => tid !== -1))];
    if (territoryIds.length === 0) return [];

    // Get names
    const { data: profiles } = await this.client
      .from("territory_profiles")
      .select("territory_id, name")
      .eq("user_id", userId)
      .in("territory_id", territoryIds);

    const nameMap: Record<number, string> = {};
    for (const p of profiles || []) {
      nameMap[p.territory_id] = p.name || `Territory ${p.territory_id}`;
    }

    // Build flow with deduplication of consecutive same-territory
    const flow: Array<{ territory_id: number; name: string; timestamp: string }> = [];
    let lastTid: number | null = null;
    for (const point of data || []) {
      const tid = point.territory_id as number;
      if (tid === -1) continue; // Skip liminal
      if (tid !== lastTid) {
        flow.push({
          territory_id: tid,
          name: nameMap[tid] || `Territory ${tid}`,
          timestamp: point.created_at,
        });
        lastTid = tid;
      }
    }

    return flow;
  }

  // ============ Usage Tracking ============

  /**
   * Check if user has remaining budget before making Claude API calls
   */
  async checkBudget(userId: string): Promise<{
    allowed: boolean;
    remaining_cents: number;
    budget_limit_cents: number;
    used_cents: number;
    period_start: string;
    period_end: string;
  } | null> {
    const { data, error } = await this.client.rpc("check_budget", {
      p_user_id: userId,
    });

    if (error) {
      console.error("check_budget error:", error);
      return null; // Don't block on budget check errors
    }

    return data && data.length > 0 ? data[0] : null;
  }

  /**
   * Track usage after Claude API call
   * Returns whether user is still within budget
   */
  async trackUsage(
    userId: string,
    inputTokens: number,
    outputTokens: number,
    costCents: number
  ): Promise<{
    allowed: boolean;
    remaining_cents: number;
    budget_limit_cents: number;
    total_cost_cents: number;
  } | null> {
    const { data, error } = await this.client.rpc("increment_usage", {
      p_user_id: userId,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_cost_cents: costCents,
    });

    if (error) {
      console.error("increment_usage error:", error);
      return null;
    }

    return data && data.length > 0 ? data[0] : null;
  }

  // ============ Scheduled Events ============

  /**
   * Check if a scheduled event type is enabled for a user
   * Returns true if enabled (default), false if explicitly disabled
   */
  async isScheduledEventEnabled(
    userId: string,
    eventType: "morning" | "evening" | "weekly" | "reflection"
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("scheduled_events")
      .select("enabled")
      .eq("user_id", userId)
      .eq("event_type", eventType)
      .single();

    if (error || !data) {
      // If no record exists, default to enabled
      return true;
    }

    return data.enabled;
  }

  // ============ Note Links (Wiki Links) ============

  /**
   * Delete all note links for a source document or message
   */
  async deleteNoteLinks(
    userId: string,
    sourceType: 'document' | 'message',
    sourceId: string
  ): Promise<void> {
    await this.client
      .from("note_links")
      .delete()
      .eq("user_id", userId)
      .eq("source_type", sourceType)
      .eq("source_id", sourceId);
  }

  /**
   * Insert a note link
   */
  async insertNoteLink(link: {
    user_id: string;
    source_type: 'document' | 'message';
    source_id: string;
    source_path: string | null;
    target_name: string;
    target_path: string | null;
    target_id: string | null;
    link_type: 'wiki' | 'embed' | 'markdown';
    anchor: string | null;
    display_text: string | null;
    resolved: boolean;
  }): Promise<void> {
    await this.client
      .from("note_links")
      .insert(link);
  }

  /**
   * Get backlinks for a document (what links to this document)
   */
  async getBacklinks(userId: string, documentId: string): Promise<any[]> {
    const { data, error } = await this.client
      .from("note_links")
      .select(`
        *,
        source_document:documents!note_links_source_id_fkey(id, path, title)
      `)
      .eq("user_id", userId)
      .eq("target_id", documentId)
      .eq("source_type", "document");

    if (error) {
      console.error("Error fetching backlinks:", error);
      return [];
    }

    return data || [];
  }

  /**
   * Get all documents for a user (for link resolution)
   */
  async getUserDocuments(userId: string): Promise<Document[]> {
    const { data, error } = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.error("Error fetching user documents:", error);
      return [];
    }

    return data as Document[];
  }

  /**
   * Search documents by title or path for autocomplete
   */
  async searchDocumentsForLinking(userId: string, query: string, limit: number = 10): Promise<Document[]> {
    const { data, error } = await this.client
      .from("documents")
      .select("id, path, title, summary")
      .eq("user_id", userId)
      .or(`title.ilike.%${query}%,path.ilike.%${query}%`)
      .limit(limit);

    if (error) {
      console.error("Error searching documents:", error);
      return [];
    }

    return data as Document[];
  }

  /**
   * Resolve a wiki link target to a document
   * Tries multiple matching strategies (exact path, title, fuzzy)
   */
  async resolveWikiLinkTarget(userId: string, target: string): Promise<Document | null> {
    // Normalize target: strip file extensions and special suffixes
    let normalizedTarget = target;

    // Remove common file extensions
    normalizedTarget = normalizedTarget.replace(/\.(md|html|htm|txt|pdf)$/i, '');

    // Remove duplicate suffixes like " (1)", " (2)", etc.
    normalizedTarget = normalizedTarget.replace(/\s*\(\d+\)$/, '');

    // Try exact path match first
    let result = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .eq("path", target)
      .single();

    if (result.data) return result.data as Document;

    // Try with normalized target
    if (normalizedTarget !== target) {
      result = await this.client
        .from("documents")
        .select("*")
        .eq("user_id", userId)
        .eq("path", normalizedTarget)
        .single();

      if (result.data) return result.data as Document;
    }

    // Try exact title match
    result = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .eq("title", target)
      .single();

    if (result.data) return result.data as Document;

    // Try normalized title match
    if (normalizedTarget !== target) {
      result = await this.client
        .from("documents")
        .select("*")
        .eq("user_id", userId)
        .eq("title", normalizedTarget)
        .single();

      if (result.data) return result.data as Document;
    }

    // Try case-insensitive path match
    result = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .ilike("path", target)
      .single();

    if (result.data) return result.data as Document;

    // Try normalized case-insensitive match
    if (normalizedTarget !== target) {
      result = await this.client
        .from("documents")
        .select("*")
        .eq("user_id", userId)
        .ilike("path", normalizedTarget)
        .single();

      if (result.data) return result.data as Document;
    }

    // Try case-insensitive title match
    result = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .ilike("title", target)
      .single();

    if (result.data) return result.data as Document;

    // Try normalized title match case-insensitive
    if (normalizedTarget !== target) {
      result = await this.client
        .from("documents")
        .select("*")
        .eq("user_id", userId)
        .ilike("title", normalizedTarget)
        .single();

      if (result.data) return result.data as Document;
    }

    // Try path ending with target (handles "Note" matching "folder/Note")
    const pathEndResult = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .ilike("path", `%/${target}`)
      .limit(1);

    if (pathEndResult.data && pathEndResult.data.length > 0) {
      return pathEndResult.data[0] as Document;
    }

    // Try path ending with normalized target
    if (normalizedTarget !== target) {
      const normalizedPathEndResult = await this.client
        .from("documents")
        .select("*")
        .eq("user_id", userId)
        .ilike("path", `%/${normalizedTarget}`)
        .limit(1);

      if (normalizedPathEndResult.data && normalizedPathEndResult.data.length > 0) {
        return normalizedPathEndResult.data[0] as Document;
      }
    }

    // Try fuzzy match on title (contains)
    const fuzzyResult = await this.client
      .from("documents")
      .select("*")
      .eq("user_id", userId)
      .ilike("title", `%${normalizedTarget}%`)
      .limit(1);

    if (fuzzyResult.data && fuzzyResult.data.length > 0) {
      return fuzzyResult.data[0] as Document;
    }

    return null;
  }
}
