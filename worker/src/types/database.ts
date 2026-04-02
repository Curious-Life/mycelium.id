// Database types - will be auto-generated from Supabase later
// For now, define manually based on our schema

// ============ GLiNER NLP Types ============

/**
 * Entity extracted by GLiNER
 * 30 entity types for consciousness tracking
 */
export interface GlinerEntity {
  label: string;      // e.g., "emotional_state", "person", "insight"
  text: string;       // The extracted text span
  start: number;      // Character offset start
  end: number;        // Character offset end
  score: number;      // Confidence 0-1
}

/**
 * Relation extracted by GLiNER
 * 25 relation types linking entities
 */
export interface GlinerRelation {
  head: string;       // Source entity text
  tail: string;       // Target entity text
  label: string;      // e.g., "person feels state", "action produces outcome"
  score: number;      // Confidence 0-1
}

/**
 * NLP extraction result from Modal service
 */
export interface NlpExtractionResult {
  entities: GlinerEntity[];
  relations: GlinerRelation[];
  entity_summary: string;  // e.g., "[person:Una] [goal:launch]"
}

// ============ Core Types ============

export interface User {
  id: string;
  telegram_id: number | null;
  username: string | null;
  display_name: string | null;
  timezone: string;
  settings: Record<string, unknown>;
  created_at: string;
  // Added for multi-user invite system
  invite_code: string | null;
  status: "pending" | "active" | "suspended" | "over_budget" | null;
  onboarded_at: string | null;
  invite_expires_at: string | null;
  invited_by: string | null;
}

export interface Document {
  id: string;
  user_id: string;
  path: string;
  title: string | null;
  content: string;
  summary: string | null;
  is_internal: boolean;
  tags?: string[] | null;
  embedding?: number[] | null;
  folder_id?: string | null;

  // Import tracking (added in migration 049)
  source_type?: string | null;  // 'native' | 'claude_import' | 'obsidian' | 'openai_import' | 'apple_notes'
  source_path?: string | null;  // Original path in source system (for dedup)
  content_hash?: string | null; // Content hash for change detection

  // GLiNER NLP outputs (async via queue)
  entities?: GlinerEntity[] | null;
  relations?: GlinerRelation[] | null;
  entity_summary?: string | null;

  // Clustering outputs (nightly batch)
  cluster_id?: number | null;
  landscape_x?: number | null;
  landscape_y?: number | null;
  landscape_z?: number | null;

  metadata: Record<string, unknown>;
  updated_at: string;
  created_at: string;

  // Multi-agent support
  agent_id?: string | null;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  diff: string;
  changed_by: "user" | "bot" | "reflection";
  change_summary: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  message_type: "text" | "voice" | "image" | "video" | "forward";

  // Llama 4 Scout tagging (fast, synchronous)
  tags: string[] | null;
  entities_people: string[] | null;
  entities_projects: string[] | null;
  suggested_new_tag: string | null;

  // GLiNER NLP outputs (async via queue)
  entities: GlinerEntity[] | null;
  relations: GlinerRelation[] | null;
  entity_summary: string | null;

  // Sentiment analysis (RoBERTa transformer)
  sentiment_valence: number | null;  // -1 (negative) to +1 (positive)
  sentiment_arousal: number | null;  // 0 (calm) to 1 (excited)
  sentiment_label: string | null;    // "positive", "negative", "neutral"
  sentiment_confidence: number | null;

  // Clustering outputs (nightly batch)
  cluster_id: number | null;
  landscape_x: number | null;
  landscape_y: number | null;
  landscape_z: number | null;

  // NLP processing state
  nlp_processed: boolean;
  nlp_processed_at: string | null;
  nlp_error: string | null;

  // Core fields
  attachment_id: string | null;
  folder_id: string | null;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  created_at: string;

  // Source tracking
  source: "telegram" | "web" | "import" | null;

  // Thinking mode fields (extended thinking)
  thinking: string | null;
  thinking_enabled: boolean;
  thinking_tokens: number | null;

  // Multi-agent support
  agent_id: string | null;
}

export interface TagVocabulary {
  id: string;
  user_id: string;
  tag: string;
  description: string | null;
  usage_count: number;
  created_at: string;
  created_by: "system" | "llama" | "claude";
}

export interface SuggestedTag {
  id: string;
  user_id: string;
  tag: string;
  source_message_id: string | null;
  context: string | null;
  status: "pending" | "approved" | "rejected" | "merged";
  reviewed_at: string | null;
  merged_into: string | null;
  created_at: string;
}

