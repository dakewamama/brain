# Execution fallback and Experience v1

The branch `runtime/experience-execution` is stacked on `runtime/mcp-gateway`.
The eight existing execution primitives remain unchanged. Four additions attach
to them: one external catalog adapter, browser capabilities, durable human tasks,
and Experience. There is no new planner or workflow engine.

## Execution

All invoked steps still run through AgentClient, Grant, scoped Context, Registry,
Policy, durable Action, ProviderAttempt, Evidence and Proof. The same six MCP tools
remain exposed. `axis.prepare` now additionally accepts a bounded parameterized
sequence through `constraints.taskShape`, `parameters` and optional `steps`.

```json
{
  "goal": "Update and verify a document",
  "constraints": {
    "taskShape": "document_update_v1",
    "parameters": {
      "session": "operator-issued-session-id",
      "path": "/",
      "field": "#title",
      "button": "#save",
      "result": "#result",
      "title": "A new title",
      "before": 0,
      "after": 1
    },
    "steps": [
      {
        "capabilityId": "apps.documents.edit",
        "fallback": ["browser.act"],
        "bindings": {
          "sessionId": "session", "path": "path", "selector": "field",
          "clickSelector": "button", "verifySelector": "result",
          "expected": "title", "value": "title", "revision": "before"
        }
      },
      {
        "capabilityId": "browser.verify",
        "bindings": {
          "sessionId": "session", "path": "path", "selector": "result",
          "expected": "title", "revision": "after"
        }
      }
    ]
  }
}
```

`steps` are candidates, never authority. Use capability schemas to choose bindings;
the example assumes the preferred structured capability is unavailable. A step
may instead specify `query` for bounded authorized discovery. Selection orders
native structured capabilities before external API/MCP, then browser, then human.
Only known unavailability allows preparation-time fallback. There is no automatic
fallback/resubmission after an ambiguous external write. A selected step that
fails stops the Case; it does not silently try another irreversible surface.

V1 sequences contain two to eight non-financial steps. Existing single financial
Actions retain their established path. Every sequence Action is recorded with a
stable identity before dispatch. Authority, schema, resource, Context and approval
checks repeat for each dispatched step. Missing write evidence stops progression
at VERIFYING. Multi-step financial composition is deliberately not claimed.

## External catalog: Composio only

`ExternalCapabilitySource` normalizes discovery, schema, connection ownership,
health and invocation. The concrete adapter uses Composio's official v3.1 REST
contracts, pins the discovered tool version and normalizes schema maps into JSON
Schema. No vendor-specific types enter the Gateway. No Nango integration exists.

Set `COMPOSIO_API_KEY` and an operator allowlist in `AXIS_COMPOSIO_TOOLS`:

```json
[{
  "capabilityId": "apps.documents.lookup",
  "toolId": "YOUR_VERIFIED_REMOTE_TOOL_SLUG",
  "accountId": "YOUR_CONNECTED_ACCOUNT_ID",
  "userId": "AXIS_USER_OWNING_THAT_CONNECTION",
  "scopes": ["documents.read"],
  "risk": "read",
  "mode": "LIVE"
}]
```

The tool slug is intentionally a placeholder, not a fabricated Composio action.
Use the actual connected tool and its current schema. The Grant also needs
`catalog:composio:<accountId>` in resources. The connection owner must match the
internally resolved Axis user. Connected-account credentials are never returned.
At most 20 explicitly approved tools are registered; discovery never grants
access. Connection health is refreshed for search/preparation and before execution.

Vendor `successful:true` suffices only for a validated read response. Generic
external writes remain VERIFYING without a dedicated authoritative verification
contract. No hidden follow-up tool call bypasses Action recording. Timeouts are
FAILED for reads and IN_DOUBT for writes, with no repeat write submission.

Composio contract tests use controlled responses. No Composio API key or connected
account was supplied in this workspace; no live SaaS invocation is claimed.

## BrowserProvider: Playwright / Chromium

The available environment had no Stagehand model key or Browserbase credentials.
The implementation uses existing Playwright infrastructure and real local Chromium,
with persistent server-owned profiles. It exposes `browser.observe`, `browser.act`,
`browser.extract` and `browser.verify` as Registry capabilities.

Provision a session using `npm run admin -- browser-session /secure/session.json`:

```json
{
  "userId": "existing-axis-user",
  "origin": "https://approved.example",
  "paths": ["/approved-page"],
  "selectors": ["#title", "#save", "#result"],
  "mode": "LIVE",
  "expiresAt": "2030-01-01T00:00:00.000Z"
}
```

Choose a suitable actual expiry. Set `AXIS_BROWSER_PROFILE_DIR` to protected
persistent storage and `AXIS_BROWSER_MODE` to LIVE or SANDBOX. Grant the matching
capability scopes and `browser:<sessionId>` resource. LIVE session origins require
HTTPS. SANDBOX sessions cannot execute in production or masquerade as LIVE.

Sessions are user-owned, expire, and serialize access with a PostgreSQL row lock.
A revision detects stale session actions. Operators allow exact origins, navigation
paths and selectors. Cross-origin traffic, password fields, arbitrary JavaScript
and downloads are blocked. Cookie/profile data never becomes capability output.
Observe/extract returns only the permitted selector's text, not full page memory.

