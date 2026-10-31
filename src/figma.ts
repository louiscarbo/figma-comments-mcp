const FIGMA_API_BASE = 'https://api.figma.com/v1';

/**
 * Where a comment is pinned.
 *
 * Verified against a real file rather than the docs. Node-anchored pins come in
 * two flavours and the difference matters: a plain pin is a point, but one with
 * region_width/height is a box the author dragged over an area — an annotation
 * covering "this whole row", not "this spot". Roughly half of real comments on a
 * design file turn out to be regions.
 *
 * The bare { x, y } canvas pin is documented but did not appear in testing; it's
 * kept as a fallback.
 */
export type NodePin = {
  node_id: string;
  node_offset: { x: number; y: number };
  stable_path?: string[];
  region_width?: number;
  region_height?: number;
  comment_pin_corner?: string;
};

export type CommentPin = NodePin | { x: number; y: number };

export interface FigmaComment {
  id: string;
  message: string;
  file_key: string;
  parent_id: string;
  user: { handle: string };
  created_at: string;
  resolved_at: string | null;
  client_meta: CommentPin | null;
}

export class FigmaError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(explain(status, body));
    this.name = 'FigmaError';
  }
}

/**
 * Turn a status code into something worth reading at 11pm. The raw Figma body
 * is appended, but the leading sentence should be enough on its own.
 */
function explain(status: number, body: string): string {
  const hint =
    status === 403
      ? 'Figma rejected the token (403). It may have expired, or it may not have access to this file. Note that figd_ tokens must be sent as X-Figma-Token — Authorization: Bearer is rejected.'
      : status === 404
        ? 'File not found (404). Either the file key is wrong, or the token belongs to an account that cannot see this file.'
        : status === 429
          ? 'Rate limited by Figma (429). Wait a moment and retry.'
          : `Figma API error ${status}.`;
  return body ? `${hint}\n\nFigma said: ${body}` : hint;
}

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;

async function figmaRequest(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      'X-Figma-Token': FIGMA_TOKEN as string,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    throw new FigmaError(res.status, await res.text());
  }
  return res;
}

export async function figmaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await figmaRequest(path, init);
  return (await res.json()) as T;
}

/**
 * Success is the status alone. Figma's docs say this returns nothing and its
 * OpenAPI spec says it returns JSON, and parsing the wrong guess would report a
 * delete that happened as a failure, losing the only record of the thread.
 */
export async function deleteComment(fileKey: string, commentId: string): Promise<void> {
  await figmaRequest(
    `/files/${encodeURIComponent(fileKey)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' }
  );
}

const WRITE_ACCESS_FIX =
  'Generate a new Figma personal access token (Settings → Security) with File content read-only and Comments read and write, store it in place of the old one, then reconnect this server.';

/**
 * Why a delete failed, and whether the thread is still there. A 4xx is a clean
 * refusal. A 5xx or a dropped connection may have landed first, so those say so.
 *
 * Figma doesn't document the 403 for a missing scope, and only a comment's author
 * may delete it, so a 403 that doesn't mention scopes has to name both causes.
 */
export function deleteFailure(err: unknown, author: string): string {
  if (err instanceof FigmaError && err.status === 403) {
    return /scope/i.test(err.body)
      ? `Nothing was deleted: this Figma token needs write access for comments (file_comments:write). ${WRITE_ACCESS_FIX}`
      : `Nothing was deleted: Figma refused it (403). Either this comment isn't yours, since only its author (${author}) can delete it, or the token needs write access for comments (file_comments:write). ${WRITE_ACCESS_FIX}`;
  }
  if (err instanceof FigmaError && err.status === 404) {
    return 'Figma has no such comment any more (404). It was there a moment ago, so it was probably deleted in the meantime.';
  }
  if (err instanceof FigmaError && err.status < 500) {
    return `Nothing was deleted. ${err.message}`;
  }

  const reason = err instanceof Error ? err.message : String(err);
  return `The delete may or may not have gone through. Run list_figma_comments before retrying, and keep this text in case it did. ${reason}`;
}

/**
 * Accept anything that identifies a file: a bare key, or any of the URL shapes
 * Figma has shipped (/file/, /design/, /proto/, /board/). Pasting the URL is
 * what people actually do.
 */
