# Axis

Conversational commerce for Nigeria. One chat — order food, send a gift, shop —
and the agent does the rest. WhatsApp first, but built so WhatsApp is a *channel*,
not the architecture.

This repo is the backend: the agent brain, the conversation state machines, the
channel adapters, and the supply-provider interfaces.

---

## Why it's built this way

Three principles, each a direct response to how this market actually works:

1. **Channel-agnostic core.** WhatsApp, Telegram, and a console harness all feed
   the *same* pipeline. No single platform owns the business. Adding SMS, voice,
   or USSD later is a new adapter, not a rewrite.

2. **Providers behind an interface.** Delivery supply (Glovo today, Chowdeck
   Relay later) sits behind one `DeliveryProvider` port. A stub implementation
   runs the entire flow with **no credentials**, so you can build and demo before
   any partnership lands. Swapping stub → live is one line in the provider
   registry; not a single handler changes.

3. **Every conversation is known.** A recorder logs every inbound and outbound
   message to a store, exposed over admin routes. Visibility is built in, not
   bolted on.

---

## Architecture

```
             ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
  WhatsApp ──▶             │   │             │   │             │
  Telegram ──▶  Channel    │──▶│  Pipeline   │──▶│  Vertical   │
  Console  ──▶  adapters   │   │  (router +  │   │  handlers   │
             │             │◀──│  recorder)  │◀──│  (state     │
             └─────────────┘   └──────┬──────┘   │  machines)  │
                                      │          └──────┬──────┘
                              ┌───────▼──────┐   ┌──────▼──────┐
                              │ Session +    │   │ Providers   │
                              │ Conversation │   │ (Glovo /    │
                              │ stores       │   │ stub / …)   │
                              └──────────────┘   └─────────────┘
```

A message's journey:

1. **Channel adapter** parses the webhook into a normalised `InboundMessage`.
2. **Pipeline** records it, then **routes** it — respecting any in-progress flow
   and global commands (cancel / menu / help).
3. The **vertical handler** (delivery, gifting, affiliate) advances its state
   machine and returns replies + a session patch.
4. The pipeline persists the patch, records the outbound replies, and hands them
   back to the adapter to render.

### Directory map

```
src/
  core/         types, config, logger, money (kobo), ids, location, recorder
  store/        session + conversation stores (in-memory; swap for a DB)
  providers/    DeliveryProvider port + Glovo adapter, stub, affiliate
  handlers/     vertical state machines + demo catalog
  router/       intent routing, pipeline, menu, button mapping
  channels/     WhatsApp + Telegram adapters
  server.ts     Express app + webhooks + admin routes
  console.ts    terminal harness (no credentials needed)
tests/          pipeline integration tests
```

---

## Quick start

```bash
npm install
cp .env.example .env        # optional — runs fine empty on the stub

# Talk to it in your terminal (no credentials required):
npm run console
```

Then type:

```
chicken wings from Nadia
yes
Lekki Phase 1
yes
```

You'll get an availability + price check, a delivery quote with an itemised
total, and an order confirmation with a tracking link — all on the stub.

### Run the server

```bash
npm run dev        # watch mode
# or
npm run build && npm start
```

- `GET  /health` — status + which channels are live
- `GET/POST /webhooks/whatsapp` — Meta verification + inbound
- `POST /webhooks/telegram` — inbound
- `GET  /admin/users` — everyone who's messaged
- `GET  /admin/conversations/:channel/:userId` — full transcript
- `GET  /admin/feed?since=<ms>` — recent events across all users

> **Protect the `/admin/*` routes before deploying.** They're open in this build
> for local visibility.

### Tests

```bash
npm test           # 7 integration tests over the real pipeline
```

---

## What's real vs. stubbed

| Piece | State | Notes |
|---|---|---|
| Agent pipeline, routing, state machines | **Real** | Fully working, tested |
| Conversation logging / admin views | **Real** | In-memory store |
| WhatsApp adapter | **Real** | Cloud API; needs token to send |
| Telegram adapter | **Real** | Bot API; free |
| Delivery via **stub** | **Real (fake data)** | Works with no creds |
| Delivery via **Glovo** | **Written, unverified** | Matches documented LaaS shape; every network call marked `// VERIFY:`. Needs sandbox creds to confirm field names |
| Affiliate links (Jumia/Oraimo) | **Real** | Tracked search links; add your tags |
| Vendor catalog | **Demo** | Hard-coded vendors in `handlers/catalog.ts`. Replace with real onboarded merchants |
| Geocoding | **Placeholder** | `core/location.ts` jitters a Lagos coord so the stub can quote. **Must** add real geocoding before live orders |
| Payments | **Not built** | Confirm step is where a non-custodial rail (e.g. a Solana Blink / Paj) issues a payment link and dispatch waits on settlement |

> The stub's delivery prices look high (per-km rate against the placeholder
> geocoder). That's cosmetic — real quotes come from the provider.

---

## Boundaries this codebase keeps

Every integration here fulfils orders through **your own catalog**, the **stub**,
or **legitimately public / permissioned** surfaces (Glovo's LaaS API, affiliate
deep links). There is no scraping of private consumer APIs and no handling of
users' third-party login credentials. When a partnership or Relay access lands,
it implements `DeliveryProvider` and slots in behind the same interface — which
is also the version that survives contact with a provider who notices you.

---

## Extending it

- **New vertical** (e.g. bills/airtime): add a handler implementing
  `VerticalHandler`, register it in `handlers/index.ts`, add keywords to
  `router/intent.ts`.
- **New channel** (e.g. voice/USSD): implement `ChannelAdapter`, add a webhook
  in `server.ts`. The pipeline is untouched.
- **New delivery provider** (e.g. Chowdeck Relay): implement `DeliveryProvider`,
  add it to the registry in `providers/index.ts`.
- **Real persistence**: implement `SessionStore` / `ConversationStore` against a
  database and swap the two lines in `store/index.ts`.
- **Smarter intent**: replace the keyword matcher in `classifyFresh`
  (`router/intent.ts`) with an LLM classifier — the seam is isolated.

---

## Status

Checkpoints 1–7 committed. Core is complete and tested end to end on the stub.
Next real-world steps are: Glovo sandbox credentials to verify that adapter,
real geocoding, a payment rail at the confirm step, and replacing the demo
catalog with onboarded vendors.
