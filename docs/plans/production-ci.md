# Production CI implementation plan

Status: Steps 1–5 implementation is in place pending CI execution; later steps
remain proposed.
Date: 2026-10-30

## Objective

Provide reliable pull-request checks for Ticket Live's seven apps, protect shared
contracts and runtime code, and verify the database, messaging, and container
behavior needed for production. Each app must have an independently visible test
result and an owning team. CI must use disposable infrastructure and synthetic
credentials, without depending on a developer's `.env` or production services.

This plan covers CI and repository governance. Image publication and deployment
are later phases with separate registry, environment, and approval decisions.

## Current baseline and confirmed gaps

- `.github/workflows/ci.yml` runs on pull requests, pushes to `main`, a weekly
  schedule, and manual dispatch.
- Seven matrix jobs run the existing app-specific test scripts.
- App unit-test jobs are scoped by workspace package; shared contract tests run
  separately. The root `pnpm test` command remains for local development.
- Lint and typecheck are currently repository-wide commands. There are no
  service-specific TypeScript project configurations.
- Placeholder database URLs are limited to unit-test jobs. Integration suites
  provision PostgreSQL with Testcontainers and CI service jobs provision
  RabbitMQ.
- `vitest.integration.config.ts` discovers app, package, and migration
  integration suites. The Order outbox recovery suite uses its own config and
  isolated RabbitMQ job.
- Compose configuration and both Docker targets are checked, but containers are
  not started to verify their entrypoints and readiness.
- Action references are pinned to commit SHAs, permissions are read-only, installs
  use the frozen lockfile, and jobs have timeouts.
- Security scanning, report retention, ownership rules, required checks, and
  independent release/deployment policies still need implementation or validation.

## Workflow and naming conventions

These are project conventions, not a universal industry standard. Use lowercase
hyphenated filenames and job IDs, readable display names, and stable required
check names. Both `.yml` and `.yaml` are supported; retain `.yml` consistently.

| File | Display name | Responsibility |
| --- | --- | --- |
| `ci.yml` | CI | PR and main checks, app tests, shared tests, integration and packaging validation |
| `security.yml` | Security | Dependency review, static analysis, secret and vulnerability scanning |
| `release.yml` | Release | Later: build, scan, attest and publish immutable images |
| `deploy.yml` | Deploy | Later: promote verified images, health checks and rollback |

Keep integration jobs inside `ci.yml` initially so the required gate can depend
on them directly. Extract a reusable workflow only when duplication warrants it;
retain the caller's required gate. Avoid seven copied app workflows.

Proposed job IDs and display names:

| Job ID | Display name |
| --- | --- |
| `lint` | Lint |
| `typecheck` | Typecheck |
| `workflow-validation` | Workflow validation |
| `app-tests` | Unit tests (app name from matrix) |
| `shared-tests` | Shared contract tests |
| `integration` | Integration tests |
| `outbox-integration` | Order outbox integration |
| `container` | Container and Compose validation |
| `ci-required` | CI required |

The app matrix must contain public-api, event-service, order-service,
payment-service, email-service, ticketing-service, and analytics-service.
Use `fail-fast: false` so one failure does not cancel another team's checks.
Keep root lint/typecheck explicitly shared until service-specific project
configurations are justified; do not imply that scoped tests provide scoped
TypeScript validation.

## Step 1: Repair and simplify the baseline

1. Separate lint and typecheck into clearly named jobs.
2. Remove the duplicate root unit-test run after confirming app jobs plus the
   shared-package job cover every file selected by `vitest.config.ts`.
3. Shared contract tests now run in a dedicated `shared-tests` job. Runtime
   package behavior still has no dedicated test suite; add focused tests before
   claiming dedicated runtime coverage.
4. Scope synthetic configuration to test jobs or deterministic test setup.
   Document that placeholder database URLs only satisfy unit-test configuration.
   Unit tests must mock infrastructure boundaries and not require a live database.
5. Keep integration suites separate from app unit-test jobs. Their tests
   provision disposable PostgreSQL instances; do not pass the unit-test
   placeholder URLs into them.
