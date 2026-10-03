# Axis MCP execution runtime

Axis is a policy-bounded execution runtime. External clients propose work; Axis
resolves delegated authority, records durable Actions, enforces policy, and
requires persisted evidence before declaring completion.

This Experience draft targets `runtime/mcp-gateway`. See [execution and learning](docs/EXPERIENCE.md)
for setup, promotion rules and validation boundaries, and the earlier
[MCP checkpoint](docs/MCP-MILESTONE.md) for foundation limitations.
This is an operator-provisioned execution slice, not a claim that every provider
is production-ready.

## Implemented

- PostgreSQL Cases, ordered events, idempotent Actions and inbound deduplication,
  with tests against a real database and a fresh child process.
- Persisted AgentClients and revocable/expiring Grants. Credentials resolve the
  user internally; external tool input cannot select a trusted user identity.
- Scoped Context with source, freshness, sensitivity, case scope and expiry.
- Capability Registry with bounded, authorized search and governed invocation.
- Immutable preparations, deterministic policy, grant budget reservations,
  stable action identity, evidence, and a central completion ProofGate.
- Six MCP meta-tools using the official TypeScript SDK and Streamable HTTP.
- Explicitly allowlisted upstream MCP tools over stdio and Streamable HTTP.
- External SDK client integration tests covering native context access and the
  official filesystem MCP server, including compiled service restart and two-process
  execution. HTTP reference fixtures remain explicitly SANDBOX.

## Experience milestone

- One allowlisted Composio catalog adapter with connection ownership and health checks.
- Playwright browser capabilities with scoped persistent sessions and observed postconditions.
- Durable `WAITING_HUMAN` tasks, audited operator resolution and restart-safe resume.
- Private parameterized Experience, operator-promoted Playbooks and compiled sequences.

Validation: 167 tests passed against real PostgreSQL, with no skips. The external
MCP acceptance flow used a Composio contract fixture and real sandbox Chromium.
Its second run reused a Playbook: discovery searches fell from 1 to 0, with four
Actions in both runs. Neither run called an LLM. Live Composio credentials remain
unvalidated. See the [captured metrics](docs/EXPERIENCE-ACCEPTANCE.json).

Current productionization evidence and remaining access-dependent checks are in
[release gates](docs/RELEASE-GATES.md).

## Run

Use Node 22 and PostgreSQL 16 or compatible. No new workflow infrastructure is
required. The MCP entrypoint fails closed without its database; it does not use
an in-memory fallback.

```sh
npm ci
# Export configuration from .env.example using your process manager or shell.
npm run build
npm start
```

The compiled build includes SQL migrations. Startup applies them before listening.
The endpoint is `/mcp`; `/health` reports readiness. Default bind is loopback.
External hosting requires `MCP_PUBLIC_ORIGIN`; production requires an HTTPS
origin and an HTTPS reverse proxy. No channel adapter is started by this entrypoint.

## Client access

V1 uses operator-issued opaque bearer credentials bound to a persisted Client and
Grant, not a custom OAuth authorization server. The SDK verifies bearer credentials
through Axis's Grant service. OAuth consent/issuer integration remains deferred;
there is no advertised OAuth flow that does not exist.

Use the local operator CLI with a protected JSON file:

```sh
npm run admin -- issue /secure/grant.json
npm run admin -- context /secure/context.json
npm run admin -- approve /secure/approval.json
npm run admin -- revoke /secure/revocation.json
```

`issue` prints a credential once. Store it securely; do not commit the output.
See [operator and provider setup](docs/MCP-SETUP.md) for exact input shapes.
Every MCP HTTP request needs `Authorization: Bearer <credential>`.

Tools:

- `axis.prepare`: `{goal, constraints?}`; V1 supports one explicit capability/action.
- `axis.execute`: `{preparationId}`.
- `axis.status`: `{workId}`.
- `axis.cancel`: `{workId}`.
- `axis.capabilities.search`: `{query?, region?, limit?, modes?, risks?}`; at most five results.
- `axis.capabilities.invoke`: `{capabilityId, arguments, idempotencyKey}`; the same durable execution path.

Prepare returns missing information instead of inventing arguments, costs or
facts. Search observations are not authoritative merchant offers. Handoff,
unknown status, and provider `success:true` are not automatically proof.

## Validation

```sh
npm run build
npm run typecheck
TEST_DATABASE_URL=postgresql://... npm test
TEST_DATABASE_URL=postgresql://... npm run test:postgres
```

`test:postgres` refuses to run without a real database URL. Ordinary `npm test`
marks database suites skipped when no test URL is provided. Use a disposable test
database: suites write test records and create/drop an isolated MCP test schema.
There is no configured lint command.

## Capability availability

| Capability | Mode / requirements |
|---|---|
| `location.context` | LIVE, native; only current, granted context |
| `location.search` | LIVE with configured Photon provider; otherwise UNAVAILABLE |
| `money.balance` | Explicit LIVE/SANDBOX onboarding mode and credentials; otherwise UNAVAILABLE |
| `telecom.airtime.purchase` | SANDBOX only with credentials and wallet/recipient grants; LIVE is UNAVAILABLE until custody enforces an authoritative debit/fee bound |
| `money.transfer` | UNAVAILABLE: existing off-ramp lacks required identity/settlement contract |
| `commerce.search` | LIVE with Serper credentials; observations only |
| `commerce.quote` | Replaceable authoritative provider interface; default UNAVAILABLE |
| PAJ ramps / quote / status / bank lookup | Independent provider configuration; see [PAJ contracts and validation](docs/PAJ.md) |
| Upstream apps | UPSTREAM_MCP with separate LIVE/SANDBOX provider provenance; only configured tools are admitted |

No commerce purchase is implemented. MOCK providers exist only in tests and are
not admitted in production. HANDOFF never becomes completed delivery.

## Preserved legacy code

The conversational entrypoint is retained behind `npm run legacy:dev` and is
explicitly outside the MCP release's security claim. Do not expose it alongside
MCP in production. SkillRegistry and CaseRunner compatibility registrations use
the shared CapabilityRegistry storage; those legacy entries are unavailable to
the Gateway until migrated. Legacy automatic MCP execution is disabled.

Onboarding is unchanged. WhatsApp, Merchant Bridge, voice, Iya Seun, social
commerce, private Bolt/Chowdeck integrations, Jev, A2A, process mining, Hatchet
migration and frontend redesign remain deferred.
