# MCP milestone and next-build strategy

Checkpoint requested by the user on 2026-09-28; the user subsequently resumed work.
Continue closing the P0 gaps below on `runtime/mcp-gateway` before expanding scope.
This is a stacked draft on `runtime/case-core`; merge neither branch yet.

## Preserved progression

1. `01d3d31` on runtime/case-core: real PostgreSQL validation uncovered and fixed
   snapshot races in duplicate action creation and sequence collisions in event
   and provider-attempt appends. Fresh-process wake/resume and inbound persistence
   now have actual database tests. 119 tests passed at this checkpoint.
2. `367f0e6`: persisted delegated Grants and scoped Context.
3. `c1b147f`: governed capability catalog and deterministic policy.
4. `9606002`: central ProofGate and serialized Case advancement.
5. `f5694d0`: immutable preparations, Gateway execution, budget reservations and
   truthful cancellation. PostgreSQL gateway adversarial tests passed.
6. Subsequent milestone commits: official SDK MCP server/client integration,
   explicit upstream allowlists, compatibility registry consolidation, core
   capability adapters, operator CLI, compiled migration packaging and docs.

## Validation at the milestone

- `npm run build` passes strict TypeScript compilation and packages SQL migrations.
- `TEST_DATABASE_URL=... npm test`: **135 passing, 0 failing, 0 skipped** against
  PostgreSQL 16, including native and upstream external MCP client integration.
- Earlier full regression caught two legacy fixtures lacking capability metadata;
  fixtures were corrected without weakening assertions or schema validation.
- No live financial purchase or production-provider success is claimed.
- `git diff --check` passes. No lint script is configured.

## What works end to end

An external SDK client authenticates using a persisted Grant, lists exactly six
meta-tools, searches authorized capabilities, prepares and executes a native
scoped-location Case, polls durable status and sees persisted evidence plus
verification. It also invokes an allowlisted tool on the official SDK's bundled
reference server over Streamable HTTP. That provider is explicitly SANDBOX.
A stdio fixture verifies the second upstream transport and ambiguous write timeout.

Repeated execute/invoke keeps the same durable Action and does not replay the
purchase. Financial timeout retains its reservation; a correlated trusted-adapter
requery can settle it. Revocation is checked again before dispatch. Cancellation
releases queued reservations only before provider submission; after effects it
reports inability to cancel instead of erasing history.

The MCP app is a separate entrypoint. Legacy channel services are not mounted.
The runtime remains the existing CaseRunner/CaseWorker. No Hatchet migration or
new planning framework was introduced.

## Next build: close correctness gaps before adding integrations

### P0 — crash recovery and production security/accounting review

1. **Closed after milestone:** a real SIGKILL-after-acceptance test now passes.
   The existing worker recovers persisted running Cases under PostgreSQL session
   locks and the Gateway requeries the original request. Purchase count stays one.
   Conditional wake claims prevent stale timer snapshots from reviving cancellation.
   No replacement workflow engine was introduced.
2. Test independent service processes executing and cancelling the same
   preparation. Review atomicity across approval checks, grant revocation,
   reservation updates, attempt recording and terminal verification. Existing
   PostgreSQL tests prove important boundaries, not the full production guarantee.
3. Tighten the financial adapter contract before enabling live spending. Gateway
   airtime limits currently describe the requested NGN face value; custody debits
   USDC and may include conversion/margin. Require an authoritative debit/fee bound
   and correct currency accounting. Do not claim NGN reservations are a replacement
   for the custody ledger or silently expand Onboarding feature scope.
4. Test malicious upstream structured output, schema/version drift, disconnected
   health, result/context retention after grant narrowing, and database outages
   between execution result, evidence and proof. Verify terminal transitions cannot
   reuse stale verification evidence. Complete tests for case-scoped context and
   resource/connected-account restrictions.
5. Review the central ProofGate against actual provider evidence requirements.
   Current checks establish a useful floor, not universal proof of arbitrary
   external writes. The old airtime compatibility playbook remains deprecated and
   is not the new production path.
6. Fail safely on simultaneous migration/startup and graceful shutdown during an
   active provider call. Add a compiled-server restart integration test, not only
   source-level imports and reconstructed repository instances.

Strategy: reproduce each invariant violation with a failing PostgreSQL or external
SDK test, fix the smallest shared primitive, run relevant regressions, commit and
push that coherent change. Keep all eight primitives; add no new subsystem.

### P1 — finish the useful capability slice

- Production AgentClient enrollment/consent with a real auth issuer using SDK
  facilities. Current operator-issued credentials are intentional V1 access,
  not a bespoke OAuth implementation. Approval is a trusted operator path, not
  an agent-supplied boolean.
- Replace the SANDBOX reference upstream with **one** useful approved app server,
  retaining the same allowlist, provenance, grant, Action and Proof path. Do not
  integrate several aggregators.
- Validate configured Photon and Serper adapters against legitimate live/sandbox
  endpoints. Add provider contract tests. No credentials were needed for the
  reference MCP proof; no live purchase was made.
- Supply an authoritative commerce quote provider. Quote remains UNAVAILABLE by
  default, and search-engine prices must never become merchant offers.
- Expose money.transfer only after its existing provider supports stable identity,
  authoritative final status and money reconciliation. Do not fake settlement.
- Finish replacing deprecated direct execution compatibility paths once clients
  migrate. The legacy channel app is not part of this deployment or its security
  guarantee. Do not modify deferred WhatsApp workflows.

## Release gates still apply

Build, strict source TypeScript, real PostgreSQL integration, independent-process
crash recovery, external MCP client tests and all adversarial invariants must pass.
Only then claim the release's full quality invariants. This milestone does not
make that claim. Keep draft PRs unmerged.
