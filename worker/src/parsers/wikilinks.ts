/**
 * Obsidian Wiki Links Parser
 * Extracts [[wiki links]] and ![[embeds]] from markdown
 */

export interface WikiLink {
  raw: string;
  target: string;
  anchor?: string;         // #heading or #^block-id
  displayText?: string;    // [[target|this part]]
  isEmbed: boolean;        // ![[embed]]
  position: { start: number; end: number };
}

// Matches: [[target]], [[target|alias]], [[target#heading]], ![[embed]]
const WIKI_LINK_REGEX = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Extract all wiki links from content
 */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match;

  // Reset regex state
  WIKI_LINK_REGEX.lastIndex = 0;

  while ((match = WIKI_LINK_REGEX.exec(content)) !== null) {
    links.push({
      raw: match[0],
      isEmbed: match[1] === '!',
      target: match[2].trim(),
      anchor: match[3]?.trim(),
      displayText: match[4]?.trim(),
      position: {
        start: match.index,
        end: match.index + match[0].length
      }
    });
  }

  return links;
}

/**
 * Get unique link targets (for resolution)
 */
export function getUniqueLinkTargets(links: WikiLink[]): string[] {
  const targets = new Set<string>();
  for (const link of links) {
    targets.add(link.target);
  }
  return Array.from(targets);
}

/**
 * Resolve a wiki link target to a document path
 * Obsidian uses "shortest path" matching by default
 */
export function resolveWikiLink(
  target: string,
  documentPaths: string[]
): string | null {
  // Normalize target (remove .md if present)
  const normalizedTarget = target.replace(/\.md$/, '');

  // Try exact match first
  for (const path of documentPaths) {
    const normalizedPath = path.replace(/\.md$/, '');
    if (normalizedPath === normalizedTarget) {
      return path;
    }
  }

  // Try filename match (Obsidian default behavior)
  for (const path of documentPaths) {
    const filename = path.split('/').pop()?.replace(/\.md$/, '') || '';
    if (filename === normalizedTarget) {
      return path;
    }
  }

  // Try case-insensitive filename match
  const lowerTarget = normalizedTarget.toLowerCase();
  for (const path of documentPaths) {
    const filename = path.split('/').pop()?.replace(/\.md$/, '')?.toLowerCase() || '';
    if (filename === lowerTarget) {
      return path;
    }
  }

  return null;
}

/**
 * Convert wiki links to standard markdown links
 * Useful for rendering or export
 */
export function wikiLinksToMarkdown(
  content: string,
  pathResolver?: (target: string) => string | null
): string {
  return content.replace(WIKI_LINK_REGEX, (match, embed, target, anchor, display) => {
    const resolvedPath = pathResolver ? pathResolver(target) : target;
    const linkText = display || target;
    const href = resolvedPath || target;
    const anchorSuffix = anchor ? `#${anchor}` : '';

    if (embed === '!') {
      // Embed - convert to image or embed syntax
      return `![${linkText}](${href}${anchorSuffix})`;
    }

    return `[${linkText}](${href}${anchorSuffix})`;
  });
}
