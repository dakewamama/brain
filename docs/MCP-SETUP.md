# MCP operator and provider setup

## Grant input

Create a protected JSON file for `npm run admin -- issue <file>`:

```json
{
  "clientId": "local-client",
  "clientName": "Local MCP client",
  "userId": "existing-axis-user",
  "expiresAt": "2026-10-01T00:00:00.000Z",
  "authority": {
    "scopes": ["location.context", "context:location.coarse"],
    "capabilities": ["location.context"],
    "contextTypes": ["location.coarse"],
    "resources": [],
    "financial": null,
    "requireApproval": false,
    "modes": ["LIVE"]
  }
}
```

Choose a future expiry. User identity is trusted operator input here, never MCP
input. Tokens are random and only their hashes are persisted. A Grant is bound
to one Client and user. No wildcard capability or scope grants are implemented.
Revoke with `{"grantId":"..."}`. Do not commit credentials or token output.

Financial limits, when enabled, use
`{"asset":"NGN","perActionMinor":"10000","totalMinor":"20000"}`. They are
integer minor units. Airtime is SANDBOX only: its NGN face value is not an
authoritative bound on a live USDC custody debit, including conversion and fees.
Airtime requires resources `wallet:self` and `telecom:<phone>`; balance requires
`wallet:self`. Upstream connected-account resource restrictions are explicit in
server configuration and must also be granted.

## Context input

```json
{
  "userId": "existing-axis-user",
  "type": "location.coarse",
  "value": {"country": "NG", "region": "Lagos"},
  "source": "authenticated user",
  "observedAt": "2026-09-28T12:00:00.000Z",
  "expiresAt": "2026-10-01T00:00:00.000Z",
  "sensitivity": "standard",
  "caseId": null
}
```

Use actual observation/expiry times. Ingest using the trusted `context` CLI.
`location.exact` requires a separate explicit grant and uses latitude/longitude.
Coarse values reject coordinates. `preferred_currency`, `spendable_balance`, and
`commerce.preferences` have narrow validated value shapes in `context/service.ts`.
Context is never implicitly supplied to every capability.

## Approval

The `approve` CLI takes `preparationId`, the authenticated user's `userId`, and
the exact preparation `digest`. It is a trusted local operator action. None of
the six MCP tools can issue approvals or create/revoke Grants.

## Approved filesystem upstream

One server maximum is configured through `AXIS_UPSTREAM_MCP`. The pinned official
filesystem server is the useful V1 integration (installed as a development
integration dependency). Provision that executable explicitly if production
installation omits development dependencies. Use an absolute approved directory
and executable path; do not grant the whole host filesystem.

```json
[{
  "id": "approved-docs",
  "transport": "stdio",
  "command": "node",
  "args": ["/absolute/brain/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "/approved/documents"],
  "executionMode": "LIVE",
  "allowedTools": {
    "read_text_file": {
      "capabilityId": "apps.documents.read",
      "risk": "read",
      "requiredScopes": ["documents.read"],
      "resources": ["documents:approved"],
      "outputSchema": {
        "type": "object",
        "properties": {"content": {"type": "string"}},
        "required": ["content"],
        "additionalProperties": false
      }
    }
  }
}]
```

Grant capability `apps.documents.read`, scope `documents.read`, resource
`documents:approved`, and mode `UPSTREAM_MCP`. Invoke with `arguments.path` inside
the approved directory. Discovery does not expose other filesystem tools.
Results are bounded to 64 KiB; schema drift blocks invocation until an operator
reviews/reconnects the adapter. Disconnection hides capabilities from discovery
but does not hide authorized historical status.

Compiled external-client tests exercise actual file reads, directory escape
rejection, independent service processes and restart. The SDK greeting server is
only a SANDBOX HTTP protocol test, not an additional product integration.
Production rejects sandbox upstreams and mock/sandbox native capabilities.

For a legitimate remote server, use HTTPS and optional `tokenEnv` naming the
server-side credential variable. The credential does not appear in capabilities
or client responses. For stdio, use `command`, `args` and `passEnv`; only base
system variables and explicitly named variables reach the child. Operator config
is trusted; agents cannot add servers or tools. Discovery alone registers nothing
unless that exact tool is allowed. Upstream financial tools are not enabled in V1.

For external-write proof, explicit configuration can declare `stateField`,
`expectedState` and `referenceField`. A generic success boolean is insufficient.
This configuration must reflect a verified provider contract, not a model guess.

## References inspected

- [Official filesystem MCP server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

- [Official TypeScript SDK v1 server guide](https://ts.sdk.modelcontextprotocol.io/server)
  and installed stateless HTTP, client and bearer-auth implementations.
- [ACP checkout reference](https://www.agenticcommerce.dev/docs/reference/checkout):
  authoritative provider state and stable idempotency.
- [Photon API](https://github.com/komoot/photon/blob/master/docs/api-v1.md):
  replaceable forward search, GeoJSON responses. Set your approved Photon endpoint.

Axis owns authorization and execution semantics. The SDK owns MCP protocol and
transport behavior; no protocol/OAuth framework was reimplemented.
