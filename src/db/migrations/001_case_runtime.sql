-- Axis Case runtime, migration 001: cases, events, actions, attempts,
-- reservations, evidence, inbound dedupe, decisions.
--
-- Money invariants encoded here:
--  - actions.idempotency_key is UNIQUE: the same business action can never be
--    recorded twice, no matter how many times a retry arrives.
--  - inbound_events (channel, provider_message_id) is UNIQUE: a replayed webhook
--    is one row. Dedupe (INSERT ... ON CONFLICT DO NOTHING) decides processing.
--  - reservations is 1:1 with actions (UNIQUE action_id): one financial effect
--    per action, transitions reserved -> captured/released/in_doubt/reversed.

CREATE TABLE cases (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  channel text NOT NULL,
  goal text NOT NULL,
  playbook text NOT NULL,
  state text NOT NULL,
  status text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  budget_minor bigint,
  deadline_at timestamptz,
  wake_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cases_user ON cases (user_id, created_at DESC);
CREATE INDEX idx_cases_wake ON cases (status, wake_at) WHERE wake_at IS NOT NULL;

CREATE TABLE case_events (
  case_id text NOT NULL REFERENCES cases(id),
  seq bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, seq)
);

CREATE TABLE actions (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases(id),
  capability text NOT NULL,
  status text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_actions_case ON actions (case_id);

CREATE TABLE provider_attempts (
  id text PRIMARY KEY,
  action_id text NOT NULL REFERENCES actions(id),
  seq int NOT NULL,
  provider text NOT NULL,
  mode text NOT NULL,
  request jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL,
  response jsonb,
  provider_ref text,
  error text,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id, seq)
);

CREATE TABLE reservations (
  id text PRIMARY KEY,
  action_id text NOT NULL UNIQUE REFERENCES actions(id),
  owner text NOT NULL,
  amount_minor bigint NOT NULL,
  asset text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases(id),
  action_id text REFERENCES actions(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbound_events (
  id text PRIMARY KEY,
  channel text NOT NULL,
  provider_message_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (channel, provider_message_id)
);

CREATE TABLE decisions (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES cases(id),
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL,
  answer text,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
