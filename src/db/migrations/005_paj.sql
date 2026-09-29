CREATE TABLE paj_quotes (
 id text PRIMARY KEY,
 user_id text NOT NULL,
 grant_id text NOT NULL REFERENCES agent_grants(id),
 request jsonb NOT NULL,
 rate jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE TRIGGER immutable_paj_quote BEFORE UPDATE OR DELETE ON paj_quotes FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
CREATE TABLE paj_orders (
 action_id text PRIMARY KEY REFERENCES actions(id),
 user_id text NOT NULL,
 grant_id text NOT NULL REFERENCES agent_grants(id),
 direction text NOT NULL CHECK(direction IN ('on','off')),
 quote_id text NOT NULL REFERENCES paj_quotes(id),
 provider_id text UNIQUE,
 response jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE paj_webhooks (
 digest text PRIMARY KEY,
 action_id text NOT NULL REFERENCES paj_orders(action_id),
 provider_id text NOT NULL,
 payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_paj_webhook BEFORE UPDATE OR DELETE ON paj_webhooks FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
