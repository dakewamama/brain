CREATE TABLE agent_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE agent_grants (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES agent_clients(id),
  user_id text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  authority jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE scoped_context (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  type text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  sensitivity text NOT NULL,
  required_scope text NOT NULL,
  case_id text REFERENCES cases(id)
);
CREATE INDEX scoped_context_user_type ON scoped_context(user_id, type);
