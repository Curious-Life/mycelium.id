# Phase 2 — The Science of Bi-Temporal Claims

**Date:** 2026-06-19
**Scope:** The science behind the "stable-facts" layer — bi-temporal claims + distilling day-cards/themes into longer arcs.
**Method:** Multi-facet literature sweep (bitemporal data modeling · belief revision · temporal knowledge graphs · LLM agent memory consolidation · state-vs-trait psychology · Bayesian evidence accumulation · evolving-memory governance).
**Companions:** the day-card reflection records (Phase 1d), `claims.js`/`personaClaims` (the existing belief store), and the honesty disciplines from the metric work.

---

## 0. The frame: Phase 2 is three sciences, not one

A "stable fact about the user" is a belief that (a) is **true over some real-world period**, (b) was **come-to-be-believed over some system period**, (c) is **distilled from concrete dated observations** (the day-cards), (d) **earns confidence as evidence accrues**, and (e) **gets revised, not overwritten, when it changes.** Each clause is a mature field:

| Clause | The science | What it gives Phase 2 |
|---|---|---|
| (a)+(b) time | **Bi-temporal modeling** (SQL:2011) | the storage/time contract |
| (e) revision | **Belief revision** (AGM) + **truth maintenance** | how claims change without breaking |
| (c) distillation | **Episodic→semantic consolidation** (Generative Agents reflection) | the day-card → arc engine |
| facts-at-scale | **Temporal knowledge graphs** | claims as (subject, predicate, object, validity) |
| *what is "stable"* | **State-vs-trait psychology** (Whole Trait Theory) | the honest definition of a stable claim |
| (d) confidence | **Bayesian evidence accumulation** | how a claim earns its number |
| safety | **Evolving-memory governance** (SSGM) | drift/poisoning defenses |

