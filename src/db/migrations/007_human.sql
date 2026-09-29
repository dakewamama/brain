CREATE TABLE human_operators (
 id text PRIMARY KEY, user_id text NOT NULL, token_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE human_tasks (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES cases(id), action_id text UNIQUE NOT NULL REFERENCES actions(id),
 user_id text NOT NULL, purpose text NOT NULL, allowed_context jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('REQUESTED','ASSIGNED','RESOLVED','EXPIRED','CANCELLED')),
 assigned_operator text REFERENCES human_operators(id), deadline timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, response jsonb
);
CREATE TABLE human_audit (
 id bigserial PRIMARY KEY, task_id text NOT NULL REFERENCES human_tasks(id), operator_id text,
 operation text NOT NULL, payload jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_human_audit BEFORE UPDATE OR DELETE ON human_audit FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
