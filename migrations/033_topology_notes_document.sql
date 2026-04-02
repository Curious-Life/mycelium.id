-- Migration: Create internal/topology_notes document for existing users
-- This document stores Mya's observations about mindscape topology:
-- - Active hypotheses about graph structure
-- - Structural observations (clusters, bridges, orphans)
-- - Exploration queue for follow-up investigation

-- Insert topology_notes document for all existing users who don't have one
INSERT INTO documents (user_id, path, title, content, summary, is_internal, metadata, created_at, updated_at)
SELECT
  u.id,
  'internal/topology_notes',
  'Topology Notes',
  '# Topology Notes

*My observations about the structure of this mindscape - what connects, what''s isolated, and what that might mean.*

---

## Active Hypotheses

*Working theories about how this mind is organized. Each hypothesis should be falsifiable.*

<!-- Example format:
### H-001: [Hypothesis Name]
- **Observed:** [what prompted this]
- **Hypothesis:** [my theory]
- **Falsifiable by:** [what would disprove it]
- **Status:** Active | Confirmed | Revised | Abandoned
- **Confidence:** 0.6
-->

---

## Structural Observations

*What I notice about clusters, bridges, and patterns in the co-firing graph.*

### Clusters

*Groups of territories that fire together regularly.*

### Bridges

*Territories that connect different realms - structural nodes worth understanding.*

### Orphans

*Isolated territories with substantial content. Why are they separate?*

### Flow Patterns

*How topics tend to connect over time.*

---

## Unexplored Gaps

*Territories with high semantic similarity but low co-firing - potential connections worth exploring.*

---

## Exploration Queue

*Things I want to investigate next time I have exploration budget.*

1.

---

## Session Log

*Recent exploration sessions and what I learned.*

',
  'Mya''s observations about mindscape topology and graph structure',
  true,
  '{}',
  now(),
  now()
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM documents d
  WHERE d.user_id = u.id
  AND d.path = 'internal/topology_notes'
);
