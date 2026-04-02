import type { Env } from "../types/env";
import type { ToolCall } from "../services/claude";
import { DocumentManager } from "../documents/manager";
import { SupabaseService } from "../services/supabase";
import { WorkersAIService } from "../services/workersai";
import type { AgentId } from "../config/mya-agents";
import { getAgentConfig, canDelegate } from "../config/mya-agents";

export interface ToolResult {
  tool_use_id: string;
  content: string;
}

/**
 * Executes Claude's tool calls and returns results
 */
export class ToolExecutor {
  private docManager: DocumentManager;
  private supabase: SupabaseService;
  private workersAI: WorkersAIService;
  private userId: string;
  private env: Env;
  private currentAgentId: AgentId;

  constructor(env: Env, userId: string) {
    this.docManager = new DocumentManager(env);
    this.supabase = new SupabaseService(env);
    this.workersAI = new WorkersAIService(env);
    this.userId = userId;
    this.env = env;
    this.currentAgentId = (env.AGENT_ID as AgentId) || 'mya-personal';
  }

  /**
   * Execute all tool calls and return results
   */
  async executeAll(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        const result = await this.execute(call);
        results.push({
          tool_use_id: call.id,
          content: result,
        });
      } catch (e) {
        const error = e as Error;
        results.push({
          tool_use_id: call.id,
          content: `Error: ${error.message}`,
        });
      }
    }

    return results;
  }

  /**
   * Execute a single tool call
   */
  private async execute(call: ToolCall): Promise<string> {
    const { name, input } = call;

    switch (name) {
      case "updateDocument":
        return await this.updateDocument(input as {
          path: string;
          entry: string;
          entryType: "observation" | "shift" | "note" | "wondering";
          confidence: "low" | "medium" | "provisional";
        });

      case "updateInternalModel":
        return await this.updateInternalModel(input as {
          section: string;
          content: string;
        });

      case "getDocument":
        return await this.getDocument(input as { path: string });

      case "searchHistory":
        return await this.searchHistory(input as {
          query: string;
          scope?: string;
          limit?: number;
        });

      case "createTask":
        return await this.createTask(input as {
          content: string;
          deadline?: string;
          priority?: number;
          projectPath?: string;
        });

      case "createDocument":
        return await this.createDocument(input as {
          path: string;
          title: string;
          initialContent: string;
          folder?: string;
          canvas?: string;
        });

      case "listDocuments":
        return await this.listDocuments(input as { category?: string });

      case "listFolders":
        return await this.listFolders();

      case "listCanvases":
        return await this.listCanvases();

      case "pinDocument":
        return await this.pinDocument(input as { path: string });

      case "unpinDocument":
        return await this.unpinDocument(input as { path: string });

      case "flagForDiscussion":
        return await this.flagForDiscussion(input as {
          topic: string;
          context: string;
        });

      case "searchTerritories":
        return await this.searchTerritories(input as {
          query: string;
          limit?: number;
        });

      case "searchRealms":
        return await this.searchRealms(input as {
          query: string;
          limit?: number;
        });

      case "searchThemes":
        return await this.searchThemes(input as {
          query: string;
          limit?: number;
        });

      // ============ CO-FIRING TRAVERSAL TOOLS ============

      case "getCoFiring":
        return await this.getCoFiring(input as {
          territory_id: number;
          scale?: "immediate" | "session" | "daily" | "weekly";
          min_strength?: number;
          limit?: number;
        });

      case "getOrphans":
        return await this.getOrphans(input as {
          min_messages?: number;
          max_connections?: number;
          scale?: "immediate" | "session" | "daily" | "weekly";
          limit?: number;
        });

      case "getBridges":
        return await this.getBridges(input as {
          min_connections?: number;
          scale?: "immediate" | "session" | "daily" | "weekly";
          limit?: number;
        });

      case "getGaps":
        return await this.getGaps(input as {
          territory_id: number;
          min_similarity?: number;
          max_cofire?: number;
          scale?: "immediate" | "session" | "daily" | "weekly";
          limit?: number;
        });

      case "getCluster":
        return await this.getCluster(input as {
          territory_id: number;
          depth?: number;
          min_strength?: number;
          scale?: "immediate" | "session" | "daily" | "weekly";
        });

      // ============ MULTI-AGENT DELEGATION ============

      case "delegate_to_agent":
        return await this.delegateToAgent(input as {
          agent: AgentId;
          task: string;
          context?: string;
          priority?: "low" | "normal" | "high";
        });

      default:
        return `Unknown tool: ${name}`;
    }
  }

  // ============ TOOL IMPLEMENTATIONS ============

  private async updateDocument(input: {
    path: string;
    entry: string;
    entryType: "observation" | "shift" | "note" | "wondering";
    confidence: "low" | "medium" | "provisional";
  }): Promise<string> {
    const timestamp = new Date().toISOString().split("T")[0];

    await this.docManager.addEntry(this.userId, input.path, {
      timestamp,
      type: input.entryType,
      confidence: input.confidence,
      content: input.entry,
    });

    return `Updated ${input.path} with ${input.entryType}`;
  }

  private async updateInternalModel(input: {
    section: string;
    content: string;
  }): Promise<string> {
    await this.docManager.updateInternalModel(
      this.userId,
      input.section,
      input.content
    );

    return `Updated internal model (${input.section})`;
  }

  private async getDocument(input: { path: string }): Promise<string> {
    // Use supabase directly with trackAccess=true to record explicit document requests
    // This helps with activation-based retrieval scoring
    const doc = await this.supabase.getDocument(this.userId, input.path, true);
    if (!doc) {
      return `Document not found: ${input.path}`;
    }

    // Internal documents are now accessible - Mya can read its own reflections
    return doc.content;
  }

  private async searchHistory(input: {
    query: string;
    scope?: string;
    limit?: number;
  }): Promise<string> {
    const embedding = await this.workersAI.generateEmbedding(input.query);
    const limit = input.limit || 5;

    // Search messages
    const messages = await this.supabase.searchMessages(
      this.userId,
      embedding,
      limit
    );

    if (messages.length === 0) {
      return "No relevant messages found.";
    }

    const results = messages.map((m) => {
      const date = new Date(m.created_at).toISOString().split("T")[0];
      const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
      const preview = m.content.substring(0, 150);
      return `[${date}]${tags} ${m.role}: ${preview}...`;
    });

    return `Found ${messages.length} relevant messages:\n\n${results.join("\n\n")}`;
  }

  private async createTask(input: {
    content: string;
    deadline?: string;
    priority?: number;
    projectPath?: string;
  }): Promise<string> {
    const { error } = await this.supabase.insertTask({
      user_id: this.userId,
      content: input.content,
      deadline: input.deadline || null,
      priority: input.priority || 3,
      project_path: input.projectPath || null,
      status: "open",
      context: null,
      source_message_id: null,
      completed_at: null,
    });

    if (error) {
      return `Failed to create task: ${error.message}`;
    }

    const deadline = input.deadline ? ` (due: ${input.deadline})` : "";
    return `Task created: "${input.content}"${deadline}`;
  }

  private async createDocument(input: {
    path: string;
    title: string;
    initialContent: string;
    folder?: string;
    canvas?: string;
  }): Promise<string> {
    // Check if document already exists
    const existing = await this.docManager.getDocument(this.userId, input.path);
    if (existing) {
      return `Document already exists at ${input.path}. Use updateDocument to modify it.`;
    }

    // Create the document with initial content
    const content = `# ${input.title}\n\n${input.initialContent}`;

    // Generate embedding for the content
    const embedding = await this.workersAI.generateEmbedding(content);

    // Resolve folder - only assign if explicitly specified
    // Documents should NOT default to Inbox; only #inbox hashtag routes to Inbox
    let folderId: string | null = null;
    let folderName: string | null = null;
    if (input.folder) {
      const folder = await this.supabase.getFolderByName(this.userId, input.folder);
      if (folder) {
        folderId = folder.id;
        folderName = folder.name;
      } else {
        return `Folder not found: "${input.folder}". Create it first or use an existing folder.`;
      }
    }
    // If no folder specified, leave folderId as null (unfiled)

    // Insert via supabase
    const doc = await this.supabase.upsertDocument({
      user_id: this.userId,
      path: input.path,
      title: input.title,
      content: content,
      summary: input.initialContent.substring(0, 100),
      is_internal: input.path.startsWith("internal/"),
      folder_id: folderId,
      metadata: {},
    });

    // Add to canvas if specified
    let canvasNote = "";
    if (input.canvas) {
      const canvas = await this.supabase.getCanvasByName(this.userId, input.canvas);
      if (canvas) {
        await this.supabase.addNodeToCanvas(canvas.id, doc.id, "document");
        canvasNote = ` and added to canvas "${canvas.name}"`;
      } else {
        canvasNote = ` (canvas "${input.canvas}" not found, skipped)`;
      }
    }

    const folderNote = folderName ? ` in folder "${folderName}"` : "";
    return `Created document: ${input.title} at ${input.path}${folderNote}${canvasNote}`;
  }

  private async listDocuments(input: { category?: string }): Promise<string> {
    const docs = await this.supabase.listAllDocuments(this.userId);

    // Filter by category if provided
    let filtered = docs;
    if (input.category) {
      filtered = docs.filter((d) => d.path.startsWith(input.category + "/"));
    }

    if (filtered.length === 0) {
      return input.category
        ? `No documents found in category: ${input.category}`
        : "No documents found.";
    }

    // Group by category
    const grouped: Record<string, typeof filtered> = {};
    for (const doc of filtered) {
      const category = doc.path.split("/")[0];
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(doc);
    }

    // Format output
    const lines: string[] = [];
    for (const [category, categoryDocs] of Object.entries(grouped)) {
      lines.push(`\n**${category}/**`);
      for (const doc of categoryDocs) {
        const internal = doc.is_internal ? " [internal]" : "";
        const summary = doc.summary ? ` - ${doc.summary.substring(0, 50)}...` : "";
        lines.push(`  - ${doc.path}${internal}${summary}`);
      }
    }

    return `Found ${filtered.length} documents:${lines.join("\n")}`;
  }

  private async listFolders(): Promise<string> {
    const folders = await this.supabase.listFolders(this.userId);

    if (folders.length === 0) {
      return "No folders found.";
    }

    // Separate system and user folders
    const systemFolders = folders.filter((f) => f.folder_type === "system");
    const userFolders = folders.filter((f) => f.folder_type === "user");

    const lines: string[] = [];

    if (systemFolders.length > 0) {
      lines.push("**System folders:**");
      for (const folder of systemFolders) {
        const icon = folder.icon ? `[${folder.icon}] ` : "";
        lines.push(`  - ${icon}${folder.name}`);
      }
    }

    if (userFolders.length > 0) {
      lines.push("\n**User folders:**");
      for (const folder of userFolders) {
        const icon = folder.icon ? `[${folder.icon}] ` : "";
        lines.push(`  - ${icon}${folder.name}`);
      }
    }

    return `Found ${folders.length} folders:\n${lines.join("\n")}`;
  }

  private async listCanvases(): Promise<string> {
    const canvases = await this.supabase.listCanvases(this.userId);

    if (canvases.length === 0) {
      return "No canvases found.";
    }

    const lines: string[] = [];
    for (const canvas of canvases) {
      const pub = canvas.is_public ? " [public]" : "";
      lines.push(`  - ${canvas.name}${pub}`);
    }

    return `Found ${canvases.length} canvases:\n${lines.join("\n")}`;
  }

  private async pinDocument(input: { path: string }): Promise<string> {
    // Verify document exists
    const doc = await this.docManager.getDocument(this.userId, input.path);
    if (!doc) {
      return `Document not found: ${input.path}`;
    }

    // Get current pinned docs
    const pinned = await this.supabase.getPinnedDocuments(this.userId);

    // Check if already pinned
    if (pinned.includes(input.path)) {
      return `Document already pinned: ${input.path}`;
    }

    // Limit to 5 pinned docs to avoid context bloat
    if (pinned.length >= 5) {
      return `Cannot pin more than 5 documents. Current pinned: ${pinned.join(", ")}. Unpin one first.`;
    }

    // Add to pinned
    await this.supabase.setPinnedDocuments(this.userId, [...pinned, input.path]);
    return `Pinned: ${input.path}. It will appear in your context from now on.`;
  }

  private async unpinDocument(input: { path: string }): Promise<string> {
    const pinned = await this.supabase.getPinnedDocuments(this.userId);

    if (!pinned.includes(input.path)) {
      return `Document is not pinned: ${input.path}`;
    }

    const newPinned = pinned.filter((p) => p !== input.path);
    await this.supabase.setPinnedDocuments(this.userId, newPinned);
    return `Unpinned: ${input.path}`;
  }

  private async flagForDiscussion(input: {
    topic: string;
    context: string;
  }): Promise<string> {
    // Add to reflection log with flag
    await this.docManager.addReflection(
      this.userId,
      `Flagged for discussion: ${input.context}`,
      input.topic
    );

    return `Flagged "${input.topic}" for next conversation`;
  }

  private async searchTerritories(input: {
    query: string;
    limit?: number;
  }): Promise<string> {
    const embedding = await this.workersAI.generateEmbedding(input.query);
    const limit = input.limit || 5;

    const territories = await this.supabase.matchTerritories(
      this.userId,
      embedding,
      limit
    );

    if (territories.length === 0) {
      return "No matching territories found.";
    }

    const results = territories.map((t) => {
      const lines: string[] = [];
      lines.push(`**${t.name}** (${Math.round((t.similarity || 0) * 100)}% match)`);
      if (t.essence) lines.push(`  ${t.essence}`);
      if (t.story_current_chapter) lines.push(`  Current chapter: ${t.story_current_chapter}`);
      if (t.agent_expertise) lines.push(`  Expertise: ${t.agent_expertise}`);
      if (t.message_count) lines.push(`  ${t.message_count.toLocaleString()} messages`);
      return lines.join("\n");
    });

    return `Found ${territories.length} territories:\n\n${results.join("\n\n")}`;
  }

  private async searchRealms(input: {
    query: string;
    limit?: number;
  }): Promise<string> {
    const embedding = await this.workersAI.generateEmbedding(input.query);
    const limit = input.limit || 3;

    const realms = await this.supabase.matchRealms(
      this.userId,
      embedding,
      limit
    );

    if (realms.length === 0) {
      return "No matching realms found.";
    }

    const results = realms.map((r) => {
      const lines: string[] = [];
      lines.push(`**${r.name}** (${Math.round((r.similarity || 0) * 100)}% match)`);
      if (r.essence) lines.push(`  ${r.essence}`);
      if (r.story_current_chapter) lines.push(`  Current chapter: ${r.story_current_chapter}`);
      if (r.agent_expertise) lines.push(`  Expertise: ${r.agent_expertise}`);
      lines.push(`  ${r.territory_count} territories, ${r.message_count?.toLocaleString() || 0} messages`);
      return lines.join("\n");
    });

    return `Found ${realms.length} realms:\n\n${results.join("\n\n")}`;
  }

  private async searchThemes(input: {
    query: string;
    limit?: number;
  }): Promise<string> {
    const embedding = await this.workersAI.generateEmbedding(input.query);
    const limit = input.limit || 5;

    const themes = await this.supabase.matchSemanticThemes(
      this.userId,
      embedding,
      limit
    );

    if (themes.length === 0) {
      return "No matching themes found.";
    }

    const results = themes.map((t) => {
      const lines: string[] = [];
      lines.push(`**${t.name}** (${Math.round((t.similarity || 0) * 100)}% match)`);
      if (t.essence) lines.push(`  ${t.essence}`);
      if (t.story_current_chapter) lines.push(`  Current chapter: ${t.story_current_chapter}`);
      lines.push(`  ${t.territory_count} territories, ${t.message_count?.toLocaleString() || 0} messages`);
      return lines.join("\n");
    });

    return `Found ${themes.length} themes:\n\n${results.join("\n\n")}`;
  }

  // ============ CO-FIRING TRAVERSAL TOOL IMPLEMENTATIONS ============

  private async getCoFiring(input: {
    territory_id: number;
    scale?: "immediate" | "session" | "daily" | "weekly";
    min_strength?: number;
    limit?: number;
  }): Promise<string> {
    const territories = await this.supabase.getCofireTerritories(
      this.userId,
      input.territory_id,
      input.scale || "session",
      input.min_strength || 0.1,
      input.limit || 10
    );

    if (territories.length === 0) {
      return `No co-firing territories found for territory ${input.territory_id}. This territory may be isolated or co-fire data hasn't been computed yet.`;
    }

    // Absolute signal thresholds (cumulative decay weights - tune from data)
    // These represent roughly: strong=many recent co-fires, weak=few/old co-fires
    const SIGNAL_LEVELS = {
      strong: 50,    // genuinely fire together frequently
      moderate: 15,  // noticeable connection
      weak: 5,       // sparse signal
      noise: 2       // probably coincidental
    };

    const maxStrength = Math.max(...territories.map((t) => t.cofire_strength));

    // Categorize by signal level
    const strong: typeof territories = [];
    const moderate: typeof territories = [];
    const weak: typeof territories = [];

    for (const t of territories) {
      if (t.cofire_strength >= SIGNAL_LEVELS.strong) strong.push(t);
      else if (t.cofire_strength >= SIGNAL_LEVELS.moderate) moderate.push(t);
      else if (t.cofire_strength >= SIGNAL_LEVELS.weak) weak.push(t);
      // Skip noise-level results
    }

    const formatTerritory = (t: typeof territories[0]) => {
      const lines: string[] = [];
      const sim = t.semantic_similarity !== null ? Math.round(t.semantic_similarity * 100) : null;

      // Identify interesting gaps
      let gapNote = "";
      if (sim !== null) {
        const cofireNorm = t.cofire_strength / maxStrength; // 0-1 relative
        if (cofireNorm > 0.5 && sim < 40) {
          gapNote = " ← unexpected (semantically distant)";
        } else if (cofireNorm < 0.3 && sim > 70) {
          gapNote = " ← gap (should connect more?)";
        }
      }

      lines.push(`• **${t.name}**${gapNote}`);
      if (t.essence) lines.push(`  ${t.essence}`);

      const details: string[] = [];
      if (sim !== null) details.push(`${sim}% semantic`);
      details.push(`${t.message_count.toLocaleString()} msgs`);
      if (t.last_cofire_at) {
        const date = new Date(t.last_cofire_at).toISOString().split("T")[0];
        details.push(`last: ${date}`);
      }
      lines.push(`  ${details.join(", ")}`);

      return lines.join("\n");
    };

    const sections: string[] = [];

    if (strong.length > 0) {
      sections.push(`**Strong connections:**\n${strong.map(formatTerritory).join("\n\n")}`);
    }
    if (moderate.length > 0) {
      sections.push(`**Moderate:**\n${moderate.map(formatTerritory).join("\n\n")}`);
    }
    if (weak.length > 0) {
      sections.push(`**Weak/sparse:**\n${weak.map(formatTerritory).join("\n\n")}`);
    }

    // Signal quality assessment
    const quality = maxStrength >= SIGNAL_LEVELS.strong ? "good"
      : maxStrength >= SIGNAL_LEVELS.moderate ? "moderate"
      : "sparse";

    const qualityNote = `\n\n_Signal quality: ${quality} (max weight ${maxStrength.toFixed(1)}, ${strong.length} strong + ${moderate.length} moderate connections)_`;

    return `Co-firing with territory ${input.territory_id} (${input.scale || "session"} scale):\n\n${sections.join("\n\n")}${qualityNote}`;
  }

  private async getOrphans(input: {
    min_messages?: number;
    max_connections?: number;
    scale?: "immediate" | "session" | "daily" | "weekly";
    limit?: number;
  }): Promise<string> {
    const orphans = await this.supabase.getOrphanTerritories(
      this.userId,
      input.min_messages || 50,
      input.max_connections || 3,
      input.scale || "weekly",
      input.limit || 10
    );

    if (orphans.length === 0) {
      return "No orphan territories found. All substantial territories have connections.";
    }

    const results = orphans.map((t) => {
      const lines: string[] = [];
      lines.push(`**${t.name}** (${t.connection_count} connections)`);
      if (t.essence) lines.push(`  ${t.essence}`);
      lines.push(`  ${t.message_count.toLocaleString()} messages, ${t.total_cofire_strength.toFixed(2)} total co-fire strength`);
      return lines.join("\n");
    });

    return `Orphan territories (high content, low connectivity):\n\n${results.join("\n\n")}\n\nThese may represent isolated insights, avoidance patterns, or areas worth bridging to other topics.`;
  }

  private async getBridges(input: {
    min_connections?: number;
    scale?: "immediate" | "session" | "daily" | "weekly";
    limit?: number;
  }): Promise<string> {
    const bridges = await this.supabase.getBridgeTerritories(
      this.userId,
      input.min_connections || 5,
      input.scale || "weekly",
      input.limit || 10
    );

    if (bridges.length === 0) {
      return "No bridge territories found. This may mean realms are fairly isolated from each other.";
    }

    const results = bridges.map((t) => {
      const lines: string[] = [];
      lines.push(`**${t.name}** (connects ${t.connected_realms} realms)`);
      if (t.essence) lines.push(`  ${t.essence}`);
      lines.push(`  ${t.connection_count} connections, ${t.message_count.toLocaleString()} messages`);
      return lines.join("\n");
    });

    return `Bridge territories (connect different realms):\n\n${results.join("\n\n")}\n\nThese are structural nodes that link different areas of the mindscape.`;
  }

  private async getGaps(input: {
    territory_id: number;
    min_similarity?: number;
    max_cofire?: number;
    scale?: "immediate" | "session" | "daily" | "weekly";
    limit?: number;
  }): Promise<string> {
    const gaps = await this.supabase.getCofireGaps(
      this.userId,
      input.territory_id,
      input.min_similarity || 0.7,
      input.max_cofire || 0.5,
      input.scale || "weekly",
      input.limit || 10
    );

    if (gaps.length === 0) {
      return `No significant gaps found for territory ${input.territory_id}. Semantically similar territories already co-fire together.`;
    }

    // Normalize cofire relative to max in result set
    const maxCofire = Math.max(...gaps.map((t) => t.cofire_strength), 0.01);
    const results = gaps.map((t) => {
      const lines: string[] = [];
      const sim = Math.round(t.semantic_similarity * 100);
      const cofireRelative = Math.round((t.cofire_strength / maxCofire) * 100);
      lines.push(`**${t.name}**`);
      if (t.essence) lines.push(`  ${t.essence}`);
      lines.push(`  ${sim}% semantic similarity, ${cofireRelative}% relative co-fire`);
      lines.push(`  ${t.message_count.toLocaleString()} messages`);
      return lines.join("\n");
    });

    return `Unexplored connections for territory ${input.territory_id}:\n\n${results.join("\n\n")}\n\nThese territories are semantically related but rarely discussed together - potential bridges worth exploring.`;
  }

  private async getCluster(input: {
    territory_id: number;
    depth?: number;
    min_strength?: number;
    scale?: "immediate" | "session" | "daily" | "weekly";
  }): Promise<string> {
    const cluster = await this.supabase.getTerritoryCluster(
      this.userId,
      input.territory_id,
      input.depth || 2,
      input.min_strength || 0.3,
      input.scale || "session"
    );

    if (cluster.length <= 1) {
      return `Territory ${input.territory_id} appears isolated - no strong connections at depth ${input.depth || 2}.`;
    }

    // Group by depth and normalize path strengths
    const byDepth: Record<number, typeof cluster> = {};
    for (const t of cluster) {
      if (!byDepth[t.depth]) byDepth[t.depth] = [];
      byDepth[t.depth].push(t);
    }

    // Normalize path strength relative to max (excluding center which is always 1.0)
    const maxPathStrength = Math.max(...cluster.filter(t => t.depth > 0).map((t) => t.path_strength), 0.01);

    const results: string[] = [];
    for (const [depth, territories] of Object.entries(byDepth)) {
      const depthLabel = depth === "0" ? "Center" : `Depth ${depth}`;
      results.push(`**${depthLabel}:**`);
      for (const t of territories) {
        const relativeStrength = t.depth === 0 ? 100 : Math.round((t.path_strength / maxPathStrength) * 100);
        const line = `  - ${t.name} (${relativeStrength}% relative strength, ${t.message_count.toLocaleString()} messages)`;
        results.push(line);
      }
    }

    return `Cluster around territory ${input.territory_id}:\n\n${results.join("\n")}`;
  }

  // ============ MULTI-AGENT DELEGATION ============

  private async delegateToAgent(input: {
    agent: AgentId;
    task: string;
    context?: string;
    priority?: "low" | "normal" | "high";
  }): Promise<string> {
    const targetAgent = input.agent;
    const priority = input.priority || "normal";

    // Validate delegation is allowed
    if (!canDelegate(this.currentAgentId, targetAgent)) {
      return `Delegation not allowed: ${this.currentAgentId} cannot delegate to ${targetAgent}`;
    }

    // Get target agent config
    const targetConfig = getAgentConfig(targetAgent);
    if (!targetConfig) {
      return `Unknown agent: ${targetAgent}`;
    }

    // Create delegation record in database
    // For now, we store in a simple structure that the orchestrator can pick up
    const delegationId = crypto.randomUUID();
    const delegation = {
      id: delegationId,
      from_agent: this.currentAgentId,
      to_agent: targetAgent,
      user_id: this.userId,
      task: input.task,
      context: input.context || null,
      priority,
      status: "pending" as const,
      created_at: new Date().toISOString(),
    };

    // Store delegation request
    // In production, this would go to a queue or dedicated table
    // For now, we use KV if available, otherwise log
    if (this.env.KV) {
      await this.env.KV.put(
        `delegation:${delegationId}`,
        JSON.stringify(delegation),
        { expirationTtl: 86400 } // 24 hour TTL
      );
    }

    console.log(`[Delegation] ${this.currentAgentId} -> ${targetAgent}:`, {
      id: delegationId,
      task: input.task.substring(0, 100),
      priority,
    });

    // Return acknowledgment
    const agentName = targetConfig.name;
    const priorityNote = priority === "high" ? " (high priority)" : "";

    return `Delegated to ${agentName}${priorityNote}:
- Task: ${input.task}
- Delegation ID: ${delegationId}
- Status: Pending

The task has been queued. Results will be available when ${agentName} completes the work.`;
  }
}
