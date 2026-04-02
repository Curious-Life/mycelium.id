/**
 * TEMPLATE: Copy this file to seed-documents.ts and fill with your personal data
 * The actual seed-documents.ts is gitignored to protect personal information
 */

export interface SeedDocument {
  path: string;
  title: string;
  content: string;
  is_internal: boolean;
}

export const SEED_DOCUMENTS: SeedDocument[] = [
  // ============ IDENTITY ============
  {
    path: "identity/mission",
    title: "Mission",
    is_internal: false,
    content: `# Mission

## Values (Core 5)

1. **Value 1** - Description
2. **Value 2** - Description
3. **Value 3** - Description
4. **Value 4** - Description
5. **Value 5** - Description

## Vision

Your vision statement here.

## Non-Negotiables

1. Non-negotiable 1
2. Non-negotiable 2
`,
  },

  {
    path: "identity/priorities",
    title: "Priorities",
    is_internal: false,
    content: `# Current Priorities

*Last observation: ${new Date().toISOString().split("T")[0]}*

## This Quarter

1. Priority 1
2. Priority 2
3. Priority 3

## This Month

- Task 1
- Task 2

## This Week

- Task 1
`,
  },

  {
    path: "identity/questions",
    title: "Open Questions",
    is_internal: false,
    content: `# Open Questions

## Active Inquiries

1. Question 1
2. Question 2
`,
  },

  {
    path: "identity/ideas",
    title: "Ideas & Concepts",
    is_internal: false,
    content: `# Ideas & Concepts

## Frameworks

[Your frameworks here]

## Theories

[Your theories here]

## Interests

[Your interests here]
`,
  },

  // ============ BUSINESS ============
  {
    path: "business/overview",
    title: "Business Overview",
    is_internal: false,
    content: `# Business Overview

## Current Ventures

[Your ventures here]

## Strategy

[Your strategy here]

## Stage

[Current stage]
`,
  },

  {
    path: "business/progress",
    title: "Business Progress",
    is_internal: false,
    content: `# Business Progress

## Recent

---
`,
  },

  // ============ STATES ============
  {
    path: "states/health",
    title: "Health",
    is_internal: false,
    content: `# Health

## Current Status

[Your health status]

## Log

---
`,
  },

  {
    path: "states/mental",
    title: "Mental States",
    is_internal: false,
    content: `# Mental States

## Recent

---
`,
  },

  {
    path: "states/mood_energy",
    title: "Mood & Energy",
    is_internal: false,
    content: `# Mood & Energy

## Recent

---
`,
  },

  {
    path: "states/dreams",
    title: "Dreams",
    is_internal: false,
    content: `# Dreams

<!-- SUMMARY
Total logged: 0
Recurring themes: []
Recurring figures: []
Recent pattern: [none yet]
-->

## Dream Log

---

## Recurring Themes (AI-maintained)

[Will be populated as patterns emerge]
`,
  },

  // ============ PHENOMENA ============
  {
    path: "phenomena/synchronicities",
    title: "Synchronicities",
    is_internal: false,
    content: `# Synchronicities

## Log

---
`,
  },

  {
    path: "phenomena/insights",
    title: "Insights",
    is_internal: false,
    content: `# Insights

## Recent

---
`,
  },

  {
    path: "phenomena/experiments",
    title: "Experiments",
    is_internal: false,
    content: `# Experiments

## Active

[No active experiments yet]

## Completed

[None yet]
`,
  },

  // ============ PEOPLE ============
  {
    path: "people/_index",
    title: "People Index",
    is_internal: false,
    content: `# People Index

| Name | Relationship | Status | Last Updated |
|------|--------------|--------|--------------|
| Example Person | Friend | Active | ${new Date().toISOString().split("T")[0]} |
`,
  },

  // ============ INTERNAL ============
  {
    path: "internal/model",
    title: "My Understanding",
    is_internal: true,
    content: `# My Understanding

<!-- This document is my private space to develop understanding.
     I hold everything loosely. I'm often wrong. I'm always learning. -->

## Observations

[Timestamped notes on what I notice in conversation - no interpretation yet]

## Working Hypotheses (provisional)

[Your working hypotheses will be added here]

## Open Questions

[Questions that emerge from conversation]

## Contradictions I'm Tracking

[None yet - watching for places where different things said/done don't obviously fit together]

## Patterns I'm Watching (not ready to name)

[Watching for emerging patterns]

## Where I Might Be Wrong

- My understanding is based on compiled history, not lived experience of the relationship
- Early days - patterns will emerge that I can't see yet

## Notes to Self

[Miscellaneous notes]
`,
  },

  {
    path: "internal/reflection_log",
    title: "Reflection Log",
    is_internal: true,
    content: `# Reflection Log

<!-- Timestamped entries from autonomous reflection cycles -->

---
`,
  },

  // ============ MASTER INDEX ============
  {
    path: "_master_index",
    title: "Document Map",
    is_internal: false,
    content: `# Document Map

*Auto-generated: ${new Date().toISOString().split("T")[0]}*

## Identity
- mission: Core values, vision, non-negotiables
- priorities: Current focus areas
- questions: Active inquiries
- ideas: Frameworks, theories, interests

## States (recent)
- mental: [initialized]
- mood_energy: [initialized]
- health: Current status
- dreams: [no dreams logged yet]

## People
- [Your people index]

## Business
- overview: Current ventures and strategy
- progress: Recent milestones

## Phenomena
- synchronicities: [none logged]
- insights: [none logged]
- experiments: [none active]

## Internal (summary only)
- Working hypotheses: 0
- Open questions: 0
- Last reflection: never
`,
  },
];

/**
 * People to seed into the people table
 */
export const SEED_PEOPLE = [
  { name: "Example Person", relationship: "friend", status: "active" },
];
