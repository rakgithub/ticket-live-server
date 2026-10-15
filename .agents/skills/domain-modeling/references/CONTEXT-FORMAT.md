# CONTEXT.md format

Use a concise glossary grouped by domain area. Record only domain language that is settled and relevant to ongoing work.

```markdown
# Domain context

## Terms

### Inventory hold

A temporary claim on ticket capacity for a specified quantity and expiry time. It reduces available capacity but does not create an order.

## Relationships and invariants

- A confirmed order consumes capacity represented by its checkout attempt; an expired inventory hold releases its capacity.
```

Keep definitions implementation-independent. State domain relationships or invariants only when they disambiguate a term. Do not include API endpoints, table names, algorithms, migration steps, or unresolved questions.
