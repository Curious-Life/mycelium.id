/**
 * Document templates for initial creation
 * These define the structure of each living document type
 */

export interface DocumentTemplate {
  path: string;
  title: string;
  content: string;
  isInternal: boolean;
}

// ============ IDENTITY DOCUMENTS ============

export const MISSION_TEMPLATE: DocumentTemplate = {
  path: "identity/mission",
  title: "Mission",
  isInternal: false,
  content: `# Mission

## Values
[Core values, what matters most]

## Vision
[Long-term direction, what you're building toward]

## Psychology
[How you think, what motivates you, your patterns - as you understand them]

## Non-Negotiables
[Lines that don't move]
`,
};

export const PRIORITIES_TEMPLATE: DocumentTemplate = {
  path: "identity/priorities",
  title: "Priorities",
  isInternal: false,
  content: `# Current Priorities

*Last observation: [date]*

## This Quarter
[Major focus areas]

## This Month
[Current emphasis]

## This Week
[Immediate focus]

## Parking Lot
[Important but not now]
`,
};

export const QUESTIONS_TEMPLATE: DocumentTemplate = {
  path: "identity/questions",
  title: "Open Questions",
  isInternal: false,
  content: `# Open Questions

## Active Inquiries
[Questions you're sitting with]

## Research Threads
[Things you're investigating]

## Unresolved
[Questions that have been open a long time]
`,
};

export const IDEAS_TEMPLATE: DocumentTemplate = {
  path: "identity/ideas",
  title: "Ideas & Concepts",
  isInternal: false,
  content: `# Ideas & Concepts

## Frameworks
[Mental models you use or are developing]

## Theories
[Things you believe might be true]

## Interests
[What you're drawn to explore]
`,
};

// ============ STATE DOCUMENTS ============

export const MENTAL_STATE_TEMPLATE: DocumentTemplate = {
  path: "states/mental",
  title: "Mental States",
  isInternal: false,
  content: `# Mental States

<!-- Cognitive patterns, clarity, focus, modes of thinking -->

## Recent

---
`,
};

export const MOOD_ENERGY_TEMPLATE: DocumentTemplate = {
  path: "states/mood_energy",
  title: "Mood & Energy",
  isInternal: false,
  content: `# Mood & Energy

<!-- Emotional texture, mana levels, felt sense -->

## Recent

---
`,
};

export const HEALTH_TEMPLATE: DocumentTemplate = {
  path: "states/health",
  title: "Health",
  isInternal: false,
  content: `# Health

<!-- Body, substances, sleep, symptoms, physical states -->

## Current Status
- Substances: [tracking what's in/out]
- Sleep: [patterns]
- Exercise: [if tracked]
- Notable: [any symptoms, conditions]

## Log

---
`,
};

export const DREAMS_TEMPLATE: DocumentTemplate = {
  path: "states/dreams",
  title: "Dreams",
  isInternal: false,
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
};

// ============ BUSINESS DOCUMENTS ============

export const BUSINESS_OVERVIEW_TEMPLATE: DocumentTemplate = {
  path: "business/overview",
  title: "Business Overview",
  isInternal: false,
  content: `# Business Overview

## Current Ventures
[What's active]

## Strategy
[Current approach]

## Stage
[Where things are]
`,
};

export const BUSINESS_PROGRESS_TEMPLATE: DocumentTemplate = {
  path: "business/progress",
  title: "Business Progress",
  isInternal: false,
  content: `# Business Progress

<!-- Timeline of developments, decisions, shifts -->

## Recent

---
`,
};

// ============ PHENOMENA DOCUMENTS ============

export const SYNCHRONICITIES_TEMPLATE: DocumentTemplate = {
  path: "phenomena/synchronicities",
  title: "Synchronicities",
  isInternal: false,
  content: `# Synchronicities

<!-- Meaningful coincidences, timestamped -->

## Log

---
`,
};

