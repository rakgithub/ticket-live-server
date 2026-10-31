# Security scan policy

The `Security` workflow is separate from the functional `CI required` gate. It
runs on pull requests, pushes to `main`, a weekly schedule, and manual dispatch.
Findings stay visible as Security workflow results and retained reports; they do
not silently change the functional CI required check.

## Dependency and container findings

- Dependency review rejects newly introduced High or Critical vulnerabilities.
- New GPL and AGPL dependencies are denied. If a dependency needs an exception,
  record the package, owner, reason, and review date in the pull request; do not
  add a permanent global license bypass.
- Trivy scans the pnpm lockfile and both production Docker targets. High and
  Critical findings fail the corresponding security job, including findings
  that do not yet have a fix.
- Treat severity as the initial priority. Review exploit availability and
  whether the affected code is reachable before choosing a remediation or an
  exception. The scanner does not prove exploitability or reachability.
- Trivy exceptions belong in `.trivyignore.yaml`. Each exception must include
  `statement: "owner=@rakgithub; reason=..."` and `expired_at` no more than 90
  days ahead until Step 6 confirms service owners. CI validates the owner,
  reason, and expiry; Trivy stops honoring an exception after it expires.

## Reports and coverage

JUnit, per-service LCOV, dependency findings, image findings, and redacted secret
scan results are retained as short-lived Actions artifacts. Test and
vulnerability reports are retained for 14 days; secret scan reports for 7 days;
container failure logs for 5 days. Test data is synthetic. Secret scan output is
redacted before it can be retained. Do not add real customer records, credentials,
or message bodies to fixtures or reports.

Coverage is collected per service as a diagnostic baseline. No percentage
threshold is enforced; use the reports to find untested behavior and assess the
assertions directly.

## Scheduled failures and ownership

A failed scheduled scan opens or updates one issue assigned to the repository
owner (`rakgithub`). Replace this temporary recipient with the responsible teams
after their handles are confirmed in Step 6 and CODEOWNERS is established.
