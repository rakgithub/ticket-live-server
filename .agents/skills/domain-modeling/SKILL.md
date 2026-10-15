---
name: domain-modeling
description: Build and sharpen a project's domain model when resolving domain terminology, changing CONTEXT.md, or recording an ADR. Do not use solely to read existing domain vocabulary.
---

# Domain Modeling

Actively improve the domain model while designing changes. Challenge terms, test them with concrete scenarios, and capture agreed vocabulary and consequential decisions. This skill is for changing the model, not simply consuming it.

## Locate the domain context

- Inspect the repository before choosing locations. Use an existing `CONTEXT-MAP.md` when it identifies multiple bounded contexts; otherwise use the repository's established context and ADR locations.
- Create `CONTEXT.md` or `docs/adr/` only when an agreed term or ADR needs recording. Preserve an existing layout where one exists.
- Read [the context format](references/CONTEXT-FORMAT.md) when creating or editing `CONTEXT.md`. Read [the ADR format](references/ADR-FORMAT.md) only when an ADR is warranted.

## During design

- Clarify consequential conflicts with the existing glossary before relying on a term. When language is vague or overloaded, propose a precise canonical term.
- Test relationships and boundaries with concrete edge-case scenarios. Ask only questions that could change the model or solution.
- Cross-check stated behavior against relevant code and documentation. Surface meaningful contradictions for resolution.
- Keep `CONTEXT.md` domain-focused: terms, concise definitions, and domain relationships or invariants. Exclude implementation plans, storage choices, and temporary notes.
- Once the user has agreed to a term and documentation changes are authorized, record it promptly rather than batching unrelated changes.

## ADRs

Offer an ADR only when the decision is hard to reverse, would be surprising without context, and resulted from a real trade-off. Otherwise record the outcome in the appropriate existing documentation or leave it in the implementation plan.

## Result

Summarize resolved terms, material assumptions, contradictions found, decisions recorded, and any remaining question. Follow the repository's approval requirements before modifying files.
