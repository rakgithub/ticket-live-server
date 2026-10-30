## Tests

- Create a dedicated test file for every production source file, co-located and
  named `<module>.test.ts`. Its suite must directly verify that module's
  observable behavior; coverage inherited only because another module imports
  it does not replace a dedicated test. For declaration-only or generated
  files, use a dedicated type or build contract check instead of inventing
  runtime behavior to test.
- Cover observable behavior, important rules, boundaries, failures, and state
  transitions. Avoid tests that merely repeat implementation details.
- Choose unit or integration tests based on the behavior and infrastructure.
  Test database constraints, transactions, and concurrency against an isolated
  real database when they are relevant.
- Name tests for the scenario and expected behavior. Use consistent, descriptive
  names that make failures understandable.
- Mock external services at their boundaries. Use deterministic fixtures; avoid
  real credentials, network calls, shared data, arbitrary delays, and reliance
  on local `.env` values or test execution order.
- For API changes, cover relevant validation, authentication, authorization,
  response contracts, and downstream failures.
- Use coverage to find omissions, not as proof of quality. Use mutation testing
  selectively when it would help assess assertions.
- Run focused tests and required repository checks; report failures and checks
  that could not run.
