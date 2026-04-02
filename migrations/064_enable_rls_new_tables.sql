-- Migration: Enable RLS on new tables created in Phase 2
-- Fixes security linter warnings for internal_model_items, cycle_metrics, session_state

-- ============ internal_model_items ============
ALTER TABLE internal_model_items ENABLE ROW LEVEL SECURITY;

-- Users can only see their own items
CREATE POLICY "Users can view own internal model items"
  ON internal_model_items FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own items
CREATE POLICY "Users can insert own internal model items"
  ON internal_model_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own items
CREATE POLICY "Users can update own internal model items"
  ON internal_model_items FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own items
CREATE POLICY "Users can delete own internal model items"
  ON internal_model_items FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypass for scheduled jobs
CREATE POLICY "Service role has full access to internal model items"
  ON internal_model_items FOR ALL
  USING (auth.role() = 'service_role');

-- ============ cycle_metrics ============
ALTER TABLE cycle_metrics ENABLE ROW LEVEL SECURITY;

-- Users can only see their own metrics
CREATE POLICY "Users can view own cycle metrics"
  ON cycle_metrics FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own metrics
CREATE POLICY "Users can insert own cycle metrics"
  ON cycle_metrics FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own metrics
CREATE POLICY "Users can update own cycle metrics"
  ON cycle_metrics FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role bypass for scheduled jobs
CREATE POLICY "Service role has full access to cycle metrics"
  ON cycle_metrics FOR ALL
  USING (auth.role() = 'service_role');

-- ============ session_state ============
ALTER TABLE session_state ENABLE ROW LEVEL SECURITY;

-- Users can only see their own sessions
CREATE POLICY "Users can view own session state"
  ON session_state FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own sessions
CREATE POLICY "Users can insert own session state"
  ON session_state FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own sessions
CREATE POLICY "Users can update own session state"
  ON session_state FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own sessions
CREATE POLICY "Users can delete own session state"
  ON session_state FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypass for API endpoints
CREATE POLICY "Service role has full access to session state"
  ON session_state FOR ALL
  USING (auth.role() = 'service_role');

-- ============ Comments ============
COMMENT ON POLICY "Users can view own internal model items" ON internal_model_items IS 'RLS: Users can only read their own decay/reinforcement items';
COMMENT ON POLICY "Users can view own cycle metrics" ON cycle_metrics IS 'RLS: Users can only read their own cycle metrics';
COMMENT ON POLICY "Users can view own session state" ON session_state IS 'RLS: Users can only access their own session state';
