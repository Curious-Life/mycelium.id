/**
 * Obsidian JSON Canvas Parser
 * Handles .canvas files following the JSON Canvas 1.0 specification
 * https://jsoncanvas.org/
 */

// ============ Node Types ============

export interface BaseNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;  // Preset number "1"-"6" or hex "#ff5555"
}

export interface TextNode extends BaseNode {
  type: 'text';
  text: string;
}

export interface FileNode extends BaseNode {
  type: 'file';
  file: string;
  subpath?: string;  // #heading or #^block
}

export interface LinkNode extends BaseNode {
  type: 'link';
  url: string;
}

export interface GroupNode extends BaseNode {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

// ============ Edge Types ============

export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: EdgeSide;
  fromEnd?: EdgeEnd;
  toNode: string;
  toSide?: EdgeSide;
  toEnd?: EdgeEnd;
  color?: string;
  label?: string;
}

// ============ Canvas Structure ============

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// ============ Color Mapping ============

// Obsidian color presets
export const OBSIDIAN_COLOR_PRESETS: Record<string, string> = {
  '1': '#ff5555',  // red
  '2': '#ffaa00',  // orange
  '3': '#ffff55',  // yellow
  '4': '#55ff55',  // green
  '5': '#55ffff',  // cyan
  '6': '#aa55ff',  // purple
};

/**
 * Normalize Obsidian color to hex
 */
export function normalizeColor(color?: string): string | undefined {
  if (!color) return undefined;
  if (color.startsWith('#')) return color;
  return OBSIDIAN_COLOR_PRESETS[color] || undefined;
}

// ============ Parsing ============

/**
 * Parse a JSON Canvas file
 */
export function parseCanvas(json: string): Canvas {
  const data = JSON.parse(json);

  return {
    nodes: (data.nodes || []).map(normalizeNode),
    edges: (data.edges || []).map(normalizeEdge),
  };
}

function normalizeNode(node: Record<string, unknown>): CanvasNode {
  const base = {
    id: String(node.id),
    x: Number(node.x) || 0,
    y: Number(node.y) || 0,
    width: Number(node.width) || 250,
    height: Number(node.height) || 100,
    color: normalizeColor(node.color as string | undefined),
  };

  switch (node.type) {
    case 'text':
      return { ...base, type: 'text', text: String(node.text || '') };
    case 'file':
      return {
        ...base,
        type: 'file',
        file: String(node.file || ''),
        subpath: node.subpath as string | undefined,
      };
    case 'link':
      return { ...base, type: 'link', url: String(node.url || '') };
    case 'group':
      return {
        ...base,
        type: 'group',
        label: node.label as string | undefined,
        background: node.background as string | undefined,
        backgroundStyle: node.backgroundStyle as 'cover' | 'ratio' | 'repeat' | undefined,
      };
    default:
      // Unknown type, treat as text
      return { ...base, type: 'text', text: String(node.text || node.content || '') };
  }
}

function normalizeEdge(edge: Record<string, unknown>): CanvasEdge {
  return {
    id: String(edge.id),
    fromNode: String(edge.fromNode),
    fromSide: edge.fromSide as EdgeSide | undefined,
    fromEnd: edge.fromEnd as EdgeEnd | undefined,
    toNode: String(edge.toNode),
    toSide: edge.toSide as EdgeSide | undefined,
    toEnd: edge.toEnd as EdgeEnd | undefined,
    color: normalizeColor(edge.color as string | undefined),
    label: edge.label as string | undefined,
  };
}

// ============ Content Extraction ============

/**
 * Extract searchable text from canvas for embedding
 * Combines text nodes, group labels, and edge labels
 */
export function canvasToSearchableText(canvas: Canvas): string {
  const parts: string[] = [];

  for (const node of canvas.nodes) {
    if (node.type === 'text' && node.text) {
      parts.push(node.text);
    }
    if (node.type === 'group' && node.label) {
      parts.push(node.label);
    }
  }

  for (const edge of canvas.edges) {
    if (edge.label) {
      parts.push(edge.label);
    }
  }

  return parts.join('\n\n');
}

/**
 * Extract file references from canvas
 * Used for link resolution
 */
export function canvasFileReferences(canvas: Canvas): string[] {
  return canvas.nodes
    .filter((n): n is FileNode => n.type === 'file' && !!n.file)
    .map(n => n.file);
}

/**
 * Extract link URLs from canvas
 */
export function canvasLinkUrls(canvas: Canvas): string[] {
  return canvas.nodes
    .filter((n): n is LinkNode => n.type === 'link' && !!n.url)
    .map(n => n.url);
}

/**
 * Get canvas statistics
 */
export function canvasStats(canvas: Canvas): {
  textNodes: number;
  fileNodes: number;
  linkNodes: number;
  groupNodes: number;
  edges: number;
} {
  return {
    textNodes: canvas.nodes.filter(n => n.type === 'text').length,
    fileNodes: canvas.nodes.filter(n => n.type === 'file').length,
    linkNodes: canvas.nodes.filter(n => n.type === 'link').length,
    groupNodes: canvas.nodes.filter(n => n.type === 'group').length,
    edges: canvas.edges.length,
  };
}

// ============ Node Containment ============

/**
 * Check if a node is visually contained within a group
 * (Based on position overlap)
 */
export function isNodeInGroup(node: CanvasNode, group: GroupNode): boolean {
  return (
    node.x >= group.x &&
    node.y >= group.y &&
    node.x + node.width <= group.x + group.width &&
    node.y + node.height <= group.y + group.height
  );
}

/**
 * Get all nodes contained in a group
 */
export function getNodesInGroup(canvas: Canvas, groupId: string): CanvasNode[] {
  const group = canvas.nodes.find(n => n.id === groupId && n.type === 'group') as GroupNode | undefined;
  if (!group) return [];

  return canvas.nodes.filter(n => n.id !== groupId && isNodeInGroup(n, group));
}
