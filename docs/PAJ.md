# PAJ provider contract and validation boundary

Inspected Brain legacy payment skills and every PAJ adapter, route, status,
webhook, store and configuration file in Onboarding. Also retrieved PAJ's
[official OpenAPI](https://docs.paj.cash/api-reference/openapi.json),
[onramp](https://docs.paj.cash/concepts/onramp),
[offramp](https://docs.paj.cash/concepts/offramp) and
[rates](https://docs.paj.cash/concepts/rates) documentation on 2026-09-29.

## Existing implementation, not inferred from names

| Operation | Existing Onboarding contract |
| --- | --- |
| Authentication | v2 `x-api-key`; no OTP/session flow |
| Rates | GET `/pub/v2/rate?currency=...`, separate directional rates |
| Bank lookup | GET `/pub/v2/bank-account`, existing account by number/address |
| Bank storage | POST `/pub/v2/bank-account`, provider confirms and returns stable address |
| Onramp | Not previously implemented; official POST `/pub/v2/onramp` documented |
| Offramp | POST `/pub/v2/offramp`; crypto funding then fiat payout |
| Payment | POST `/pub/v2/payment`, payment collection, not a generic transfer |
| Bank transfer | No independent balance-to-bank transfer contract found |
| Status/history | No GET order or transaction history in the published v2 API |
| Webhook | HMAC-SHA256 timestamp + raw body; existing local file correlation |
| Identity | No documented order idempotency header/reference field |
| Reconciliation | Existing adapter only checked locally recorded signed settlement |

Brain's `pay_person` called `/offramp`. It was not a direct bank transfer.
No Onboarding or airtime code was changed for this adapter.

## MCP adapter

`PajProvider` registers `ramp.on`, `ramp.off`, `ramp.quote`, `ramp.status`, and
`bank.resolve` with provider `paj`, kind `external_api`. `money.transfer.bank`
is explicitly UNAVAILABLE. PAJ is independent of airtime and other rails.

Preparation performs only bank lookup and authoritative rate reads, then persists
an immutable, user/Grant-bound rate observation. PAJ's rate includes business
spread but is indicative, not locked. Axis neither invents a payout nor applies
its own conversion/margin. Observations expire after two minutes; a changed rate
requires preparation again. V1 deliberately supports USDC / Solana / NGN only.

Orders have a durable submission tombstone before POST. Axis never repeats that
POST for the same Action, including when its response is lost. A per-order,
unguessable callback URL plus PAJ's raw-body signature allows correlating a lost
response. Provider IDs and signed events live in PostgreSQL; event fingerprints
are unique. The existing worker consumes persisted status through the existing
Action, Policy, Evidence and Proof path. There is no fabricated remote status URL.
Without a callback, an ambiguous submission remains IN_DOUBT for operator review.

Creation is WAITING_EXTERNAL, not success. Funding instructions come from PAJ.
The caller funds from an external bank/wallet; this adapter does not call a
custody signer. Temporary offramp addresses stop being displayed after PAJ's
stated two-hour funding window; onramp instructions expire after 72 hours.
A successful order response never completes the Case. Signed COMPLETED evidence
must match order, direction, destination, asset/network, amount and debit bound,
and include transaction evidence. PAJ ERROR does not prove a refund: funds remain
IN_DOUBT instead of being automatically released or resubmitted.

Financial Grants retain `asset`, `perActionMinor`, `totalMinor`, capability and
expiry controls; PAJ additionally requires `allowedAssets:["USDC"]` and
`allowedCurrencies:["NGN"]`. Optional `allowedDestinations` narrows recipient
wallets or `bankCode:accountNumber`. Resource grants are also mandatory:
`wallet:SOLANA:<recipient>` or `bank:<accountNumber>`. The reservation is the
maximum delegated exposure, not a replacement for custody accounting.

Inputs: `asset`, `network`, `currency`, `amountMinor`, `maxDebitMinor`, plus
`recipient` for onramp, or `bankCode`/`accountNumber` for offramp. Amount units are
NGN kobo for onramp and USDC base units for offramp. A provider debit outside the
bound is not exposed as safe funding instructions or successful execution.

## Configuration and promotion

Use existing PAJ credentials, never expose them to MCP:

- `PAJ_API_KEY`, `PAJ_ENV=production|staging`
- `PAJ_MINT`: required staging USDC mint; production pins mainnet USDC
- `PAJ_WEBHOOK_SECRET`, `PAJ_WEBHOOK_ORIGIN=https://<axis-host>`
- `PAJ_ENABLED_CAPABILITIES`: comma-separated approved operations, defaults to
  `ramp.quote,bank.resolve,ramp.status`. Explicitly enable ramp creation only after
  validating its exact authenticated contract in the target environment.

Startup validates authentication and the rate response against the selected PAJ
origin. Missing credentials do not select mocks. `production` means LIVE;
`staging` means SANDBOX; disabled/unconfigured operations mean UNAVAILABLE.
These modes are not coupled to another financial provider's readiness.

**Validation performed here:** documented contracts plus PostgreSQL fault injection.
No PAJ credentials were available in the process or repository environment files.
The credential-location question remains unanswered. No authenticated live PAJ
call, sandbox order or funded production order is claimed. Therefore this change
implements the adapter but does not certify a LIVE/SANDBOX promotion for this
workspace. A deployment operator must supply configuration and validate actual
responses before enabling ramps. Read-only bank lookup requires a legitimate
known account; new beneficiary registration is not silently done by `bank.resolve`.

Tests cover rates, bank lookup, both order directions, duplicate execution and
webhooks, lost creation response, stable identity, signed finality, invalid
signature, wrong destination/client, changed/expired quotes, Grant ceilings,
unsupported asset/network, and confirmed ERROR without fabricated refund.

Remaining provider validation: exact fee/debit semantics, final webhook fields,
production/staging credentials, configured webhook delivery, and PAJ support for
operator recovery when no signed event arrives. Late contradictory events after
terminal completion require operator investigation; no automatic reversal is
claimed. Standing-address payouts and transaction-history tools are not exposed.
