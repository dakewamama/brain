# Deploy the existing MCP core

Target: existing Railway project `axis`, production service `brain`, existing
Postgres service and configured DATABASE_URL. Brain's existing public domain is
`brain-production-b15d.up.railway.app`, with target port 8080. No new account,
service or database is required by this package. Billing must be restored before
deployment. No cloud configuration was changed during this packaging pass.

## Image and production configuration

The root Dockerfile builds TypeScript/migrations using Node 22, then installs only
lockfile production dependencies into a separate runtime stage. It runs compiled
Node directly as the non-root `node` user. Source, tests, development dependencies
and environment files are excluded from the final image. The Docker context is
allowlisted by `.dockerignore`. Secrets are injected only at runtime.

Keep the existing database value. Set these variables on Brain when billing is
restored (review existing values first):

```text
NODE_ENV=production
MCP_HOST=0.0.0.0
PORT=8080
MCP_PUBLIC_ORIGIN=https://brain-production-b15d.up.railway.app
```

Use the Dockerfile CMD, `node dist/mcp/main.js`, as the service start command.
Do not start `src/index.ts` or the legacy channel entrypoint. Remove an existing
start-command override if it invokes those paths. Startup applies packaged
migrations under the existing database migration lock before becoming ready.
Back up the target database before applying a new release; never reset its data.

`railway.json` configures this existing service's Dockerfile build, `/health`
readiness and crash restart. Railway's current documentation marks this format
as legacy and supported for existing services until 2026-12-01. Before that date,
move these same service settings to Railway's supported configuration mechanism;
this package does not introduce a new infrastructure framework.

The readiness route checks PostgreSQL and supports Railway's healthcheck Host.
MCP retains host/origin checks and bearer authentication. Railway terminates HTTPS;
Node listens on the assigned internal port. A healthy deployment alone is not
acceptance: run the external-client smoke test below. Railway deployment health
checks are not continuous monitoring.

For this core-only launch, leave Composio, browser sessions and upstream tools
unconfigured unless their actual provider installation and grants have been
reviewed. Existing ONBOARDING_URL does not enable live airtime; missing explicit
provider mode stays unavailable. No PAJ order or Composio write is required.
The image does not include Chromium/native browser libraries or the development
filesystem MCP server; enabling those later requires their runtime installation
and, for browser profiles, persistent private storage.

## Provision a narrow smoke Grant

Use the compiled administration entrypoint on a trusted host/container with the
same DATABASE_URL:

```sh
npm run admin:production -- issue /secure/grant.json
npm run admin:production -- context /secure/context.json
```

Use the shapes in `docs/MCP-SETUP.md` with an existing user, a dedicated client and
a future expiry. Restrict the Grant to:

```json
{
  "scopes": ["location.context", "context:location.coarse"],
  "capabilities": ["location.context"],
  "contextTypes": ["location.coarse"],
  "resources": [],
  "financial": null,
  "requireApproval": false,
  "modes": ["LIVE"]
}
```

Provide an authorized, fresh coarse location Context for that same user. This
proves the real durable native path without creating a financial/provider effect.
The issue command prints a bearer token once; store it in a secret manager, not
Git or deployment logs. Operator provisioning is not available to external MCP.

## External acceptance and restart

In a trusted client environment, set AXIS_MCP_URL to the HTTPS domain plus `/mcp`,
AXIS_SMOKE_TOKEN to the dedicated credential, and AXIS_SMOKE_KEY to a stable
non-secret invocation key. Then run:

```sh
npm run smoke:mcp
```

The script authenticates using the official SDK, checks the six-tool surface,
searches granted capabilities, invokes a coarse-context read twice with the same
identity, waits for COMPLETED and VERIFIED in LIVE mode, and prints only summary
IDs/status. It does not print the token or returned Context. It rejects credential-
bearing URLs and requires HTTPS except for explicit loopback development.

Restart the same deployed service and rerun with the same key and credential.
The returned workId must remain identical. Also confirm unauthorized credentials,
foreign origins and foreign Host values cannot call MCP. Do not redirect the
legacy frontend to this MCP endpoint: it uses a different protocol.

Before billing is restored, local acceptance uses the same compiled app in
production mode with PostgreSQL and a certificate-verified HTTPS reverse proxy.
The fixture checks platform health Host, rejected foreign Host/origin, missing
credentials, external SDK invocation, Proof and restart identity. It also runs
against an isolated installation with production-only dependencies. This validates
the package, not a cloud deployment or an actual Docker image build: Docker is
not installed in this workspace. Railway must build the image after billing.

## Deployment and rollback after billing

Deploy the reviewed pushed revision to the existing `brain` service, keeping
both preservation PRs unmerged. Wait for `/health`, run the smoke test, restart,
and rerun it. If acceptance fails, retain the database and inspect logs; never
resubmit ambiguous financial Actions or run test fixtures on production. Use the
previous known-good deployment only if its schema compatibility is established;
do not roll back migrations or point the legacy runtime at new durable work.

References: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[health checks](https://docs.railway.com/deployments/healthchecks), and
[legacy config reference](https://docs.railway.com/config-as-code/reference).
