CREATE TABLE preparations (
  id text PRIMARY KEY,
  case_id text UNIQUE NOT NULL REFERENCES cases(id),
  grant_id text NOT NULL REFERENCES agent_grants(id),
  client_id text NOT NULL REFERENCES agent_clients(id),
  user_id text NOT NULL,
  invocation_key text,
  request_digest text NOT NULL,
  digest text NOT NULL,
  proposal jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE(grant_id,invocation_key)
);
CREATE FUNCTION immutable_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'preparations are immutable'; END;
$$;
CREATE TRIGGER preparation_immutable BEFORE UPDATE ON preparations FOR EACH ROW EXECUTE FUNCTION immutable_preparation();
CREATE TABLE preparation_approvals (
  preparation_id text PRIMARY KEY REFERENCES preparations(id),
  user_id text NOT NULL,
  digest text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE action_money (
  action_id text PRIMARY KEY REFERENCES actions(id),
  grant_id text NOT NULL REFERENCES agent_grants(id),
  asset text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK(state IN ('RESERVED','IN_FLIGHT','IN_DOUBT','SETTLED','RELEASED','REVERSED','REFUNDED'))
);