6. Use Node 24 and the package-manager version declared in `package.json`.
   Confirm pnpm bootstrap works on a clean runner; install with a frozen lockfile.
7. Add a pnpm store cache keyed by OS and lockfile. Install pnpm before configuring
   a cache mechanism that invokes it. Do not cache credentials or rely on caches
   for correctness; a cold-cache build must pass.

Acceptance: every app has its own result, no existing test suite runs twice, the
real integration suite runs with disposable PostgreSQL, and checks work without a
local `.env`. Contracts have dedicated coverage; runtime package behavior remains
a recorded test gap.

## Step 2: Validate the workflow and enforce a stable gate

1. Validate workflow syntax and expressions with a pinned actionlint version.
2. Add a final `ci-required` job with `needs` and `if: always()` that explicitly
   rejects failures, cancellations, and unexpected skipped prerequisite jobs.
3. Run CI for pull requests and pushes to the actual protected default branch.
   GitHub repository metadata confirms that `main` is the current default branch.
4. Include the `merge_group` trigger so the checks can be used if a merge queue
   is enabled. Confirm queue settings when configuring repository rules.
5. Keep PR runs free of deployment credentials and use minimal job permissions.
   Do not execute untrusted PR code using privileged `pull_request_target` jobs.
6. Keep third-party actions SHA-pinned and configure automated update proposals
   for actions, npm dependencies, and base images through `.github/dependabot.yml`.
   Review versions as well as pins.
7. Retain timeouts and cancellation of superseded PR runs. Keep release and
   production deployment concurrency separate so a newer PR cannot cancel them.

Acceptance: intentional test failure blocks `CI required`; no required result
remains pending because a workflow was filtered out.

Implementation note: the `CI required` gate and workflow validation are defined,
but their success and failure paths must be observed in a GitHub Actions run
before selecting `CI required` as a branch ruleset requirement. Repository branch
rules and merge queue settings are configured in GitHub, outside this workflow.

## Step 3: Introduce real integration and compatibility tests

1. Create explicit integration configurations and scripts for the suites below;
   exclude them from unit runs. Every required suite must contain real tests.
2. Use Testcontainers for PostgreSQL, matching the existing installed dependency.
   Provision RabbitMQ only for suites exercising it. CI uses a pinned RabbitMQ
   service image; the Order outbox suite has its own broker job to keep its
   recovery scenario isolated from consumer suites. Add Elasticsearch only if a
   suite exercises it.
3. Obtain database URLs and ports from the running containers. Wait for readiness,
   apply migrations, create service roles, and pass actual connection values to
   the service under test. Use only temporary volumes and synthetic data.
4. Verify service credentials cannot read or write another service's private data.
5. Test migrations against both a fresh database and a representative prior schema
   with synthetic data. Check compatibility with the previous supported service
   version; document forward-fix/rollback limits for irreversible migrations.
   Migrations are forward-only: use additive changes, deploy compatible service
   versions, backfill and verify, then remove obsolete structures in a later
   release. Recover from a backup for destructive data loss; correct a bad
   migration with a forward migration rather than editing an applied migration.
6. Add behavior-focused suites in this order:
   - Public API authentication, authorization, validation and response contracts.
   - Event hold expiry, capacity contention and prevention of overselling.
   - Order/Payment idempotency, ambiguous timeouts and reconciliation.
   - Outbox publishing, broker outages, duplicate consumption, retries and DLQs.
   - Ticket issuance/cancellation and asynchronous confirmation outcomes.
7. Validate OpenAPI/AsyncAPI documents and their alignment with executable Zod
   contracts; add compatibility checks for supported previous consumers.
8. Replace the removed integration job with the real suites and make them required.

Acceptance: tests establish actual database constraints and transactional behavior,
exercise broker delivery semantics, clean up containers, and cannot access shared
or production infrastructure. Restarting/retrying a suite does not change results.

