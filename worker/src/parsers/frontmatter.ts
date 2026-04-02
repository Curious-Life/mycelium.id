/**
 * Obsidian Frontmatter Parser
 * Extracts YAML frontmatter from markdown files
 */

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  content: string;
  tags: string[];
  aliases: string[];
  created?: string;
  modified?: string;
}

/**
 * Parse a YAML value, handling common types
 */
function parseYamlValue(value: string): unknown {
  const trimmed = value.trim();

  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null
  if (trimmed === 'null' || trimmed === '~') return null;

  // Number
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // Array (simple inline format: [a, b, c])
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(',').map(s => parseYamlValue(s.trim()));
  }

  // String (remove quotes if present)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/**
 * Simple YAML parser for frontmatter
 * Handles common Obsidian patterns without full YAML spec compliance
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Array item (continuation of previous key)
    if (line.match(/^\s*-\s+/) && currentKey && currentArray !== null) {
      const value = line.replace(/^\s*-\s+/, '').trim();
      currentArray.push(parseYamlValue(value));
      continue;
    }

    // Key-value pair
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)?$/);
    if (match) {
      // Save previous array if exists
      if (currentKey && currentArray !== null) {
        result[currentKey] = currentArray;
      }

      currentKey = match[1];
      const value = match[2]?.trim() || '';

      // Check if this starts an array (empty value followed by - items)
      if (!value) {
        currentArray = [];
        continue;
      }

      currentArray = null;
      result[currentKey] = parseYamlValue(value);
    }
  }

  // Save final array if exists
  if (currentKey && currentArray !== null) {
    result[currentKey] = currentArray;
  }

  return result;
}

/**
 * Normalize a value to an array of strings
 */
function normalizeArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    // Handle comma-separated strings
    if (value.includes(',')) {
      return value.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [value.trim()].filter(Boolean);
  }
  return [];
}

/**
 * Parse frontmatter from markdown content
 */
export function parseFrontmatter(raw: string): ParsedNote {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!match) {
    return {
      frontmatter: {},
      content: raw,
      tags: [],
      aliases: [],
    };
  }

  const yamlContent = match[1];
  const content = match[2];

  let yaml: Record<string, unknown>;
  try {
    yaml = parseSimpleYaml(yamlContent);
  } catch {
    // If parsing fails, return empty frontmatter
    yaml = {};
  }

  // Extract common fields
  const tags = normalizeArray(yaml.tags || yaml.tag);
  const aliases = normalizeArray(yaml.aliases || yaml.alias);
  const created = yaml.created || yaml.date || yaml.created_at;
  const modified = yaml.modified || yaml.updated || yaml.updated_at;

  // Remove processed fields to get remaining metadata
  const processedKeys = ['tags', 'tag', 'aliases', 'alias', 'created', 'date',
    'created_at', 'modified', 'updated', 'updated_at', 'cssclass', 'cssclasses',
    'publish'];

  const frontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(yaml)) {
    if (!processedKeys.includes(key)) {
      frontmatter[key] = value;
    }
  }

  return {
    frontmatter,
    content,
    tags,
    aliases,
    created: created ? String(created) : undefined,
    modified: modified ? String(modified) : undefined,
  };
}

/**
 * Extract title from content (first H1 or first non-empty line)
 */
export function extractTitle(content: string, filename: string): string {
  // Try to find first H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Use filename without extension
  return filename.replace(/\.md$/, '');
}
