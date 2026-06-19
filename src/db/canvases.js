/**
 * Canvases namespace — 2D workspace graphs with document/knowledge nodes.
 *
 * A canvas is a named workspace owned by a user. `addDocument` resolves
 * the workspace + document by name/path and inserts a canvas_node
 * record positioned at (0, 0) with default size.
 *
 * @typedef {object} CanvasesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

export function createCanvasesNamespace(deps) {
  if (!deps) throw new TypeError('createCanvasesNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createCanvasesNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createCanvasesNamespace: firstRow required');

  return {
    async list(userId) {
      const result = await d1Query(
        `SELECT name, description FROM canvas_workspaces WHERE user_id = ? ORDER BY name`,
        [userId],
      );
      return result.results || [];
    },

    async addDocument(userId, canvasName, documentPath) {
      const ws = await d1Query(
        `SELECT id FROM canvas_workspaces WHERE user_id = ? AND name = ?`,
        [userId, canvasName],
      );
      const workspaceId = firstRow(ws)?.id;
      if (!workspaceId) throw new Error(`Canvas "${canvasName}" not found`);

      const doc = await d1Query(
        `SELECT id FROM documents WHERE user_id = ? AND path = ?`,
        [userId, documentPath],
      );
      const docId = firstRow(doc)?.id;
      if (!docId) throw new Error(`Document "${documentPath}" not found`);

      await d1Query(
        `INSERT INTO canvas_nodes (workspace_id, user_id, node_type, ref_id, position_x, position_y, width, height, created_at)
         VALUES (?, ?, 'document', ?, 0, 0, 300, 200, ?)`,
        [workspaceId, userId, docId, new Date().toISOString()],
      );
    },
  };
}