`act` performs the permitted fill/click and independently reloads website state.
Only an observed matching postcondition supplies write proof. A missing expected
state remains VERIFYING. A subsequent `verify` can separately confirm it. Evidence
contains exact URL, selector, observed text, time, session and revision. Browser
errors/timeouts never become successful task completion. An interrupted write is
not automatically replayed. Persistent profiles must survive host restarts.

This is suitable for explicitly reviewed website surfaces. It does not solve
CAPTCHAs, perform login bypasses, reverse-engineer private APIs, or promise safe
arbitrary-web automation. No production website was changed during validation.

## HumanTask and WAITING_HUMAN

`human.request` is a governed write capability with a purpose, optional requested
Context classes and a deadline. Its stable Action is also the unique task key.
Only the scoped Context supplied to the capability is persisted for the operator.

Task fields include Case/Action/user, purpose, allowed Context, status, assigned
operator, deadline, creation/resolution timestamps and structured response. States
are REQUESTED, ASSIGNED, RESOLVED, EXPIRED and CANCELLED. V1 assigns the operator
atomically at resolution; there is no dispatch marketplace.

Provision a distinct operator credential using `operator-issue` with userId and
expiresAt, then supply it as `AXIS_OPERATOR_TOKEN`:

```sh
npm run admin -- human-read /secure/task.json
npm run admin -- human-resolve /secure/resolution.json
```

Read input is `{"taskId":"..."}`. Resolution adds:

```json
{
  "taskId": "...",
  "response": {
    "decision": "confirm",
    "evidence": {"reference": "inspection-reference", "description": "What was checked"}
  }
}
```

Operators are user-scoped, revocable and expiring; AgentClient credentials cannot
resolve tasks. Resolution is audited and writes authenticated participant Evidence.
Duplicate identical resolution is idempotent; conflicting resolution is rejected.
It queues the same Case once. It never sets COMPLETED. The worker resumes the
same Action via requery, then continues the sequence and ProofGate. Human review
is evidence of that decision, not independent proof of an external effect.

Deadlines wake the existing worker and mark unresolved tasks EXPIRED. Safe Case
cancellation invalidates pending tasks. Irreversible prior work still prevents
false cancellation. Tests resolve a persisted task in a separate Node process.

## Experience, privacy and promotion

`experience_traces` stores owner/Case linkage separately from parameterized
procedure structure. Structure contains capability IDs, argument-to-parameter
bindings, schema/version/provider/mode digests, postconditions and fallback reasons.
It does not copy titles, addresses, phone numbers, credentials or raw Context.
All reusable objects are private to their user in V1; there is no global sharing.

Trace metadata records Context classes, provider classes/modes, Action sequence,
transitions, failures/requeries, human intervention, Evidence kinds, Proof verdict
and metrics. Private inputs and receipts remain in the original authorized Case.
Costs remain null where no authoritative cost exists. Clock-skewed wall durations
are reported as unavailable, not negative or fabricated savings.

A successful Case is captured only after persisted current Proof. Capture and
candidate insertion are idempotent. If capture is interrupted after completion,
preparation repairs missing captures before retrieval. Promotion rechecks the
underlying Cases' current Proof; a model cannot promote a procedure.

| Transition | Required independent verified Cases | Additional gate |
| --- | --- | --- |
| CANDIDATE → VERIFIED | 1 | Authorized operator approval |
| VERIFIED → PROVEN | 2 | Same parameterized structure and compatible schemas |
| PROVEN → COMPILED_CANDIDATE | 3 | Explicit postconditions and current Proof |
| COMPILED_CANDIDATE → COMPILED | 3 | Separate operator approval |

Operator commands: `experience-list` with `{}`, and `experience-promote` with
`{"playbookId":"...","stage":"VERIFIED"}` (or the next permitted stage).
They use the same configured capability catalog as the service and audit operator,
transition, supporting run count and timestamp. Skipping stages is rejected.

Before discovery, exact task-shape matching checks private compiled procedures,
then promoted Playbooks, then supplied novel candidate steps. Current capability
schemas, versions, modes and permissions must match. Parameters are rebound for
the new Case; no previous private argument is reused. All Actions are created
anew under current authority. The compiler is only a validated bounded sequence,
not a code generator or a new reasoning framework.

## Acceptance and limits

`tests/gateway/experience.test.ts` drives a real external SDK client through MCP:
Composio contract-fixture lookup → structured edit unavailable → real Chromium
website update → durable human review → separate browser verification → Proof →
Experience. It promotes a Candidate, repeats with a different private title, then
checks three-run eligibility and a fourth compiled execution.

The measured reduction is one discovery search to zero, with four Actions in each
run. Both runs make zero LLM calls; this does not demonstrate model-call savings.
Monotonic test duration is recorded separately from database wall timestamps.
See `docs/EXPERIENCE-ACCEPTANCE.json` for the final captured sample.

No live Composio or PAJ credentials were supplied. Browser validation is a real
local sandbox, not Browserbase or a production website. Live catalog deployment
still needs authenticated contract and connection validation. Unproven vendor
writes intentionally cannot complete. More complex conditional graphs, global
procedure sharing, multi-action money and automatic promotion remain out of scope.

WhatsApp, Merchant Bridge, voice, Iya Seun, Twilio, private Bolt/Chowdeck APIs, PM4Py,
process mining, Jev, multi-agent systems, workflow-engine migration and frontend
redesign remain deliberately deferred.
