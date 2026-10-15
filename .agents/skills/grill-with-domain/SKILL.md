---
name: grill-with-domain
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

# Grill With Domain

Use this skill only when explicitly invoked. Load and apply both repository skills before proceeding:

1. `$grill-me` to investigate, identify consequential decisions, ask focused questions, and produce an actionable plan.
2. `$domain-modeling` to resolve domain terminology, test domain boundaries, and record agreed glossary entries or ADRs when they meet that skill's criteria.

Run both workflows as one conversation: investigate before questioning, distinguish facts from assumptions, and use the domain model to sharpen the plan. Record only terms and decisions that the user has agreed to and that are authorized for documentation changes. Respect the approval rules in `AGENTS.md` and avoid a duplicate confirmation when approval for the concrete plan is already given.
