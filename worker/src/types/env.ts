// Queue message type for async Telegram processing
export interface TelegramQueueMessage {
  update: TelegramUpdate;
  receivedAt: number;
}

// Telegram update structure (simplified for queue)
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
    voice?: {
      file_id: string;
      duration: number;
    };
    photo?: Array<{
      file_id: string;
      width: number;
      height: number;
    }>;
    video?: {
      file_id: string;
      duration: number;
    };
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
    };
  };
}

export interface Env {
  // Workers AI
  AI: Ai;

  // R2 Bucket
  BUCKET: R2Bucket;

  // Queue for async Telegram message processing
  TELEGRAM_QUEUE: Queue<TelegramQueueMessage>;

  // KV Namespace for deduplication and caching
  KV?: KVNamespace;

  // D1 Database (Supabase replacement)
  DB?: D1Database;

  // Vectorize indexes
  VECTORS_1024?: VectorizeIndex; // BGE-M3 1024D — semantic search
  VECTORS_256?: VectorizeIndex;  // Nomic 256D — clustering

  // Secrets (set via wrangler secret put)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_ID: string;
  CLAUDE_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ADMIN_SECRET: string; // For protected endpoints like webhook setup
  MYA_AGENT_URL?: string; // VPS agent-server URL for chat proxy
  MYA_WORKER_SECRET?: string; // Shared secret for agent server auth
  ATTACHMENT_SECRET?: string; // For signed attachment URLs
  MODAL_API_SECRET?: string; // For authenticated Modal endpoint calls
  OPENAI_API_KEY?: string; // For OpenAI TTS (tts-1-hd)

  // Cloudflare Stream (for iOS-compatible video transcoding)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_STREAM_TOKEN?: string;

  // Polymarket Intelligence API
  POLYMARKET_API_URL?: string;
  POLYMARKET_API_USER?: string;
  POLYMARKET_API_PASSWORD?: string;

  // Variables
  ENVIRONMENT: string;
  PORTAL_URL?: string; // Portal URL for links in Telegram commands
  OWNER_NAME?: string; // Owner's display name for prompts (default: "User")
  RESEND_API_KEY?: string; // Resend API key for email notifications
  NOTIFICATION_EMAIL?: string; // Email to receive signup notifications

  // Multi-Agent Configuration
  AGENT_ID?: string; // Agent identifier (mya-personal, mya-research, mya-builder, mya-company)
  MEMORY_SCOPE?: string; // Memory scope for this agent (personal, research, builder, company, all)
}