export function parseFileKey(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  const match = trimmed.match(/\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)/);
  if (!match) {
    throw new Error(
      `Could not find a file key in "${input}". Expected a URL like figma.com/design/<key>/... or a bare file key.`
    );
  }
  return match[1];
}

/**
 * Figma writes node ids as "1:23" in the API but "1-23" in URLs. Callers may
 * paste either.
 */
export function normalizeNodeId(id: string): string {
  return id.replace(/-/g, ':');
}

/**
 * Pull the node id out of a Figma URL, if it has one.
 *
 * This is the difference between "here is my file" and "here is this frame".
 * Every share link copied off a selected frame carries `?node-id=`, and
 * dropping it silently — which this server used to do — turns a question about
 * one frame into an answer about the whole file.
 *
 * Returns null for a bare file key or a URL with no node-id.
 */
export function parseNodeId(input: string): string | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  const match = trimmed.match(/[?&]node[-_]id=([^&#]+)/i);
  if (!match) return null;

  return normalizeNodeId(decodeURIComponent(match[1]));
}

export type Box = { x: number; y: number; width: number; height: number };

export interface NodeDoc {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  clipsContent?: boolean;
  itemReverseZIndex?: boolean;
  characters?: string;
  absoluteBoundingBox?: Box | null;
  annotations?: FigmaAnnotation[];
  children?: NodeDoc[];
}

/**
 * A Dev Mode annotation. Not a comment — a different feature, a different
 * place in the API, and the reason this server used to under-report a frame:
 * annotations live on the node itself, so a file with six of them looks empty
 * to anything that only reads /comments.
 *
 * `label` is the note. `properties` are the layer properties pinned alongside
 * it (width, fill…), and an annotation may carry those with no label at all.
 */
export interface FigmaAnnotation {
  label?: string;
  properties?: { type: string }[];
}

export interface AnnotatedNode {
  nodeId: string;
  name: string;
  type: string;
  annotations: FigmaAnnotation[];
}

/** Every annotated node at or below `root`, in document order. */
function collectAnnotations(root: NodeDoc): AnnotatedNode[] {
  const out: AnnotatedNode[] = [];
  const walk = (node: NodeDoc) => {
    if (node.annotations?.length) {
      out.push({
        nodeId: node.id,
        name: node.name,
        type: node.type,
        annotations: node.annotations
      });
    }
    node.children?.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Every node inside `rootId`, including `rootId` itself, mapped to its name
 * and type.
 *
 * Scoping has to include descendants: a comment is pinned to whatever layer sat
 * under the cursor, so a note about a frame is usually anchored to a button or
 * a text run several levels down, not to the frame. Matching the frame id alone
 * would return almost nothing.
 *
 * Ancestors are deliberately excluded. A comment on the section that contains
 * this frame is about the section — pulling it in would re-create the same
 * over-broad answer in a subtler form.
 *
 * Returns names as well as ids so a scoped call can skip resolveNodeNames
 * entirely — the subtree already has every name it needs. Annotations come out
 * of the same payload, so reading them costs nothing extra.
 */
export async function descendantNodes(
  fileKey: string,
  rootId: string
): Promise<{ names: Map<string, NodeInfo>; annotations: AnnotatedNode[] }> {
  const names = new Map<string, NodeInfo>();

  const data = await figmaFetch<{
    nodes: Record<string, { document?: NodeDoc } | null>;
  }>(`/files/${fileKey}/nodes?ids=${encodeURIComponent(rootId)}`);

  const root = data.nodes?.[rootId]?.document;
  if (!root) {
    throw new Error(
      `No node "${rootId}" in this file. Check the node-id in the URL, or pass scope:"file" to search the whole file.`
    );
  }

  const walk = (node: NodeDoc) => {
    names.set(node.id, { name: node.name, type: node.type, doc: node });
    node.children?.forEach(walk);
  };
  walk(root);

  return { names, annotations: collectAnnotations(root) };
}

/**
 * Every annotation in the file.
 *
 * There is no annotations endpoint, and annotations sit arbitrarily deep, so a
 * depth-limited fetch would miss exactly the ones worth having. That means
 * pulling the whole document — a few MB and about a second on a real design
 * file. Only the whole-file path pays it; a scoped call gets its annotations
 * out of the subtree it already fetched.
 *
 * Never throws: annotations are an enrichment, and losing them should not fail
 * a call that was primarily about comments.
 */
export async function fileAnnotations(fileKey: string): Promise<AnnotatedNode[]> {
  try {
    const data = await figmaFetch<{ document?: NodeDoc }>(`/files/${fileKey}`);
    return data.document ? collectAnnotations(data.document) : [];
  } catch {
    return [];
  }
}

export function pinNodeId(pin: CommentPin | null): string | null {
  if (pin && 'node_id' in pin && pin.node_id) return normalizeNodeId(pin.node_id);
  return null;
}

export interface NodeInfo {
  name: string;
  type: string;
  doc: NodeDoc;
}

/**
 * The area a pin covers, relative to the pinned node's top-left. A plain pin is
 * a zero-size box.
 *
 * For a region, node_offset is the anchor and comment_pin_corner says which
 * corner of the box the anchor is. Figma defaults that to bottom-right, so the
 * offset is usually the far corner of the box, not its origin.
 */
export function pinBox(pin: NodePin): Box {
  const width = pin.region_width ?? 0;
  const height = pin.region_height ?? 0;
  const corner = pin.comment_pin_corner ?? 'bottom-right';
  return {
    x: pin.node_offset.x - (corner.endsWith('right') ? width : 0),
    y: pin.node_offset.y - (corner.startsWith('bottom') ? height : 0),
    width,
    height
  };
}

function encloses(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * `node` down to the deepest visible layer enclosing `box`, or null if there is
 * none. Children stack back to front, so the last one is tried first: where
 * layers overlap, the one on top is the one the author was looking at.
 *
 * An unclipped frame's children can overflow it, so missing the frame only rules
 * out its subtree when it clips.
 */
function trailTo(node: NodeDoc, box: Box): NodeDoc[] | null {
  if (node.visible === false) return null;

  const bounds = node.absoluteBoundingBox;
  const inside = !!bounds && encloses(bounds, box);
  if (!inside && node.clipsContent) return null;

  const children = node.children ?? [];
  const topFirst = node.itemReverseZIndex ? children : [...children].reverse();
  for (const child of topFirst) {
    const trail = trailTo(child, box);
    if (trail) return [node, ...trail];
  }
  return inside ? [node] : null;
}

/**
 * The layers from `root`, the pinned node, down to the one the pin sits on: the
 * deepest visible layer holding the whole pin. Just `[root]` when no child does.
 * Null when `root` has no bounds to measure from, as a page doesn't.
 */
export function pinTrail(root: NodeDoc, pin: NodePin): NodeDoc[] | null {
  const origin = root.absoluteBoundingBox;
  if (!origin) return null;

  const box = pinBox(pin);
  return trailTo(root, { ...box, x: origin.x + box.x, y: origin.y + box.y }) ?? [root];
}

/** Names Figma gives containers by default, which say nothing about the layer. */
const DEFAULT_CONTAINER_NAME = /^(frame|group|section|component|union|subtract|intersect|exclude)( \d+)?$/i;

const MAX_TEXT_PREVIEW = 60;

function textPreview(characters: string): string {
  const flat = characters.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT_PREVIEW ? `${flat.slice(0, MAX_TEXT_PREVIEW)}…` : flat;
}

/**
 * What a pin sits on, for the end of the "on <frame>" line:
 * `→ 508:7009 "End" TEXT "End" in "Session card" at 1626,6352`
 *
 * The position is relative to the pinned node, so it doesn't depend on where the
 * frame sits on the canvas. A region prints its top-left, then its size.
 *
 * Empty when there is nothing to measure, which leaves the line as it was.
 */
export function describePin(root: NodeDoc, pin: CommentPin | null): string {
  if (!pin || !('node_offset' in pin) || !pin.node_offset) return '';

  const trail = pinTrail(root, pin);
  if (!trail) return '';

  const layer = trail[trail.length - 1];
  const ancestor = trail
    .slice(1, -1)
    .reverse()
    .find((node) => !DEFAULT_CONTAINER_NAME.test(node.name));
  const box = pinBox(pin);
  const text = layer.characters ? textPreview(layer.characters) : '';

  return [
    layer === root ? '' : `→ ${layer.id} "${layer.name}" ${layer.type}`,
    text ? `"${text}"` : '',
    ancestor ? `in "${ancestor.name}"` : '',
    `at ${Math.round(box.x)},${Math.round(box.y)}`,
    box.width || box.height ? `${Math.round(box.width)}×${Math.round(box.height)}` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Resolve node ids to human-readable layer names. This is what makes a pin
 * actionable — "on layer 'CTA button'" instead of "at {x: 40, y: 12}".
 *
 * Omitting depth returns each node's whole subtree, so what a pin sits on can be
 * worked out from this response, with no further requests.
 *
 * Deliberately never throws: name resolution is an enrichment, and losing it
 * should degrade the output rather than fail the whole call.
 */
export async function resolveNodeNames(
  fileKey: string,
  nodeIds: string[]
): Promise<Map<string, NodeInfo>> {
  const out = new Map<string, NodeInfo>();
  const unique = [...new Set(nodeIds)].filter(Boolean);
  if (unique.length === 0) return out;

  // Figma caps the ids query; batch conservatively.
  const BATCH = 50;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    try {
      const data = await figmaFetch<{
        nodes: Record<string, { document?: NodeDoc } | null>;
      }>(`/files/${fileKey}/nodes?ids=${encodeURIComponent(batch.join(','))}`);

      for (const [id, entry] of Object.entries(data.nodes ?? {})) {
        const doc = entry?.document;
        if (doc) out.set(id, { name: doc.name, type: doc.type, doc });
      }
    } catch {
      // Enrichment only — leave these ids unresolved.
    }
  }
  return out;
}

/**
 * Render a node to an image and return the bytes.
 *
 * This exists because layer names stop helping exactly when you need them most.
 * A comment pinned to a pasted screenshot resolves to something like
 * "image 21" (RECTANGLE) — technically correct, completely useless. The only
 * way to act on "too much space here" is to look at it.
 */
/**
 * Roughly a 1000×1000 screenshot. Above this the base64 payload starts costing
 * more context than the answer is worth — a full-page frame at scale 1 came back
 * at 650KB in testing, which is not a thing you can call twice.
 */
const MAX_IMAGE_BYTES = 400_000;
const MIN_SCALE = 0.15;

async function renderOnce(
  fileKey: string,
  nodeId: string,
  scale: number,
  format: 'png' | 'jpg'
): Promise<Buffer> {
  const res = await figmaFetch<{ err: string | null; images: Record<string, string | null> }>(
    `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=${format}&scale=${scale}`
  );
  if (res.err) throw new Error(`Figma could not render ${nodeId}: ${res.err}`);

  const url = res.images?.[nodeId];
  if (!url) {
    throw new Error(
      `Figma returned no image for ${nodeId}. Nodes that render to nothing (zero-size or fully hidden layers) come back empty.`
    );
  }

  // The render URL is a short-lived signed link, so inline the bytes rather than
  // handing back a URL that will be dead by the time anyone clicks it.
  const img = await fetch(url);
  if (!img.ok) throw new Error(`Failed to download the rendered image (${img.status}).`);
  return Buffer.from(await img.arrayBuffer());
}

export async function renderNode(
  fileKey: string,
  nodeId: string,
  opts: { scale?: number; format?: 'png' | 'jpg' } = {}
): Promise<{ data: string; mimeType: string; bytes: number; scale: number; downscaled: boolean }> {
  const format = opts.format ?? 'png';
  const requested = opts.scale ?? 1;

  let scale = requested;
  let buf = await renderOnce(fileKey, nodeId, scale, format);

  // Big frames and whole sections blow past anything usable at scale 1. Halve
  // until it fits rather than handing back something that cannot be read.
  while (buf.byteLength > MAX_IMAGE_BYTES && scale > MIN_SCALE) {
    scale = Math.max(MIN_SCALE, Number((scale / 2).toFixed(3)));
    buf = await renderOnce(fileKey, nodeId, scale, format);
  }

  return {
    data: buf.toString('base64'),
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    bytes: buf.byteLength,
    scale,
    downscaled: scale !== requested
  };
}