The single most important one is the psychology (it defines what you're even storing); the rest are the mechanics.

---

## 1. The time model — bi-temporal modeling

**The science.** A bi-temporal record carries **two orthogonal time axes** ([Fowler, Bitemporal History](https://martinfowler.com/articles/bitemporal-history.html); [SQL:2011 temporal features](https://www.researchgate.net/publication/261845780_Temporal_features_in_SQL2011)):
- **Valid time** (`valid_from`/`valid_to`) — when the fact is/was true *in the world*.
- **Transaction (system) time** (`system_from`/`system_to`) — when the system *recorded/believed* it.

SQL:2011 standardized this as **system-versioned tables** (transaction time) + **application-time periods** (valid time). Four timestamps; the unique key includes both periods. The defining discipline: **never destructively update or delete** — a change *closes* the old assertion's `system_to` and *opens* a new row. Reasoning over validity intervals uses **Allen's interval algebra** (before / meets / overlaps / during / …).

**What it gives Phase 2.** Two different questions become answerable, which a single timestamp conflates:
- *"What was true of the user in March?"* → valid-time query.
- *"What did we **believe** about the user in March?"* → transaction-time ("as-of") query.

The second is exactly your **"look back / trace red threads"** capability — you can replay the belief state at any past moment, see when a claim was first asserted, when it was revised, and on what evidence. And "we were wrong about X" becomes a *revision* (close the assertion), not a destructive edit that loses the history. This is the substrate that makes the stable-facts layer auditable and honest by construction.

**Design prescription.** Each claim row: `valid_from/valid_to` (the trait/fact's real-world span) + `system_from/system_to` (assertion span) + the existing `confidence`. Supersession = close + open, never overwrite. Plaintext time keys (queryable), encrypted content — same split as the day-cards.

---

## 2. Revision — belief change without breaking (AGM + TMS)

**The science.** **AGM** (Alchourrón–Gärdenfors–Makinson) is the canonical theory of rational belief change ([Stanford Encyclopedia: Logic of Belief Revision](https://plato.stanford.edu/entries/logic-belief-revision/); [AGM Theory and AI](https://www.academia.edu/27473679/AGM_Theory_and_Artificial_Intelligence)). Three operations:
- **Expansion** — add a belief.
- **Revision** — add a belief *consistently*, resolving conflicts with existing ones.
- **Contraction** — *drop* a belief without asserting its negation (you stop believing X without believing not-X — crucial for "we no longer think this" vs "the opposite is true").

The machinery: **epistemic entrenchment** — an ordering of how deeply held beliefs are; under conflict, *less entrenched* beliefs yield. **Truth Maintenance Systems** (Doyle 1979) track **justifications** — what supports each belief — so retracting evidence triggers revisiting its dependents. **Defeasible / non-monotonic reasoning**: beliefs held "by default" until *defeated* by new evidence.

**What it gives Phase 2.** Claims are exactly defeasible beliefs that must be revised over time. AGM tells you the *operations* (revise/contract/expand) and the *constraints* (minimal change, consistency); the bi-temporal model is the *substrate* that realizes them (contraction = closing an assertion interval). The marriage — **AGM operations on a bi-temporal store** — is the principled "stable facts that can be honestly revised" design.

**Design prescription.** Each claim carries: **entrenchment/confidence** (which survives conflict), **justifications** (links to the day-cards/messages that support it — a TMS dependency, and also the page's drill-to-evidence), and **defeasible status** (held until contradicted → then *contracted*, system-closed, not deleted). Contradiction handling order (from the agent-memory survey, §3): **source priority** — user-stated > agent-inferred — and **recency** as a tiebreaker, but recorded as a revision with both rows preserved.

---

## 3. The distillation engine — episodic → semantic (Generative Agents)

**The science — this is the direct precedent for "distill day-cards into arcs."** LLM agent memory is taxonomized into **working / episodic / semantic / procedural** ([Memory for Autonomous LLM Agents survey, arXiv 2603.07670](https://arxiv.org/html/2603.07670v1)):
- **Episodic** = concrete, timestamped, importance-scored experiences — *your day-cards.*
- **Semantic** = abstracted, de-contextualized knowledge consolidated from episodes — *your stable claims.*

The canonical consolidation mechanism is **Generative Agents'** ([Park et al. 2023](https://dl.acm.org/doi/10.1145/3586183.3606763)) **reflection**: periodically, the agent **clusters related observations and synthesizes higher-level insights** ("Klaus has been eating alone and seems withdrawn") — and builds **reflection *trees*** (leaves = observations; higher nodes = progressively more abstract). Triggered when accumulated **importance** crosses a threshold. Retrieval/scoring is a **multi-signal mix: recency (exponential decay) + relevance (embedding similarity) + self-assessed importance.**

The survey's other named mechanisms:
- **Reflexion** — natural-language post-mortems after events.
- **ExpeL** — contrasts trajectories to extract reusable "rules of thumb."
- **A-MEM** — Zettelkasten-style evolving notes with dynamically-created links (an evolving knowledge network).
- **MemoryBank** — Ebbinghaus **forgetting curve**: accessed/important memories reinforced, neglected ones fade.
- **Mem0 / Memory-R1 / AgeMem** — explicit **extraction → consolidation → forgetting** lifecycle; AgeMem *learns* the memory ops via RL.

Critically, the survey flags: **consolidation is "rarely automatic — most systems require explicit prompting or heuristic triggers."**

**What it gives Phase 2.** Your day-cards → arcs distillation **is** Generative-Agents reflection: cluster the day-cards (by embedding, not string — same as the theme-reconciliation point), synthesize higher-level claims, structure them as a **hierarchy (day-card → theme → arc → stable claim)** — a reflection tree. It needs an explicit **trigger** (importance threshold or schedule), a **confidence/importance score**, and embedding-based clustering so threads cohere.

**Design prescription.** A periodic consolidation pass: cluster recent day-cards by theme-embedding → synthesize candidate claims → score (recency+relevance+importance) → if a candidate clears an evidence bar (§6), assert it as a bi-temporal claim with justification links back to the day-cards it distilled. The reflection *tree* gives you the "red thread → arc" structure natively.

---

## 4. Facts-at-scale — temporal knowledge graphs

**The science.** TKGs extend static KGs with **temporal validity** — each (subject, predicate, object) carries a timestamp/interval ([TKG reasoning](https://www.emergentmind.com/topics/temporal-knowledge-graph-reasoning-tkgr); [TKG completion survey](https://www.researchgate.net/publication/373087205_Temporal_Knowledge_Graph_Completion_A_Survey)). Models are **interval-based / event-based / update-based**; reasoning uses **Allen relations + temporal constraints**. Recent (2025–26): time-aware encodings, and notably **DiMNet's cross-time disentangler that decomposes features into "active" and "stable" components** — the formal version of the state-vs-trait split. TKG *forecasting* infers future facts (ties to the prediction staircase, with the same honesty caveats).

**What it gives Phase 2.** Claims naturally form a **temporal knowledge graph**: each claim = `(user, predicate, object, validity-interval, confidence, provenance)`. The **active/stable decomposition** (DiMNet) is the engineering analog of "which beliefs are *state* vs *trait*" — and a principled way to tag claims. The existing `personaClaims` + entity links are already a proto-KG; Phase 2 makes it *temporal*.

**Design prescription.** Model claims as temporal-KG edges; tag each as **active (state-like, short validity)** vs **stable (trait-like, long validity)**; use Allen relations for "this claim held *during* that period." Don't build forecasting into it yet (prediction stays present-tense per the staircase).

---

## 5. The load-bearing one — what "stable" *means*: state vs trait

**The science — this defines what you're storing, so get it right.** Personality psychology's modern consensus, **Whole Trait Theory** ([Fleeson & Jayawickreme 2025](https://journals.sagepub.com/doi/10.1177/08902070251366709); [density-distribution model](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5596082/)): **a trait is not a fixed point — it is the *density distribution* of a person's states.** A person's "extraversion" is the *distribution* (central tendency **and** variability) of their daily extraversion-states, which fluctuate systematically with situations (the **DIAMONDS** situation taxonomy). Crucially, **the variability itself is trait-like and stable** — some people are reliably more variable than others ([trait variability as individual difference](https://www.sciencedirect.com/science/article/abs/pii/S0092656616300514)). **Idiographic personality networks** show stability *and* within-person variability, "and when they become problematic" ([Wright/Hopwood line](https://www.sciencedirect.com/science/article/pii/S0092656624000163)). The field's whole framing is **integrating between-person stability with within-person change**.

**What it gives Phase 2 — and it's the honesty keystone.** A stable claim about the user **must not be a fixed point** ("Altus *is* X"). It must be a **distribution parameter**: *"Altus's X tends to run high, with this much variability, in these contexts, over this period."* The day-cards **are** the states; the stable claim is the *distribution they imply*. This is the same "reflection-not-diagnosis / measured-not-narrated" discipline from the page, now at the belief layer — and it directly resists the "you are X" overclaim. It also tells you *what to distill*: not just a central tendency, but the **variability and the context-dependence** (which DIAMONDS-style situations the state shifts with).

**Design prescription.** A stable claim stores: **central tendency** + **variability** + **context-dependence** (situational conditioning) + **validity interval**. "Trait" = a low-variability, long-validity claim; "state" = high-variability, short-validity. Surface claims as distributions/tendencies, never as fixed identity assertions. (This is the belief-layer version of the page's Band-A/B/C honesty gradient.)

---

## 6. How a claim earns its number — Bayesian evidence accumulation

**The science.** Confidence is well-modeled as a **Bayesian posterior** updated by **sequential evidence** ([Confidence as Bayesian Probability](https://www.sciencedirect.com/science/article/pii/S0896627315008284); [sequential Bayesian updating](https://sites.socsci.uci.edu/~zoravecz/bayes/data/Articles/Oravecz2016SBUFB.pdf)). Each corroborating observation moves the posterior; the **sequential probability ratio test (SPRT)** / drift-diffusion gives a principled "enough evidence to assert" threshold. **Corroboration over time raises confidence**; contradiction lowers it. But human/LLM updating deviates: **primacy, recency, and anchoring** biases distort sequential reasoning ([prior confidence & belief updating](https://arxiv.org/pdf/2412.10662)).

**What it gives Phase 2.** The existing `confidence: 0.80` on claims should be a **Bayesian posterior over the day-card evidence**, not a vibe. A claim shouldn't be *promoted to "stable"* until its evidence clears an **SPRT-style bar** (don't enshrine a one-off observation as a trait). And the distilling agent has exactly the biases the literature warns about — most dangerously **anchoring on its own prior claims** (the self-reinforcement loop flagged on the day-cards: the agent reads its own `model.md`/claims and perpetuates them). So the update must weight *fresh* day-card evidence, not the agent's restatement of its own earlier belief.

**Design prescription.** Confidence = posterior updated as day-cards corroborate/contradict; an **evidence threshold** (≥N independent corroborating day-cards, SPRT-style) before episodic→stable promotion; **down-weight the agent's own prior claims** in the update (corroboration must come from observations, not from the belief restating itself); decay confidence when a claim goes un-corroborated (the MemoryBank forgetting-curve idea).

---

## 7. Safety — governing an evolving belief store

**The science.** Evolving agent memory is a known risk surface: **memory poisoning** (MPBench's 9 vulnerability classes, flagged in the day-31 scan) and drift, addressed by frameworks like **SSGM — Stability and Safety Governed Memory** ([arXiv 2603.11768](https://arxiv.org/html/2603.11768v1)). A "stable facts about the user" store is the *highest-value, highest-risk* memory: a wrong or injected claim propagates into how the system treats the person.

**Design prescription.** **Source attribution** (user-stated > agent-inferred, per the survey) so an inferred claim can never silently override a user's own statement; **confidence-gating** before a claim influences behavior (mirrors the CVP gate — an un-corroborated claim is "pending," not "stable"); and the **bi-temporal audit trail** as the recovery mechanism (you can always replay and revert a bad revision because nothing was destructively deleted).

---

## 8. Synthesis — the Phase-2 design the science prescribes

1. **Storage = bi-temporal temporal-KG.** Each claim: `(user, predicate, object, valid_from/to, system_from/to, confidence, provenance, active|stable)`. Plaintext time/structure keys, encrypted content. Never destructive-update — supersede.
2. **Revision = AGM on that store.** Revise/contract/expand; entrenchment = confidence; contraction closes an assertion interval; user-stated beats agent-inferred.
3. **Distillation = Generative-Agents reflection.** Periodic, importance-triggered pass clusters day-cards **by embedding** → synthesizes higher-level claims → reflection *tree* (day-card → theme → arc). Threads are **semantic, not string** (the day-card reconciliation point, now structural).
4. **What you store = distributions, not points.** Per Whole Trait Theory: central tendency + variability + context-dependence + validity. "Trait" claims are low-variability/long-validity; "state" claims short. Never "you are X."
5. **Confidence = Bayesian posterior with an evidence bar.** SPRT-style promotion threshold; down-weight the agent's own priors (anti-self-anchoring); decay un-corroborated claims.
6. **Provenance always.** Every claim links to the day-cards/messages that justify it (TMS justifications = the page's drill-to-evidence).
7. **Governed.** Source-priority, confidence-gating before influence, bi-temporal audit as the undo.

---

## 9. The through-lines (this connects to everything built this session)

- **Provenance everywhere** — claims cite their day-cards, like the page cites its messages.
- **Distribution, not point** — the state-vs-trait insight is the belief-layer twin of "reflection, not diagnosis."
- **Confidence as an earned posterior with a bar** — the belief-layer twin of the CVP gate (`pending` until validated).
- **Never destructively delete; supersede with an audit trail** — the bi-temporal twin of the health-honesty "fail-loud, keep the trail" discipline.
- **Semantic, not string** — consolidation clusters by meaning, like the day-card theme reconciliation.
- **Guard the agent's self-anchoring** — the recency/primacy/anchoring biases are the formal version of the day-card self-reinforcement loop.

---

## 10. Open questions to settle before building

- **Promotion bar (§6):** how many corroborating day-cards / what SPRT threshold before episodic→stable? (calibration question, like the quadrant thresholds.)
- **Active/stable boundary (§4/§5):** a fixed validity-length cutoff, or learned from each claim's day-card variability?
- **Forgetting (§3):** adopt a MemoryBank-style decay for un-corroborated claims, or keep everything and let confidence carry it?
- **Reuse vs new (codebase):** extend the existing `claims.js`/`personaClaims` store bi-temporally, or a new `claims_bitemporal` table? (sweep the existing store's schema + callers first — same pre-deletion-audit discipline.)
- **Distillation trigger:** importance-threshold (Generative Agents) vs schedule vs both?

---

*The headline: Phase 2 is the marriage of bi-temporal modeling (the time/audit substrate), AGM belief revision (the change operations), and Generative-Agents reflection (the day-card → arc engine) — governed by the one piece of domain science that says what you're even allowed to store: a stable fact about a person is a **distribution of their states**, never a fixed point.*
