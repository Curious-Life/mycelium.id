// OpenAI conversation tree flattening
// OpenAI exports use a tree structure with parent/children references
// We flatten this to a linear array of messages for import

export interface OpenAIMessage {
  id: string;
  message: {
    author: { role: 'user' | 'assistant' | 'system' };
    content: { content_type: string; parts: string[] };
    create_time: number;
  } | null;
  parent: string | null;
  children: string[];
}

export interface OpenAIConversation {
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, OpenAIMessage>;
}

export interface FlattenedMessage {
  uuid: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/**
 * Flatten OpenAI conversation tree to linear messages
 * @param conv - The conversation to flatten
 * @param includeAllBranches - If true, includes all regenerations/edits.
 *                             If false (default), follows canonical path (last child only)
 */
export function flattenOpenAIConversation(
  conv: OpenAIConversation,
  includeAllBranches = false
): FlattenedMessage[] {
  const messages: FlattenedMessage[] = [];
  const mapping = conv.mapping;

  // Find root node (parent === null)
  const rootId = Object.keys(mapping).find(id => mapping[id].parent === null);
  if (!rootId) return messages;

  function visit(nodeId: string) {
    const node = mapping[nodeId];
    if (!node) return;

    // Skip system messages and null messages
    if (node.message && node.message.author.role !== 'system') {
      const content = node.message.content.parts?.join('\n') || '';
      if (content.trim()) {
        messages.push({
          uuid: node.id,
          role: node.message.author.role as 'user' | 'assistant',
          content,
          created_at: new Date(node.message.create_time * 1000).toISOString()
        });
      }
    }

    if (includeAllBranches) {
      // Visit ALL children (includes regenerations/edits - may have duplicates)
      for (const childId of node.children) {
        visit(childId);
      }
    } else {
      // Canonical path: follow only last child (most recent generation)
      if (node.children.length > 0) {
        visit(node.children[node.children.length - 1]);
      }
    }
  }

  visit(rootId);
  return messages;
}

/**
 * Detect if data is OpenAI format vs Claude format
 */
export function isOpenAIFormat(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  
  // OpenAI has 'mapping' field with tree structure
  if ('mapping' in data && typeof (data as Record<string, unknown>).mapping === 'object') {
    return true;
  }
  
  return false;
}
