/**
 * PR Review Handler
 *
 * Handles PR proposals from self-modifying agents.
 * Triggers QA agent review and manages the merge workflow.
 */

import myaRouter from './mya-router.js';

// Review decision types
const DECISIONS = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'request_changes',
  REJECT: 'reject',
  ESCALATE: 'escalate'
};

// Risk levels that always require human review
const HUMAN_REQUIRED_PATTERNS = [
  /prompt/i,
  /auth/i,
  /security/i,
  /credential/i,
  /secret/i,
  /password/i,
  /token/i,
  /schema/i,
  /migration/i
];

/**
 * Check if a PR requires human review based on files changed
 */
function requiresHumanReview(proposal) {
  if (proposal.risk_level === 'high') return true;
  if (proposal.requires_human_review) return true;

  // Check file paths for sensitive patterns
  for (const change of proposal.changes) {
    for (const pattern of HUMAN_REQUIRED_PATTERNS) {
      if (pattern.test(change.file_path)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Process a PR proposal through QA review
 */
export async function processPRProposal(proposal, kvStore) {
  console.log(`[PR Review] Processing proposal ${proposal.id}: ${proposal.title}`);

  // Check if human review is required
  const needsHuman = requiresHumanReview(proposal);

  if (needsHuman) {
    console.log(`[PR Review] Escalating to human: ${proposal.id}`);
    await kvStore.put(
      `pr_proposal:${proposal.id}`,
      JSON.stringify({
        ...proposal,
        status: 'awaiting_human_review',
        escalated_at: new Date().toISOString(),
        escalation_reason: 'High risk or sensitive files'
      })
    );
    return {
      decision: DECISIONS.ESCALATE,
      reason: 'This change requires human review due to risk level or sensitive files.'
    };
  }

  // Send to QA agent for review
  try {
    const qaConfig = myaRouter.getAgentConfig('mya-qa');
    if (!qaConfig) {
      throw new Error('QA agent not configured');
    }

    const reviewRequest = {
      type: 'pr_review',
      proposal,
      review_criteria: {
        check_security: true,
        check_quality: true,
        check_tests: true,
        check_docs: true
      }
    };

    const result = await myaRouter.forwardToAgent('mya-qa', JSON.stringify(reviewRequest), {
      task_type: 'code_review',
      pr_id: proposal.id
    });

    // Parse QA agent response
    const review = parseQAResponse(result);

    // Update proposal with review
    await kvStore.put(
      `pr_proposal:${proposal.id}`,
      JSON.stringify({
        ...proposal,
        status: review.decision === DECISIONS.APPROVE ? 'approved' : review.decision,
        review,
        reviewed_at: new Date().toISOString()
      })
    );

    // If approved and no human review required, trigger auto-merge
    if (review.decision === DECISIONS.APPROVE && !needsHuman) {
      await triggerAutoMerge(proposal, kvStore);
    }

    return review;
  } catch (error) {
    console.error(`[PR Review] Error reviewing ${proposal.id}:`, error);
    return {
      decision: DECISIONS.ESCALATE,
      reason: `Review failed: ${error.message}`,
      error: true
    };
  }
}

/**
 * Parse QA agent response into structured review
 */
function parseQAResponse(response) {
  // Default to escalate if we can't parse
  let review = {
    decision: DECISIONS.ESCALATE,
    security_issues: [],
    quality_issues: [],
    missing_tests: [],
    missing_docs: [],
    suggestions: [],
    auto_fixes_applied: [],
    raw_response: response
  };

  try {
    // Try to extract structured data from response
    const content = typeof response === 'string' ? response : response.content || '';

    // Extract decision
    const decisionMatch = content.match(/\*\*Decision\*\*:\s*(APPROVE|REQUEST_CHANGES|REJECT|ESCALATE)/i);
    if (decisionMatch) {
      review.decision = decisionMatch[1].toLowerCase();
    }

    // Extract security issues
    const securityMatch = content.match(/## Security Analysis\n([\s\S]*?)(?=\n##|$)/);
    if (securityMatch && !securityMatch[1].includes('No security issues')) {
      review.security_issues = extractBulletPoints(securityMatch[1]);
    }

    // Extract quality issues
    const qualityMatch = content.match(/## Quality Issues\n([\s\S]*?)(?=\n##|$)/);
    if (qualityMatch && !qualityMatch[1].includes('No quality issues')) {
      review.quality_issues = extractBulletPoints(qualityMatch[1]);
    }

    // Extract missing tests
    const testsMatch = content.match(/## Missing Tests\n([\s\S]*?)(?=\n##|$)/);
    if (testsMatch && !testsMatch[1].includes('adequate')) {
      review.missing_tests = extractBulletPoints(testsMatch[1]);
    }

    // If there are security issues, never auto-approve
    if (review.security_issues.length > 0 && review.decision === DECISIONS.APPROVE) {
      review.decision = DECISIONS.REQUEST_CHANGES;
    }

  } catch (error) {
    console.error('[PR Review] Error parsing QA response:', error);
  }

  return review;
}

/**
 * Extract bullet points from text
 */
function extractBulletPoints(text) {
  const lines = text.split('\n');
  return lines
    .filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'))
    .map(line => line.replace(/^[\s\-\*]+/, '').trim())
    .filter(Boolean);
}

/**
 * Trigger auto-merge for approved PR
 */
async function triggerAutoMerge(proposal, kvStore) {
  console.log(`[PR Review] Auto-merging approved PR: ${proposal.id}`);

  // Add to merge queue
  const mergeQueue = await kvStore.get('pr_merge_queue');
  const queue = mergeQueue ? JSON.parse(mergeQueue) : [];
  queue.push({
    pr_id: proposal.id,
    agent_id: proposal.agent_id,
    queued_at: new Date().toISOString()
  });
  await kvStore.put('pr_merge_queue', JSON.stringify(queue));

  return true;
}

/**
 * Process the merge queue - apply approved changes
 */
export async function processMergeQueue(kvStore, repoManager) {
  const mergeQueue = await kvStore.get('pr_merge_queue');
  if (!mergeQueue) return [];

  const queue = JSON.parse(mergeQueue);
  const processed = [];

  for (const item of queue) {
    try {
      const proposalData = await kvStore.get(`pr_proposal:${item.pr_id}`);
      if (!proposalData) continue;

      const proposal = JSON.parse(proposalData);
      if (proposal.status !== 'approved') continue;

      // Apply changes to the agent's repo
      // This would use git operations in a real implementation
      console.log(`[PR Review] Applying changes for ${item.pr_id}`);

      // Update proposal status
      await kvStore.put(
        `pr_proposal:${item.pr_id}`,
        JSON.stringify({
          ...proposal,
          status: 'merged',
          merged_at: new Date().toISOString()
        })
      );

      processed.push(item.pr_id);
    } catch (error) {
      console.error(`[PR Review] Error processing merge for ${item.pr_id}:`, error);
    }
  }

  // Remove processed items from queue
  const remaining = queue.filter(item => !processed.includes(item.pr_id));
  await kvStore.put('pr_merge_queue', JSON.stringify(remaining));

  return processed;
}

/**
 * Get pending PR proposals for review
 */
export async function getPendingProposals(kvStore) {
  const pending = await kvStore.get('pr_proposals:pending');
  if (!pending) return [];

  const proposalIds = JSON.parse(pending);
  const proposals = [];

  for (const id of proposalIds) {
    const data = await kvStore.get(`pr_proposal:${id}`);
    if (data) {
      proposals.push(JSON.parse(data));
    }
  }

  return proposals.filter(p => p.status === 'pending');
}

/**
 * Get proposals awaiting human review
 */
export async function getHumanReviewQueue(kvStore) {
  const pending = await kvStore.get('pr_proposals:pending');
  if (!pending) return [];

  const proposalIds = JSON.parse(pending);
  const proposals = [];

  for (const id of proposalIds) {
    const data = await kvStore.get(`pr_proposal:${id}`);
    if (data) {
      const proposal = JSON.parse(data);
      if (proposal.status === 'awaiting_human_review') {
        proposals.push(proposal);
      }
    }
  }

  return proposals;
}

/**
 * Human approves/rejects a PR
 */
export async function humanReview(prId, decision, comment, kvStore) {
  const data = await kvStore.get(`pr_proposal:${prId}`);
  if (!data) throw new Error('PR not found');

  const proposal = JSON.parse(data);

  if (decision === 'approve') {
    await kvStore.put(
      `pr_proposal:${prId}`,
      JSON.stringify({
        ...proposal,
        status: 'approved',
        human_review: {
          decision: 'approved',
          comment,
          reviewed_at: new Date().toISOString()
        }
      })
    );
    await triggerAutoMerge(proposal, kvStore);
    return { success: true, status: 'approved' };
  } else {
    await kvStore.put(
      `pr_proposal:${prId}`,
      JSON.stringify({
        ...proposal,
        status: 'rejected',
        human_review: {
          decision: 'rejected',
          comment,
          reviewed_at: new Date().toISOString()
        }
      })
    );
    return { success: true, status: 'rejected' };
  }
}

export default {
  processPRProposal,
  processMergeQueue,
  getPendingProposals,
  getHumanReviewQueue,
  humanReview,
  DECISIONS
};
