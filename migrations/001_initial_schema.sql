-- =============================================
-- MYA Personal AI Coach - Initial Schema
-- Uses pgvector with 1024 dimensions for BGE-M3
-- =============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================
-- USERS
-- =============================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    display_name TEXT,
    timezone TEXT DEFAULT 'Europe/Riga',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TAG VOCABULARY (evolving tags)
-- =============================================

CREATE TABLE tag_vocabulary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    description TEXT,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT DEFAULT 'system', -- 'system', 'llama', 'claude'
    UNIQUE(user_id, tag)
);

CREATE TABLE suggested_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    source_message_id UUID, -- Will reference messages(id) after creation
    context TEXT,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'merged'
    reviewed_at TIMESTAMPTZ,
    merged_into TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_suggested_tags_status ON suggested_tags(user_id, status);

-- =============================================
-- ATTACHMENTS
-- =============================================

CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    attachment_type TEXT NOT NULL, -- 'voice', 'image', 'file'
    r2_key TEXT NOT NULL,
    original_filename TEXT,
    mime_type TEXT,
    file_size INTEGER,
    transcript TEXT,
    description TEXT,
    linked_document_path TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- MESSAGES (with Llama tags + BGE-M3 embeddings)
-- =============================================

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'user', 'assistant'
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text', -- 'text', 'voice', 'image', 'forward'

    -- Tagging (from Llama 4 Scout)
    tags TEXT[],
    entities_people TEXT[],
    entities_projects TEXT[],
    suggested_new_tag TEXT,

    -- Embeddings (from BGE-M3, 1024 dimensions)
    embedding VECTOR(1024),

    -- Media
    attachment_id UUID REFERENCES attachments(id),

    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add foreign key for suggested_tags after messages exists
ALTER TABLE suggested_tags
ADD CONSTRAINT fk_suggested_tags_message
FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX idx_messages_created ON messages(user_id, created_at DESC);
CREATE INDEX idx_messages_tags ON messages USING GIN(tags);

-- HNSW index for fast similarity search (better than IVFFlat for most use cases)
CREATE INDEX idx_messages_embedding ON messages
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================
-- LIVING DOCUMENTS
-- =============================================

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL, -- 'identity/mission', 'states/dreams', 'internal/model'
    title TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    is_internal BOOLEAN DEFAULT false, -- True for AI-private documents
    metadata JSONB DEFAULT '{}',
    embedding VECTOR(1024),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, path)
);

CREATE INDEX idx_documents_path ON documents(user_id, path);
CREATE INDEX idx_documents_internal ON documents(user_id, is_internal);
CREATE INDEX idx_documents_embedding ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    diff TEXT NOT NULL,
    changed_by TEXT NOT NULL, -- 'user', 'bot', 'reflection'
    change_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_doc_versions_doc ON document_versions(document_id, created_at DESC);

-- =============================================
-- REFLECTIONS (AI autonomous thinking)
-- =============================================

CREATE TABLE reflections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    flagged_for_discussion TEXT,
    context_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reflections_created ON reflections(user_id, created_at DESC);

-- =============================================
-- TASKS
-- =============================================

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    context TEXT,
    priority INTEGER DEFAULT 3,
    deadline TIMESTAMPTZ,
    status TEXT DEFAULT 'open', -- 'open', 'completed', 'cancelled'
    project_path TEXT,
    source_message_id UUID REFERENCES messages(id),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks(user_id, status, priority);
CREATE INDEX idx_tasks_deadline ON tasks(user_id, deadline) WHERE status = 'open';

-- =============================================
-- PEOPLE
-- =============================================

CREATE TABLE people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    document_path TEXT NOT NULL, -- 'people/una'
    relationship TEXT,
    status TEXT DEFAULT 'active', -- 'active', 'background', 'historical'
    last_mentioned TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);

CREATE INDEX idx_people_status ON people(user_id, status);

-- =============================================
-- SCHEDULED EVENTS
-- =============================================

CREATE TABLE scheduled_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL, -- 'morning', 'evening', 'weekly', 'reflection'
    schedule_cron TEXT,
    enabled BOOLEAN DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    next_trigger_at TIMESTAMPTZ,
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- FUNCTIONS
-- =============================================

-- Increment tag usage count
CREATE OR REPLACE FUNCTION increment_tag_usage(p_user_id UUID, p_tag TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE tag_vocabulary
    SET usage_count = usage_count + 1
    WHERE user_id = p_user_id AND tag = p_tag;
END;
$$ LANGUAGE plpgsql;

-- Semantic search for messages
CREATE OR REPLACE FUNCTION match_messages(
    query_embedding VECTOR(1024),
    match_user_id UUID,
    match_count INT DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    role TEXT,
    tags TEXT[],
    created_at TIMESTAMPTZ,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.id,
        m.content,
        m.role,
        m.tags,
        m.created_at,
        1 - (m.embedding <=> query_embedding) AS similarity
    FROM messages m
    WHERE m.user_id = match_user_id
      AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Semantic search for documents
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding VECTOR(1024),
    match_user_id UUID,
    match_count INT DEFAULT 5,
    include_internal BOOLEAN DEFAULT false
)
RETURNS TABLE (
    id UUID,
    path TEXT,
    title TEXT,
    summary TEXT,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.path,
        d.title,
        d.summary,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM documents d
    WHERE d.user_id = match_user_id
      AND d.embedding IS NOT NULL
      AND (include_internal OR d.is_internal = false)
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE suggested_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by Workers)
CREATE POLICY "Service role full access" ON users
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON messages
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON documents
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON tag_vocabulary
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON suggested_tags
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON reflections
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON tasks
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON attachments
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON people
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON scheduled_events
    FOR ALL USING (true);
CREATE POLICY "Service role full access" ON document_versions
    FOR ALL USING (true);
