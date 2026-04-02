/**
 * Document and message relevance scoring
 * Combines multiple signals beyond just embedding similarity
 */

export interface RelevanceFactors {
  semanticSimilarity: number; // 0-1, from embedding cosine similarity
  recency: number; // 0-1, how recent the content is
  tagOverlap: number; // 0-1, overlap with current message tags
  mentionMatch: number; // 0-1, if people/projects mentioned match
}

export interface ScoredItem<T> {
  item: T;
  score: number;
  factors: RelevanceFactors;
}

// Weights for combining factors
const WEIGHTS = {
  semanticSimilarity: 0.5,
  recency: 0.2,
  tagOverlap: 0.2,
  mentionMatch: 0.1,
};

/**
 * Calculate recency score (exponential decay)
 * Full score for today, decays over time
 */
export function calculateRecencyScore(
  createdAt: Date | string,
  halfLifeDays: number = 7
): number {
  const created = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const now = new Date();
  const daysDiff = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay with configurable half-life
  return Math.exp((-Math.LN2 * daysDiff) / halfLifeDays);
}

/**
 * Calculate tag overlap score
 */
export function calculateTagOverlap(
  itemTags: string[],
  currentTags: string[]
): number {
  if (currentTags.length === 0 || itemTags.length === 0) {
    return 0;
  }

  const intersection = itemTags.filter((t) => currentTags.includes(t));
  const union = new Set([...itemTags, ...currentTags]);

  // Jaccard similarity
  return intersection.length / union.size;
}

/**
 * Calculate mention match score
 */
export function calculateMentionMatch(
  itemPeople: string[],
  itemProjects: string[],
  currentPeople: string[],
  currentProjects: string[]
): number {
  const allItemMentions = [...itemPeople, ...itemProjects];
  const allCurrentMentions = [...currentPeople, ...currentProjects];

  if (allCurrentMentions.length === 0 || allItemMentions.length === 0) {
    return 0;
  }

  const matches = allItemMentions.filter((m) =>
    allCurrentMentions.some((c) => c.toLowerCase() === m.toLowerCase())
  );

  return matches.length / allCurrentMentions.length;
}

/**
 * Calculate combined relevance score
 */
export function calculateRelevanceScore(factors: RelevanceFactors): number {
  return (
    factors.semanticSimilarity * WEIGHTS.semanticSimilarity +
    factors.recency * WEIGHTS.recency +
    factors.tagOverlap * WEIGHTS.tagOverlap +
    factors.mentionMatch * WEIGHTS.mentionMatch
  );
}

/**
 * Score and rank items by relevance
 */
export function rankByRelevance<T>(
  items: T[],
  getFactors: (item: T) => RelevanceFactors
): ScoredItem<T>[] {
  return items
    .map((item) => {
      const factors = getFactors(item);
      return {
        item,
        score: calculateRelevanceScore(factors),
        factors,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Filter items above a relevance threshold
 */
export function filterByRelevance<T>(
  items: ScoredItem<T>[],
  minScore: number = 0.3
): ScoredItem<T>[] {
  return items.filter((item) => item.score >= minScore);
}

/**
 * Boost score for specific conditions
 */
export function applyBoosts(
  baseScore: number,
  boosts: { condition: boolean; multiplier: number }[]
): number {
  let score = baseScore;
  for (const boost of boosts) {
    if (boost.condition) {
      score *= boost.multiplier;
    }
  }
  return Math.min(score, 1); // Cap at 1
}
