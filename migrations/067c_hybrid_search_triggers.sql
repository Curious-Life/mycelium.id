-- Migration 067c: Triggers to auto-populate fts on INSERT/UPDATE

-- Messages trigger
CREATE OR REPLACE FUNCTION messages_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_fts_update ON messages;
CREATE TRIGGER messages_fts_update
  BEFORE INSERT OR UPDATE OF content ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_fts_trigger();

-- Documents trigger
CREATE OR REPLACE FUNCTION documents_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_fts_update ON documents;
CREATE TRIGGER documents_fts_update
  BEFORE INSERT OR UPDATE OF title, content ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_fts_trigger();

-- Attachments trigger
CREATE OR REPLACE FUNCTION attachments_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english',
    COALESCE(NEW.transcript, '') || ' ' || COALESCE(NEW.description, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attachments_fts_update ON attachments;
CREATE TRIGGER attachments_fts_update
  BEFORE INSERT OR UPDATE OF transcript, description ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_fts_trigger();