export const INSIGHTS_TEMPLATE: DocumentTemplate = {
  path: "phenomena/insights",
  title: "Insights",
  isInternal: false,
  content: `# Insights

<!-- Realizations, downloads, shifts -->

## Recent

---
`,
};

export const EXPERIMENTS_TEMPLATE: DocumentTemplate = {
  path: "phenomena/experiments",
  title: "Experiments",
  isInternal: false,
  content: `# Experiments

## Active

[No active experiments yet]

## Completed

[None yet]
`,
};

// ============ PEOPLE DOCUMENTS ============

export const PEOPLE_INDEX_TEMPLATE: DocumentTemplate = {
  path: "people/_index",
  title: "People Index",
  isInternal: false,
  content: `# People Index

| Name | Relationship | Status | Last Updated |
|------|--------------|--------|--------------|
`,
};

// ============ INTERNAL (AI-PRIVATE) DOCUMENTS ============

export const MODEL_OF_USER_TEMPLATE: DocumentTemplate = {
  path: "internal/model",
  title: "My Understanding",
  isInternal: true,
  content: `# My Understanding

<!-- This document is my private space to develop understanding.
     I hold everything loosely. I'm often wrong. I'm always learning. -->

## Working Hypotheses (provisional)

[Things I currently believe might be true, held loosely]

## Open Questions

[Things I'm genuinely uncertain about, trying to understand]

## Contradictions I'm Tracking

[Places where different things said/done don't obviously fit together]
[Not problems to solve - just things I'm watching]

## Patterns I'm Watching (not ready to name)

[Emerging patterns I've noticed but don't want to crystallize yet]

## Where I Might Be Wrong

[Explicit acknowledgment of my own uncertainty and potential errors]

## Notes to Self

[Anything else - my own reactions, confusions, wonderings]
`,
};

export const REFLECTION_LOG_TEMPLATE: DocumentTemplate = {
  path: "internal/reflection_log",
  title: "Reflection Log",
  isInternal: true,
  content: `# Reflection Log

<!-- Timestamped entries from autonomous reflection cycles -->

---
`,
};

export const TOPOLOGY_NOTES_TEMPLATE: DocumentTemplate = {
  path: "internal/topology_notes",
  title: "Topology Notes",
  isInternal: true,
  content: `# Topology Notes

<!-- My evolving understanding of the mental geography.
     Observations about how territories connect, what's isolated,
     what co-fires unexpectedly, and what gaps exist. -->

## Structural Observations

### Bridges
<!-- Territories that connect disparate realms - high connectivity, diverse connections -->

[None identified yet]

### Islands
<!-- High content but isolated - potential avoidance or context separation -->

[None identified yet]

### Unexpected Pairings
<!-- High co-fire despite semantic distance - reveals hidden connections -->

[None identified yet]

### Unexplored Gaps
<!-- High semantic similarity but rarely co-fire - potential growth edges -->

[None identified yet]

## Active Hypotheses

<!-- Falsifiable statements about spatial structure
     Each should have: claim, evidence for/against, test, status -->

[No hypotheses yet]

## Questions About Structure

<!-- Open questions about the topology -->

- What patterns connect seemingly unrelated territories?
- Which gaps represent avoidance vs. simply separate contexts?
- What would it mean to bridge the isolated areas?

## Exploration Log

<!-- Record of directed topology exploration during dream cycles -->

---
`,
};

// ============ ALWAYS-IN-CONTEXT DOCUMENTS ============

export const TODO_TEMPLATE: DocumentTemplate = {
  path: "core/todo",
  title: "Todo",
  isInternal: false,
  content: `# Todo

<!-- This document is always in my context. I maintain it actively.
     Completed items get moved to the archive periodically. -->

## Urgent
[Items that need immediate attention]

## This Week
[Tasks for this week]

## Soon
[Tasks for the near future]

## Someday
[Lower priority items, ideas for later]

## Archive
<!-- Recent completed items for reference -->
`,
};

