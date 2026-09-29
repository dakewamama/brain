# MCP execution slice: validation and next-build strategy

Updated 2026-09-29 after the user resumed the preservation milestone.
Branch `runtime/mcp-gateway` is stacked on `runtime/case-core`.
[Draft PR #14](https://github.com/dakewamama/brain/pull/14) remains unmerged.

## Coherent commit sequence

Foundation `01d3d31` validated real PostgreSQL durability and fixed duplicate-action
snapshot races and concurrent event/attempt ordering on `runtime/case-core`.

1. `367f0e6`: persisted delegated Grants and scoped Context.
2. `c1b147f`: governed Capability Registry and deterministic policy.
3. `9606002`: persisted Proof required for Case completion.
4. `f5694d0`: immutable preparations, Gateway, reservations and cancellation.
5. `da26221`: shared capability storage; disabled legacy MCP bypass.
6. `2641ef7`: official SDK server/client, allowlists and native adapters.
7. `b06d24c`: preservation checkpoint and remaining strategy.
8. `35481a8`: interrupted Action recovery without replaying effects.
9. `dafb486`: Proof bound to immutable facts; serialized migrations.
10. `d8baa96`: compiled cross-process MCP and official filesystem integration.
11. `4e73b36`: atomic cancellation/history, graceful drain, upstream boundary
    checks, context ownership, and fail-closed live airtime availability.

## Validation

- `npm run build`: passes strict TypeScript and packages SQL migrations.
- Full `TEST_DATABASE_URL=... npm test`: **145 passing, 0 failing, 0 skipped**,
  using an actual local PostgreSQL 16 server.
- Native external MCP client: authenticate, authorized search, preparation,
  execution, durable status, scoped Context, Evidence and Proof.
- Official filesystem upstream: actual LIVE file read inside an approved directory;
  unauthorized resources, hidden write tools and directory escape are rejected.
- Two compiled service processes: simultaneous migrations, duplicate execute,
  execute/cancel race, restart, stable Action and persisted Proof.
- SIGKILL after provider acceptance: recovery requeries the original identity;
  one purchase, one Action, final settlement. No replay of the purchase call.
- Financial timeout retains reservations; correlated requery settles them.
- Expired/revoked authority, missing scope, grant ceilings, stale context,
  malformed controls, missing/stale Proof, oversized upstream output and schema
  drift are covered. Shutdown waits for active work before closing dependencies.
- `git diff --check` passes. No lint command is configured.

An initial final-suite run timed out during compiled startup while compilation
was still running. After the SDK stream type error was fixed and the build
finished, the full suite passed. Tests and assertions were not weakened.
No production purchase, live Photon/Serper request or custody success is claimed.

## Architecture and execution boundary

The eight primitives remain Case, Capability, AgentClient/Grant, Scoped Context,
Policy, Money, Proof and MCP Gateway. MCP handlers call the transport-independent
Gateway; they contain no provider execution path. The six tools are
`axis.prepare`, `axis.execute`, `axis.status`, `axis.cancel`,
`axis.capabilities.search` and `axis.capabilities.invoke`.

Credentials resolve persisted client/grant/user authority internally. Preparations
are immutable, expire and bind a digest. V1 prepares one capability Action;
missing arguments remain missing rather than being invented. Dispatch reloads
Grant and policy, records the stable Action/attempt, and supplies only requested,
authorized Context. Registry invocation cannot call adapters directly.

Evidence precedes verification. Verification binds the current Action, provider
attempts, evidence and reservation facts. New attempts/facts invalidate old Proof.
Generic completion cannot accept a playbook's success assertion alone.
Ambiguous writes remain IN_DOUBT; insufficient evidence remains VERIFYING.

Queueing and safe cancellation commit their state and history atomically.
Cancellation releases an unsubmitted reservation; submitted or irreversible work
returns CANNOT_CANCEL with reconciliation/compensation guidance. No unsupported
provider cancellation or compensation is claimed.

Upstream discovery admits only operator-approved servers and exact tools.
Provenance, resources, mode, schemas, scopes and health remain explicit. SDK stdio
and Streamable HTTP are used; HTTP greeting and slow-call servers are test
fixtures. The useful integration is one official filesystem server. Schema drift
requires operator refresh; disconnection removes tools from search while owned
historical status remains accessible.

The existing runtime abstraction and worker are preserved. Legacy channel code is
not mounted by the MCP entrypoint and is outside its security guarantees.

## Availability

| Family | Mode and boundary |
| --- | --- |
| location.context | LIVE, granted fresh Context only |
| location.search | LIVE with configured approved Photon endpoint; otherwise UNAVAILABLE |
| money.balance | Explicit configured LIVE/SANDBOX custody; otherwise UNAVAILABLE |
| telecom.airtime.purchase | SANDBOX only; LIVE deliberately UNAVAILABLE |
| money.transfer | UNAVAILABLE pending stable provider identity/settlement contract |
| commerce.search | LIVE with Serper credentials; observations, not offers |
| commerce.quote | Authoritative injected provider interface; default UNAVAILABLE |
| apps.documents.read | UPSTREAM_MCP / LIVE with approved filesystem directory and resource Grant |
| MOCK / HANDOFF | MOCK only in tests; no HANDOFF execution adapter in this slice |

Production rejects MOCK and SANDBOX. No commerce.purchase exists.

## P0 boundary and next work

No known failing P0 test remains in the enabled slice. Live airtime is intentionally
blocked: an NGN face-value reservation does not bound a custody USDC debit with
conversion/margin. Keep it UNAVAILABLE until the existing provider offers an
authoritative debit/fee bound that Axis can enforce. This work does not authorize
new Onboarding features or a payment rewrite.

P1 work, in order:

1. Provision operator-issued Grants and one approved filesystem directory in the
   target environment; run the same external-client smoke path there. Keep secrets
   out of descriptors, URLs and committed files. For wider enrollment, integrate
   a real issuer/consent flow using SDK facilities; no bespoke OAuth stack.
2. Add an operator reconciliation procedure for revoked Grants with unresolved
   effects. Revocation fails closed; it must not silently authorize new work.
   Add provider cancellation/compensation only where a legitimate contract exists.
3. Validate configured Photon, Serper and custody contracts with authorized
   credentials. Supply a legitimate authoritative quote provider before enabling
   quotes. Preserve explicit UNAVAILABLE instead of fabricating commerce outcomes.
4. Enable live financial effects only after authoritative debit bounds, stable
   identity, final money state and independent proof are testable end to end.
5. Migrate remaining legacy callers only when requested; never expose their direct
   execution routes alongside the governed MCP deployment.

Strategy: reproduce each new invariant with an adversarial database/external
client test, make the smallest shared change, validate, commit and push it before
adding breadth. Keep draft PRs unmerged. Do not add another planning framework.

WhatsApp, Merchant Bridge, voice, Iya Seun, social commerce, private Bolt/Chowdeck
APIs, Jev, A2A, process mining, Hatchet migration and frontend redesign stay deferred.
