CREATE TABLE experience_traces (
 case_id text PRIMARY KEY REFERENCES cases(id), user_id text NOT NULL,
 shape text NOT NULL, structure_hash text NOT NULL, structure jsonb NOT NULL,
 metrics jsonb NOT NULL, trace jsonb NOT NULL, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_experience_trace BEFORE UPDATE OR DELETE ON experience_traces FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
CREATE TABLE experience_playbooks (
 id text PRIMARY KEY, user_id text NOT NULL, shape text NOT NULL, structure_hash text NOT NULL,
 structure jsonb NOT NULL, stage text NOT NULL CHECK(stage IN ('CANDIDATE','VERIFIED','PROVEN','COMPILED_CANDIDATE','COMPILED')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,shape,structure_hash)
);
CREATE TABLE experience_promotions (
 id bigserial PRIMARY KEY, playbook_id text NOT NULL REFERENCES experience_playbooks(id),
 operator_id text NOT NULL REFERENCES human_operators(id), from_stage text NOT NULL,
 to_stage text NOT NULL, verified_runs integer NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_experience_promotion BEFORE UPDATE OR DELETE ON experience_promotions FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
