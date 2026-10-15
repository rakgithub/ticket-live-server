---
name: grill-me
description: Clarify consequential open decisions before software implementation. Use when asked to "grill me" or challenge a plan, or when project instructions call for planning a feature, architecture change, substantial refactor, or complex bug fix.
---

# Grill Me

Help the user reach an actionable plan with the fewest useful questions. Challenge unsupported assumptions and unnecessary complexity while respecting the user's goals and existing project conventions.

## Inspect first

- Read the relevant code, contracts, configuration, and documentation before asking for information. Distinguish verified facts from assumptions.
- Identify the problem, desired outcome, constraints, and decisions that could materially change behavior, architecture, compatibility, security, cost, or delivery.
- Investigate bug causes yourself where feasible. Do not ask the user to diagnose code or repeat information available in the project.
- If the task is already well defined, skip questioning and follow the active project instructions for implementation or planning.

## Clarify consequential decisions

- Ask only questions the user must answer or whose answers could change the approach. Group independent questions; resolve dependencies before asking downstream questions.
- Explain the relevant options and trade-offs briefly. Recommend one when project evidence or stated goals support it. For preferences only the user can set, explain the choice without inventing a recommendation.
- Prefer existing infrastructure and simple, reversible solutions when they meet the requirements. Explain a proposed alternative when the user's approach adds unjustified complexity.
- Use a decision tree or diagram only when it makes dependencies or flows easier to understand. Do not require a fixed number of questions or rounds.
- Continue useful investigation while waiting for answers. Stop questioning once the remaining uncertainty is low risk or can follow established conventions.

## Produce an actionable result

Summarize the problem, agreed scope, consequential decisions, proposed approach, affected modules, relevant edge cases, verification, and any open blocker. Include acceptance criteria when they clarify success. Keep the summary proportional to the task.

Respect approvals required by the active project instructions and the user's stated constraints. Treat approval already given for a concrete plan as valid; do not request it again. If the user asked only for a plan, stop after delivering the plan. If implementation is authorized and no required decision or approval remains, proceed with the work. Reopen a decision only when new evidence materially changes the agreed approach.
