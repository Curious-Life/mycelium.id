/**
 * Obsidian Inline Tags Parser
 * Extracts #tags from markdown content
 */

// Matches #tag, #nested/tag, #tag-with-dashes
// Must start with # followed by letter, can contain letters, numbers, underscores, dashes, and /
const TAG_REGEX = /(?<=^|\s)#([a-zA-Z][a-zA-Z0-9_\-/]*)/g;

// Code block patterns to exclude
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;

/**
 * Extract all inline tags from content
 * Skips tags inside code blocks
 */
export function extractInlineTags(content: string): string[] {
  // Remove code blocks to avoid matching inside them
  const withoutCode = content
    .replace(CODE_BLOCK_REGEX, '')
    .replace(INLINE_CODE_REGEX, '');

  const tags = new Set<string>();
  let match;

  // Reset regex state
  TAG_REGEX.lastIndex = 0;

  while ((match = TAG_REGEX.exec(withoutCode)) !== null) {
    // Normalize tag to lowercase
    tags.add(match[1].toLowerCase());
  }

  return Array.from(tags);
}

/**
 * Merge frontmatter tags with inline tags, deduplicating
 */
export function mergeTags(frontmatterTags: string[], inlineTags: string[]): string[] {
  const all = new Set<string>();

  for (const tag of frontmatterTags) {
    all.add(tag.toLowerCase());
  }

  for (const tag of inlineTags) {
    all.add(tag.toLowerCase());
  }

  return Array.from(all).sort();
}

/**
 * Check if a tag matches a pattern (supports wildcards)
 * Pattern: "project/*" matches "project/mya", "project/other"
 */
export function tagMatchesPattern(tag: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return tag.startsWith(prefix + '/') || tag === prefix;
  }
  return tag === pattern;
}

/**
 * Get parent tags from nested tags
 * "project/mya/sprint1" => ["project", "project/mya"]
 */
export function getParentTags(tag: string): string[] {
  const parts = tag.split('/');
  const parents: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    parents.push(parts.slice(0, i).join('/'));
  }

  return parents;
}