export const COMM_PREFERENCES_TEMPLATE: DocumentTemplate = {
  path: "core/communication",
  title: "Communication Preferences",
  isInternal: false,
  content: `# Communication Preferences

<!-- This document is always in my context. I update it as I learn the owner's preferences. -->

## Tone
- [How the owner likes to be communicated with]
- [What registers vs. what falls flat]

## Patterns I've Noticed
- [When they prefer depth vs brevity]
- [What they find helpful vs annoying]
- [Timing - when they're more receptive]

## Preferred Formats
- [How he likes information structured]
- [Examples that have worked well]

## Topics
- [Subjects where he wants more probing]
- [Areas where he prefers lighter touch]

## Things to Avoid
- [What doesn't land well]
- [Phrases or approaches that miss the mark]

## What I'm Still Learning
- [Open questions about how to communicate better]
`,
};

// ============ MASTER INDEX ============

export const MASTER_INDEX_TEMPLATE: DocumentTemplate = {
  path: "_master_index",
  title: "Document Map",
  isInternal: false,
  content: `# Document Map

*Auto-generated*

## Identity
- mission: [not yet populated]
- priorities: [not yet populated]
- questions: [not yet populated]
- ideas: [not yet populated]

## States (recent)
- mental: [no observations yet]
- mood_energy: [no observations yet]
- health: [no observations yet]
- dreams: [no dreams logged]

## People
[No people tracked yet]

## Business
- overview: [not yet populated]
- progress: [no entries yet]

## Phenomena
- synchronicities: [none logged]
- insights: [none logged]
- experiments: [none active]

## Internal (summary only)
- Working hypotheses: 0
- Open questions: 0
- Last reflection: never
`,
};

// ============ ALL TEMPLATES ============

export const ALL_TEMPLATES: DocumentTemplate[] = [
  // Core (always in context)
  TODO_TEMPLATE,
  COMM_PREFERENCES_TEMPLATE,
  // Identity
  MISSION_TEMPLATE,
  PRIORITIES_TEMPLATE,
  QUESTIONS_TEMPLATE,
  IDEAS_TEMPLATE,
  // States
  MENTAL_STATE_TEMPLATE,
  MOOD_ENERGY_TEMPLATE,
  HEALTH_TEMPLATE,
  DREAMS_TEMPLATE,
  // Business
  BUSINESS_OVERVIEW_TEMPLATE,
  BUSINESS_PROGRESS_TEMPLATE,
  // Phenomena
  SYNCHRONICITIES_TEMPLATE,
  INSIGHTS_TEMPLATE,
  EXPERIMENTS_TEMPLATE,
  // People
  PEOPLE_INDEX_TEMPLATE,
  // Internal
  MODEL_OF_USER_TEMPLATE,
  REFLECTION_LOG_TEMPLATE,
  TOPOLOGY_NOTES_TEMPLATE,
  // Master index
  MASTER_INDEX_TEMPLATE,
];

// Documents that are always loaded into context
export const ALWAYS_IN_CONTEXT_PATHS = [
  "core/todo",
  "core/communication",
];

/**
 * Create a person document template
 */
export function createPersonTemplate(name: string, relationship: string): DocumentTemplate {
  return {
    path: `people/${name.toLowerCase().replace(/\s+/g, "_")}`,
    title: name,
    isInternal: false,
    content: `# ${name}

## Context
[Who they are: ${relationship}]

## Relationship Dynamics
[Nature of the relationship, patterns]

## Recent Interactions
[What's been happening]

## Open Threads
[Unresolved things, ongoing conversations]

## What's Been Said About Them
[Quotes, observations shared]
`,
  };
}

/**
 * Create a project document template
 */
export function createProjectTemplate(name: string, purpose: string): DocumentTemplate {
  return {
    path: `business/${name.toLowerCase().replace(/\s+/g, "_")}`,
    title: name,
    isInternal: false,
    content: `# ${name}

## Purpose
${purpose}

## Current Status
[Where it is]

## Key Decisions
[Choices made]

## Open Questions
[Unresolved]

## Progress Log

---
`,
  };
}