Step 3 implementation progress: app integration suites now cover Public API
authentication, authorization, validation and response behavior; database schema
and table privilege isolation; Event capacity contention and hold expiry; Order
checkout recovery after a lost hold response, idempotency and reconciliation;
Payment persistence idempotency; Email duplicate delivery, retry and DLQ behavior;
Ticketing duplicate issuance, cancellation, retry and DLQ behavior; and migration
from a synthetic pre-extraction schema with persisted data. A separate Order
outbox integration suite simulates RabbitMQ unavailability, verifies the outbox
row remains pending, then verifies recovery publishes both Email and Ticketing
messages. Shared contract tests parse OpenAPI/AsyncAPI YAML, compare documented
schemas with Zod shapes, and validate examples and compatibility adapters.

The suites use disposable PostgreSQL Testcontainers and synthetic data. CI
provides isolated RabbitMQ service containers; there are no external database or
broker credentials. The local commands and broker requirement are documented in
the README. These integration suites have not yet been run in GitHub Actions, so
their runtime behavior and cleanup remain unverified. The migration test covers
the database snapshot before service extraction; compatibility with a previous
service binary is not asserted because the supported release window has not been
selected. Runtime package behavior remains outside Step 3; the seven-service
booking flow is covered in Step 4 below.

## Step 4: Verify containers and critical booking flows

1. Keep Compose validation and builds of runtime and migrations targets.
2. Create isolated CI Compose configuration using test credentials and temporary
   storage. Avoid mutating developer or production volumes.
3. Run migrations as a separate one-off process before starting dependent apps.
4. Start all seven service processes from the built runtime image and wait for
   readiness with a bounded timeout. The current shared image does not require
   seven identical image builds.
5. Exercise a booking through the public API and verify its order, payment,
   inventory, issued ticket and eventual confirmation outcomes. Use the existing
   fake payment/email providers and a deterministic Gemini boundary.
6. Add selected dependency outage/recovery scenarios. Retain logs on failure and
   always clean up processes, containers and volumes.

Acceptance: valid packaging starts successfully and the critical booking flow
works across HTTP and message boundaries without external provider credentials.

Step 4 implementation progress: the container job validates the CI Compose
overlay, builds the runtime and migration targets, provisions project-scoped
Compose volumes with synthetic credentials, creates service roles, runs
migrations before starting the seven app processes, and waits for their
readiness. Its smoke flow creates a user and event through the Public API,
checks event discovery through a deterministic Gemini response stub, then checks
checkout, mock payment, confirmed inventory, ticket issuance, and fake email
acceptance. RabbitMQ is stopped during checkout to verify the confirmed order
remains pending in the outbox, then restarted before verifying message recovery.
Failure logs are retained as a short-lived CI artifact, and cleanup removes the
project's containers and volumes. These container checks have not yet been
observed in a GitHub Actions run; local Docker was unavailable during
implementation, so runtime startup, outage recovery, and cleanup still require
that run.

## Step 5: Add security and useful reports

1. Add dependency review for new vulnerable dependencies and disallowed licenses;
   confirm repository visibility and GitHub plan support. If unavailable, choose
   an equivalent lockfile-aware check and document its limits.
2. Enable JavaScript/TypeScript and GitHub Actions static analysis where supported,
   plus secret scanning and push protection where available.
3. Scan dependencies and final container images on PRs and on a schedule. Establish
   a reviewed severity/exploitability policy with owners and expiring exceptions.
4. Upload test reports, coverage reports, and failure logs with bounded retention.
   Redact tokens, credentials, customer data and message bodies.
5. Use coverage to identify missing behavior; establish a baseline before enforcing
   thresholds. Do not equate a percentage with correctness.
6. Notify owning teams of actionable scheduled failures. Keep security reports
   distinct from the required functional CI result.

Acceptance: a representative vulnerable dependency and synthetic secret are caught
in safe validation fixtures; maintainers can diagnose failures from retained output.

