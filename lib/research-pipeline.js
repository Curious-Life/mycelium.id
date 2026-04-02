/**
 * Research Pipeline — Multi-step deep research orchestrator
 *
 * Three-phase execution:
 *   1. PLAN      — Decompose query into focused sub-questions (sonnet, fast)
 *   2. SEARCH    — Parallel web searches per sub-question (sonnet, web search)
 *   3. SYNTHESIZE — Combine all findings into structured report (opus, thorough)
 *
 * Each phase is a separate Claude Code invocation via lib/runner.js.
 * Used by the research agent (Ada) for deep research requests.
 *
 * Usage:
 *   import { runResearchPipeline } from './research-pipeline.js';
 *   const { result, phases } = await runResearchPipeline(query, { cwd, agentRoot });
 */

import { runClaudeCode } from './runner.js';

const MAX_PARALLEL_SEARCHES = 3;

/**
 * Run a three-phase research pipeline.
 *
 * @param {string} query - The research question/prompt
 * @param {Object} options
 * @param {string} options.cwd - Working directory for Claude Code
 * @param {string} options.planModel - Model for plan phase (default: 'sonnet')
 * @param {string} options.searchModel - Model for search phase (default: 'sonnet')
 * @param {string} options.synthesisModel - Model for synthesis phase (default: 'opus')
 * @param {Function} [options.onPhase] - (phase, detail) => void
 * @param {Function} [options.onActivity] - Activity callback from runner
 * @returns {Promise<{ result: string, phases: Object }>}
 */
export async function runResearchPipeline(query, options = {}) {
  const {
    cwd,
    planModel = 'sonnet',
    searchModel = 'sonnet',
    synthesisModel = 'opus',
    onPhase,
    onActivity,
  } = options;

  const phases = { plan: null, search: null, synthesis: null };

  // ── Phase 1: PLAN ──────────────────────────────────────────────

  onPhase?.('plan', 'Decomposing query into sub-questions...');

  const planPrompt = `You are a research planner. Decompose the following research question into 3-5 focused sub-questions that, when answered, will give a comprehensive response.

Research question: ${query}

Return ONLY a JSON array of strings, each a focused sub-question. No other text.
Example: ["What is X?", "How does X relate to Y?", "What are the latest developments in X?"]`;

  const planResult = await runClaudeCode(planPrompt, {
    model: planModel,
    maxTurns: 5,
    cwd,
    onActivity,
  });

  let subQuestions;
  try {
    const match = planResult.result.match(/\[[\s\S]*\]/);
    subQuestions = match ? JSON.parse(match[0]) : [query];
  } catch {
    subQuestions = [query]; // Fallback: use original query as single sub-question
  }

  phases.plan = { subQuestions, model: planModel };
  onPhase?.('plan_complete', `${subQuestions.length} sub-questions identified`);

  // ── Phase 2: SEARCH ────────────────────────────────────────────

  onPhase?.('search', `Searching ${subQuestions.length} sub-questions (max ${MAX_PARALLEL_SEARCHES} parallel)...`);

  const searchResults = [];

  // Process in chunks to limit concurrency
  for (let i = 0; i < subQuestions.length; i += MAX_PARALLEL_SEARCHES) {
    const chunk = subQuestions.slice(i, i + MAX_PARALLEL_SEARCHES);
    const chunkResults = await Promise.all(
      chunk.map(async (question, idx) => {
        const searchPrompt = `Research this specific question using web search. Be thorough — search multiple sources, cross-reference, and include specific data points, dates, and citations.

Question: ${question}

Provide a detailed research summary with sources. Focus on facts, data, and recent information.`;

        try {
          onPhase?.('search_sub', `[${i + idx + 1}/${subQuestions.length}] ${question.slice(0, 60)}...`);
          const result = await runClaudeCode(searchPrompt, {
            model: searchModel,
            maxTurns: 10,
            cwd,
            onActivity,
          });
          return { question, result: result.result, success: true };
        } catch (err) {
          return { question, result: `Search failed: ${err.message}`, success: false };
        }
      }),
    );
    searchResults.push(...chunkResults);
  }

  phases.search = {
    results: searchResults.map(r => ({
      question: r.question,
      success: r.success,
      resultLength: r.result?.length || 0,
    })),
    model: searchModel,
  };

  const successCount = searchResults.filter(r => r.success).length;
  onPhase?.('search_complete', `${successCount}/${subQuestions.length} searches completed`);

  // ── Phase 3: SYNTHESIZE ────────────────────────────────────────

  onPhase?.('synthesis', 'Synthesizing findings into structured report...');

  const findingsText = searchResults
    .map((r, i) => `## Sub-question ${i + 1}: ${r.question}\n\n${r.result}`)
    .join('\n\n---\n\n');

  const synthesisPrompt = `You are a research synthesizer. Below are research findings from ${searchResults.length} parallel investigations. Combine them into a single, well-structured, comprehensive report.

Original research question: ${query}

## Research Findings

${findingsText}

## Instructions
- Synthesize all findings into a coherent report
- Resolve contradictions between sources
- Highlight key insights and patterns
- Include specific data points and citations
- Note any gaps or areas needing further investigation
- Use clear section headings
- Keep the report focused and actionable`;

  const synthesisResult = await runClaudeCode(synthesisPrompt, {
    model: synthesisModel,
    maxTurns: 15,
    cwd,
    onActivity,
  });

  phases.synthesis = { model: synthesisModel, resultLength: synthesisResult.result?.length || 0 };
  onPhase?.('complete', 'Research pipeline complete');

  return {
    result: synthesisResult.result,
    phases,
  };
}
