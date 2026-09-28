CREATE FUNCTION axis_immutable_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Axis evidence and events are immutable'; END;
$$;
CREATE TRIGGER immutable_case_events BEFORE UPDATE OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
CREATE TRIGGER immutable_provider_attempts BEFORE UPDATE OR DELETE ON provider_attempts FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION axis_immutable_fact();
CREATE FUNCTION axis_stable_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR
    NEW.capability IS DISTINCT FROM OLD.capability OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.input IS DISTINCT FROM OLD.input THEN
   RAISE EXCEPTION 'Axis economic action identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER stable_action BEFORE UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION axis_stable_action();