export interface Reflection {
  id: string;
  user_id: string;
  content: string;
  flagged_for_discussion: string | null;
  context_summary: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  user_id: string;
  content: string;
  context: string | null;
  priority: number;
  deadline: string | null;
  status: "open" | "completed" | "cancelled";
  project_path: string | null;
  source_message_id: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Attachment {
  id: string;
  user_id: string;
  attachment_type: "voice" | "image" | "video" | "file";
  r2_key: string | null; // R2 storage key (nullable - Stream videos don't have this)
  stream_uid: string | null; // Cloudflare Stream video UID for iOS-compatible playback
  original_filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  transcript: string | null;
  description: string | null;
  tags: string[] | null;
  linked_message_id: string | null;
  linked_document_path: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Person {
  id: string;
  user_id: string;
  name: string;
  document_path: string;
  relationship: string | null;
  status: "active" | "background" | "historical";
  last_mentioned: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ScheduledEvent {
  id: string;
  user_id: string;
  event_type: "morning" | "evening" | "weekly" | "reflection";
  schedule_cron: string | null;
  enabled: boolean;
  last_triggered_at: string | null;
  next_trigger_at: string | null;
  config: Record<string, unknown>;
  created_at: string;
}

export interface ShareLink {
  id: string;
  user_id: string;
  resource_type: "document" | "attachment";
  resource_id: string;
  token: string;
  expires_at: string;
  password_hash: string | null;
  max_views: number | null;
  view_count: number;
  created_at: string;
}

// ============ Mindscape Types ============

/**
 * Top-level entity aggregated from messages
 */
export interface TopEntity {
  text: string;
  type: string;
  count: number;
}

/**
 * Realm - conceptual cluster from 10D embeddings
 * Represents a major domain of consciousness (5-6 realms total)
 */
export interface Realm {
  id: string;
  realm_id: number;  // Maps to cluster_id (10D)
  user_id: string;

  // Identity
  name: string;
  essence: string | null;
  archetype_type: string | null;
  archetype_character: string | null;

  // Composition
  territory_count: number;
  message_count: number;
  territory_ids: number[];

  // Entities & Patterns
  top_entities: TopEntity[];
  signature_patterns: string[];

  // Story
  story_birth: string | null;
  story_arc: string | null;
  story_peak_moments: string[];
  story_current_chapter: string | null;

  // Uncertainty
  uncertainty_open_questions: string[];
  uncertainty_edges: string | null;

  // Agent Personality
  agent_expertise: string | null;
  agent_curious_about: string | null;
  agent_can_help_with: string[];

  // Metadata
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Semantic Theme - sub-cluster within a realm (10D)
 * Represents coherent topics within a major conceptual domain
 * Hierarchy: Realm → Semantic Theme → Territory
 */
export interface SemanticTheme {
  id: string;
  realm_id: number;           // Parent realm (cluster_id)
  semantic_theme_id: number;  // Maps to theme_id from 10D sub-clustering
  user_id: string;

  // Identity
  name: string;
  essence: string | null;

  // Composition
  territory_count: number;
  message_count: number;
  territory_ids: number[];

  // Coverage (how much of the theme was used to generate the profile)
  included_territory_count: number;
  coverage_percent: number;

  // Entities & Patterns
  top_entities: TopEntity[];
  signature_patterns: string[];

  // Story
  story_birth: string | null;
  story_arc: string | null;
  story_current_chapter: string | null;

  // Uncertainty
  uncertainty_open_questions: string[];

  // Metadata
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Territory Profile - spatial cluster from 3D embeddings
 */
export interface TerritoryProfile {
  id: string;
  territory_id: number;  // Maps to cluster_3d
  user_id: string;
  realm_id: number | null;
  semantic_theme_id: number | null;  // Parent semantic theme

  // Identity
  name: string;
  essence: string | null;
  archetype_type: string | null;
  archetype_character: string | null;

  // Composition
  message_count: number;
  explored_count: number;
  explored_percent: number;

  // Entities & Patterns
  top_entities: TopEntity[];
  signature_patterns: string[];

  // Story
  story_birth: string | null;
  story_arc: string | null;
  story_peak_moments: string[];
  story_current_chapter: string | null;

  // Uncertainty
  uncertainty_open_questions: string[];
  uncertainty_edges: string | null;

  // Agent Personality
  agent_expertise: string | null;
  agent_curious_about: string | null;
  agent_can_help_with: string[];
  agent_would_consult: Array<{ territory_name: string; for: string }>;

  // Metadata
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============ Batch Processing ============

export interface BatchJob {
  id: string;
  job_type: "entity_extraction" | "embedding" | "clustering";
  status: "pending" | "running" | "completed" | "failed";
  total_items: number | null;
  processed_items: number;
  failed_items: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ============ Queue Payload Types ============

/**
 * Payload sent to NLP processing queue
 */
export interface NlpQueuePayload {
  message_id: string;
  content: string;
  user_id: string;
}

// ============ Insert Types ============

// Insert types (without auto-generated fields)
// InsertMessage allows optional created_at for preserving original timestamps (e.g., Claude export imports)
// thinking_enabled defaults to false in DB, thinking and thinking_tokens are nullable
export type InsertMessage = Omit<Message, "id" | "created_at" | "nlp_processed" | "nlp_processed_at" | "nlp_error" | "entities" | "relations" | "entity_summary" | "sentiment_valence" | "sentiment_arousal" | "sentiment_label" | "sentiment_confidence" | "cluster_id" | "landscape_x" | "landscape_y" | "landscape_z" | "thinking" | "thinking_enabled" | "thinking_tokens" | "source" | "agent_id"> & {
  created_at?: string; // Optional override for imports with original timestamps
  thinking?: string | null; // Optional thinking content for extended thinking mode
  thinking_enabled?: boolean; // Whether thinking mode was used (default: false)
  thinking_tokens?: number | null; // Estimated thinking tokens
  source?: "telegram" | "web" | "import" | null; // Message origin (default: telegram)
  agent_id?: string | null; // Agent that created this message (default: mya-personal)
};
// InsertDocument allows optional created_at/updated_at for preserving original timestamps (e.g., Obsidian imports)
export type InsertDocument = Omit<Document, "id" | "created_at" | "updated_at" | "agent_id"> & {
  created_at?: string; // Optional override - frontmatter created date
  updated_at?: string; // Optional override - frontmatter modified or file lastModified
  agent_id?: string | null; // Agent that created this document (default: mya-personal)
};
export type InsertTagVocabulary = Omit<TagVocabulary, "id" | "created_at">;
export type InsertSuggestedTag = Omit<SuggestedTag, "id" | "created_at">;
export type InsertShareLink = Omit<ShareLink, "id" | "created_at" | "view_count">;
export type InsertBatchJob = Omit<BatchJob, "id" | "created_at" | "processed_items" | "failed_items">;