Step 5 progress: `security.yml` runs dependency review on PRs, CodeQL for
JavaScript/TypeScript and GitHub Actions, Gitleaks over repository history, and
Trivy scans of the pnpm lockfile and both production image targets. A scheduled
failure opens or updates an issue for the current repository owner until Step 6
maps service ownership. Dependency review rejects new High/Critical findings and
strong copyleft licenses; Trivy rejects High/Critical findings and requires
owner/reason/expiry metadata for exceptions. Scanner fixtures create a random
synthetic AWS-shaped secret and a known vulnerable lodash lockfile only in the
runner's temporary directory. Unit, integration, outbox, and contract tests
publish bounded JUnit/coverage reports; coverage has no threshold.

The repository metadata confirms this is public, so GitHub Dependency Review is
available without private-repository Code Security licensing. Public secret
scanning and push protection are available by default, but the actual repository
settings still need an owner-side check. The Security workflow is separate from
`CI required`. Fixture detection, report upload, scheduled notification, and
GitHub code-scanning ingestion remain unobserved until a GitHub Actions run.

## Step 6: Configure team ownership and branch protection

1. Map each app directory to its actual GitHub team through CODEOWNERS.
2. Assign explicit owners for contracts, runtime, migrations, CI and infrastructure.
   Obtain real team handles before writing ownership rules.
3. Require PR reviews, appropriate code-owner review, and passing `CI required`
   plus the chosen security gates through repository rulesets.
4. Define a narrow, audited emergency bypass policy; do not make ordinary pushes
   bypass the required checks.
5. Validate rules with a test PR and, if enabled, a merge-queue run.

Acceptance: a failing app or shared check prevents merging, relevant teams receive
review requests, and a successful PR can merge without permanently pending checks.

## Step 7: Optimize after correctness is established

1. Measure job duration, queue time, flakiness, and runner cost first.
2. Add dependency-aware affected-service selection if full runs become expensive.
   App changes select their tests; shared-package changes select consumers.
3. Root configuration, lockfile, toolchain, workflow, migration and unknown changes
   conservatively trigger broader checks. Handle renames/deletions and compare
   with the correct PR merge base; fetch sufficient Git history.
4. Keep workflow-level required gates running on every PR. Document allowed skips
   and validate them inside the final gate.
5. Keep full runs on main and on a schedule as a backstop. PRs must still run any
   checks necessary to establish that their own changes are safe.

Acceptance: fixture changes to each app, a shared package, the lockfile and a root
configuration select the expected jobs; a selection error cannot silently pass CI.

## Later: release and deployment boundary

After CI is stable, choose a registry, deployment platform, service release policy,
and environment approval rules. Build release images once per source revision,
scan them, generate SBOM/provenance, and promote the same immutable digest.
Authenticate to cloud infrastructure using OIDC when supported. Deploy services
independently, run migration compatibility checks and staging smoke tests, and
record rollback procedures. The shared runtime image currently limits independent
build packaging; deployment selection is already per service process.

## Verification and rollout order

Implement Steps 1–2 first, then add the real suites in Steps 3–4, followed by
security/governance in Steps 5–6. Optimize only after a reliable baseline exists.
For implementation, run the repository-required lint, typecheck and relevant tests;
validate YAML with actionlint and run Compose/container checks on a Docker-capable
runner. Validate both success and controlled failure paths in GitHub Actions.

Do not mark the rollout complete until real integration coverage and required
branch rules are active. A YAML file alone cannot establish production readiness.

## Decisions requiring maintainer input during implementation

- Actual team handles, protected branch, repository visibility and security plan.
- Supported contract compatibility window and migration upgrade baseline.
- Confirm the implemented vulnerability/license policy and report retention with
  the repository owner; select required security gates after observing CI runs.
- Registry, deployment platform, release ownership and environment approvals for
  the later delivery phase.

These do not block implementing the baseline CI repairs.

## References

- [GitHub matrix jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)
- [GitHub required-check troubleshooting](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/commits-and-status-checks/troubleshooting-required-status-checks)
- [GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use)
- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [pnpm workspace filtering](https://pnpm.io/filtering)
- Repository guardrails: `docs/guardrails/planning-conventions.md`,
  `testing-conventions.md`, and `verification-conventions.md`.
