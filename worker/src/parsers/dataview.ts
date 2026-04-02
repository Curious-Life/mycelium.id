/**
 * Obsidian Dataview Fields Parser
 * Extracts inline metadata fields like author:: value
 */

export interface DataviewField {
  key: string;
  value: string;
  hidden: boolean;  // Parenthesized syntax like (key:: value)
  position: { start: number; end: number };
}

// Matches:
// field:: value (visible)
// [field:: value] (bracketed, visible)
// (field:: value) (hidden in reader mode)
const DATAVIEW_REGEX = /(?:^|\n)(\[)?(\()?([a-zA-Z_][a-zA-Z0-9_]*)::[ \t]*([^\n\])]*)(?:\])?(?:\))?/g;

/**
 * Extract all Dataview fields from content
 */
export function extractDataviewFields(content: string): DataviewField[] {
  const fields: DataviewField[] = [];
  let match;

  // Reset regex state
  DATAVIEW_REGEX.lastIndex = 0;

  while ((match = DATAVIEW_REGEX.exec(content)) !== null) {
    const isBracketed = match[1] === '[';
    const isParenthesized = match[2] === '(';
    const key = match[3];
    const value = match[4]?.trim() || '';

    fields.push({
      key: key.toLowerCase(),
      value,
      hidden: isParenthesized,
      position: {
        start: match.index,
        end: match.index + match[0].length
      }
    });
  }

  return fields;
}

/**
 * Extract fields as a simple key-value object
 */
export function extractDataviewFieldsAsObject(content: string): Record<string, string> {
  const fields = extractDataviewFields(content);
  const result: Record<string, string> = {};

  for (const field of fields) {
    result[field.key] = field.value;
  }

  return result;
}

/**
 * Parse a Dataview field value, attempting type coercion
 */
export function parseFieldValue(value: string): unknown {
  const trimmed = value.trim();

  // Boolean
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;

  // Date (ISO format)
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) return date.toISOString();
  }

  // Number
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // Array (comma-separated)
  if (trimmed.includes(',')) {
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Link [[target]]
  const linkMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
  if (linkMatch) {
    return { type: 'link', target: linkMatch[1] };
  }

  return trimmed;
}

/**
 * Remove Dataview fields from content
 * Useful for clean text extraction
 */
export function removeDataviewFields(content: string): string {
  return content.replace(DATAVIEW_REGEX, (match, bracket, paren) => {
    // Keep newline if match started with one
    return match.startsWith('\n') ? '\n' : '';
  });
}

/**
 * Common Dataview field mappings to standard metadata
 */
export const COMMON_FIELD_MAPPINGS: Record<string, string> = {
  'author': 'author',
  'authors': 'author',
  'created': 'created_at',
  'created_at': 'created_at',
  'date': 'created_at',
  'modified': 'updated_at',
  'updated': 'updated_at',
  'updated_at': 'updated_at',
  'status': 'status',
  'type': 'type',
  'category': 'category',
  'project': 'project',
  'due': 'due_date',
  'due_date': 'due_date',
  'priority': 'priority',
};
