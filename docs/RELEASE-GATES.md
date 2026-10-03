# Release validation gates

This is an evidence checklist, not a percentage-complete claim. The current
branch is `runtime/experience-execution`, draft PR #15. Keep the stacked PRs
unmerged until reviewed. Channel development and workflow migration remain deferred.

## Validated locally

- Strict TypeScript build and packaged migrations.
- Real PostgreSQL Case persistence, concurrent Actions, deduplication, process
  restart, immutable preparations, Grant/Context enforcement and Proof.
- Production-only runtime package validated behind certificate-verified local HTTPS:
  platform health Host accepted, MCP foreign Host/origin rejected, persisted Grant,
  native LIVE read, Proof and stable work identity across service restart.
- External MCP client invocation and approved upstream filesystem integration.
- Real Chromium sandbox execution, durable human resolution and verified
  second-run procedure reuse. Composio responses are controlled contract fixtures.
- PAJ lost-response, duplicate webhook, signed completion and ambiguous financial
  outcomes through fault-injection tests. These are not authenticated PAJ results.
- Multi-step SIGKILL recovery checks required evidence for every preceding Action
  before dispatching the next one. A persisted but unproven success stays VERIFYING
  without subsequent effects or Experience capture. A proven sequence resumes in
  a fresh process without replaying its first Action.
- Human resolution and Experience promotion recheck operator authority inside
  their mutation transaction, after blocking work. Row locks serialize revocation;
  expiry is checked after acquiring the authority lock. Real PostgreSQL tests
  cover revocation during task/promotion lock waits and expiry during authority
  lock waits; rejected mutations leave task/stage/audit state unchanged.
- Authenticated PAJ/Composio requests reject redirects. JSON reads are bounded to
  256 KiB before parsing, including chunked responses. Invalid/oversized write
  responses retain existing ambiguous-outcome handling; no provider replay is added.
- `/health` checks PostgreSQL and returns 503 without internal error details when
  storage is unavailable. Health responses are not cached. Pool acquisition has a
  five-second timeout; the health query has a two-second query timeout. An idle
  database connection error is handled rather than crashing via an unhandled event.
- Local PostgreSQL custom-format backup restored into a separate database: all
  1,577 rows across 25 public tables matched source row hashes. No worker/provider
  was started against the restored copy. Target-host backup/restore remains open.
- Production dependency audit: zero reported advisories after overriding the
  transitive `qs` parser to 6.16.0. Remove the override when parent dependency
  ranges include a patched release and the resulting tree is revalidated.

## Access-dependent gates still open

| Gate | Required input | Acceptance evidence |
| --- | --- | --- |
| Composio authenticated contract | Existing project secret location, connected account and approved read tool | Real discovery/version/schema, internal-user ownership, healthy connection, authorized MCP invocation and persisted Proof |
| PAJ authenticated reads | Existing PAJ configuration, environment and legitimate bank lookup fixture | Provider authentication, authoritative directional rates and actual account response contract |
| PAJ order lifecycle | Callback deployment, approved sandbox order or explicitly bounded live transaction | Provider order identity, signed callback, duplicate delivery, finality/debit semantics and matching Axis Proof |
| Target deployment | Intended host/project, database and secret injection mechanism | TLS/origin authentication, migrations, external MCP smoke, SIGTERM drain and restart recovery on that host |
| Operational recovery | Target database backup configuration and restore environment | Restore a backup into an isolated database; confirm stable Actions and no automatic resubmission of ambiguous writes |

Railway CLI access is configured: the existing `axis` project has Brain,
Onboarding and Postgres, and Brain already has DATABASE_URL and a public domain.
The user confirmed billing is the deployment blocker. No cloud settings were
changed. PAJ/Composio live-contract checks remain deferred. Never copy credentials
into this document or Git, or choose arbitrary production recipients/amounts.
See `docs/DEPLOY-MCP.md` for the finished core deployment package and runbook.

## Operator validation sequence

1. Inject configuration described in `.env.example`, `docs/MCP-SETUP.md`,
   `docs/PAJ.md` and `docs/EXPERIENCE.md`. Begin with approved read capabilities.
   Missing providers remain UNAVAILABLE. Production must reject SANDBOX/MOCK.
2. Build the exact pushed revision, start against the intended PostgreSQL database,
   and verify `/health` via the configured HTTPS origin. Confirm untrusted origins
   and missing/invalid MCP bearer credentials fail closed.
3. Provision one persisted user/client Grant with only the selected capabilities,
   required Context and exact connected-account resources. Use an external MCP
   client to search, prepare, execute, inspect status and retry the same identity.
4. Inspect persisted Actions, Evidence and Proof using the protected operator
   environment. Record provider IDs and safe test identifiers, never credentials
   or raw private context, in the acceptance report.
5. Enable PAJ order creation only after its exact authenticated contract and
   callback signature fields have been validated. Order creation alone is never
   completion. Do not fund an order without an approved amount and destination.
6. For an ambiguous order, retain its original Action and provider identity. Use
   the signed callback/status record and provider support to establish finality.
   Never delete the tombstone, repeat the order POST, or fabricate a refund.
   Revoked authority does not authorize resubmission or bypassing Policy. An
   unresolved order under a revoked Grant remains an operator investigation;
   automated privileged reconciliation is not implemented.
7. Exercise the existing recovery tests against an isolated target-like database,
   then verify backup/restore there. Never run destructive test schema setup or
   fault injection against the production database.

## Repeatable local checks

```sh
npm ci
npm run build
npm run typecheck
# Use an isolated local/test PostgreSQL database, never production.
TEST_DATABASE_URL=postgresql://... npm test
npm audit --omit=dev
```

Browser tests require the pinned Playwright Chromium installation and its native
libraries. They must run with an actual browser and PostgreSQL; a passing report
with skipped integration tests is not release evidence. The full local suite at
this checkpoint passed 173 tests with zero failures/skips.

Live deployment, authenticated provider execution, funded settlement, backup
restore on the target host, and external security review remain unclaimed.
