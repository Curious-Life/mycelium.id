/**
 * Parser for MYA chat logs JSON format
 * Handles consciousness_acceleration_mvp/output/all_chats_combined.json
 */

export interface MyaLogMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;  // ISO 8601
  date: string;       // YYYY_MM_DD
  source_file: string;
  thinking?: string;  // Only on assistant messages
}

export interface MyaLogRoot {
  created_at: string;
  total_messages: number;
  total_days: number;
  date_range: {
    first: string;
    last: string;
  };
  dates_covered: string[];
  messages: MyaLogMessage[];
}

export interface ParsedMyaMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata: {
    source_file: string;
    original_date: string;
    thinking?: string;
    import_type: 'mya_logs';
  };
}

/**
 * Parse MYA chat logs JSON file
 */
export function parseMyaLogs(jsonContent: string): ParsedMyaMessage[] {
  const data: MyaLogRoot = JSON.parse(jsonContent);
  const messages: ParsedMyaMessage[] = [];

  for (const msg of data.messages) {
    // Convert timestamp string to Date
    const timestamp = new Date(msg.timestamp);

    // Build metadata
    const metadata: ParsedMyaMessage['metadata'] = {
      source_file: msg.source_file,
      original_date: msg.date,
      import_type: 'mya_logs'
    };

    // Include thinking if present (assistant messages only)
    if (msg.thinking) {
      metadata.thinking = msg.thinking;
    }

    messages.push({
      role: msg.role,
      content: msg.content,
      timestamp,
      metadata
    });
  }

  return messages;
}

/**
 * Analyze MYA logs without importing
 * Returns stats and preview for user confirmation
 */
export function analyzeMyaLogs(jsonContent: string) {
  const data: MyaLogRoot = JSON.parse(jsonContent);

  const userMessages = data.messages.filter(m => m.role === 'user');
  const assistantMessages = data.messages.filter(m => m.role === 'assistant');
  const messagesWithThinking = assistantMessages.filter(m => m.thinking);

  // Get date range
  const firstMessage = data.messages[0];
  const lastMessage = data.messages[data.messages.length - 1];

  // Calculate content stats
  const totalContentChars = data.messages.reduce((sum, m) => sum + m.content.length, 0);
  const totalThinkingChars = messagesWithThinking.reduce((sum, m) => sum + (m.thinking?.length || 0), 0);

  // Sample messages for preview
  const sampleMessages = data.messages.slice(0, 5);

  return {
    total_messages: data.total_messages,
    total_days: data.total_days,
    date_range: {
      first: firstMessage.timestamp,
      last: lastMessage.timestamp,
      formatted: `${data.date_range.first} to ${data.date_range.last}`
    },
    breakdown: {
      user_messages: userMessages.length,
      assistant_messages: assistantMessages.length,
      messages_with_thinking: messagesWithThinking.length
    },
    content_stats: {
      total_content_chars: totalContentChars,
      total_thinking_chars: totalThinkingChars,
      avg_content_length: Math.round(totalContentChars / data.total_messages),
      avg_thinking_length: messagesWithThinking.length > 0
        ? Math.round(totalThinkingChars / messagesWithThinking.length)
        : 0
    },
    dates_covered: data.dates_covered,
    sample_messages: sampleMessages.map(m => ({
      role: m.role,
      timestamp: m.timestamp,
      content_preview: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
      has_thinking: !!m.thinking,
      source_file: m.source_file
    }))
  };
}

/**
 * Generate unique hash for deduplication
 * Uses timestamp + content since there's no stable message ID
 */
export function generateMessageHash(msg: MyaLogMessage): string {
  const hashInput = `${msg.timestamp}:${msg.role}:${msg.content.substring(0, 100)}`;
  return hashInput; // Simple approach - in production you'd use a proper hash function
}
