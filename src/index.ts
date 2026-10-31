import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  deleteComment,
  deleteFailure,
  figmaFetch,
  parseFileKey,
  parseNodeId,
  descendantNodes,
  describePin,
  fileAnnotations,
  pinNodeId,
  normalizeNodeId,
  renderNode,
  resolveNodeNames,
  type AnnotatedNode,
  type NodeInfo,
  type FigmaComment
} from './figma.js';

if (!process.env.FIGMA_TOKEN) {
  console.error('FIGMA_TOKEN is not set. Add it to the env block in claude_desktop_config.json.');
  process.exit(1);
}

const server = new McpServer({ name: 'figma-comments-mcp', version: '2.1.0' });

/** MCP tools should report failure as content, not blow up the transport. */
function toolError(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true
  };
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function refusal(body: string) {
  return { ...text(body), isError: true };
}

async function fetchComments(fileKey: string): Promise<FigmaComment[]> {
  const data = await figmaFetch<{ comments: FigmaComment[] }>(`/files/${fileKey}/comments`);
  return data.comments ?? [];
}

/** "2026-08-05T15:36:10.517Z" → "2026-08-05 15:36". Seconds never mattered. */
function shortTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function oldestFirst(a: FigmaComment, b: FigmaComment): number {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/**
 * A thread in full. Unlike the list output this keeps line breaks and dates on
 * replies, because after a delete this text is the only record.
 */
function threadRecord(root: FigmaComment, replies: FigmaComment[]): string {
  const lines = [
    `${root.id} · ${root.user.handle} · ${shortTime(root.created_at)}`,
    `  ${root.message.replace(/\n/g, '\n  ')}`
  ];
  for (const reply of replies) {
    lines.push(`  ↳ ${reply.id} · ${reply.user.handle} · ${shortTime(reply.created_at)}`);
    lines.push(`    ${reply.message.replace(/\n/g, '\n    ')}`);
  }
  return lines.join('\n');
}

/** How many notes a set of annotated nodes carries — a node can hold several. */
function countAnnotations(nodes: AnnotatedNode[]): number {
  return nodes.reduce((n, a) => n + a.annotations.length, 0);
}

/**
 * Annotations render as their own block rather than being mixed into the
 * threads: they have no author and no timestamp, and reading them as comments
 * is how "one annotation" becomes "someone said this to me".
 */
function annotationLines(nodes: AnnotatedNode[]): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push('');
    lines.push(`annotation on ${node.nodeId} "${node.name}" ${node.type}`);
    for (const a of node.annotations) {
      if (a.label) lines.push(`  ${a.label.replace(/\n+/g, ' ')}`);
      // An annotation can pin layer properties with no note attached. Saying
      // so beats printing a blank bullet.
      const props = a.properties?.map((p) => p.type).join(', ');
      if (props) lines.push(`  (pinned properties: ${props})`);
      if (!a.label && !props) lines.push('  (empty annotation)');
    }
  }
  return lines;
}

server.registerTool(
  'list_figma_comments',
  {
    title: 'List Figma comments and annotations',
    description:
      'Read the feedback on a Figma file, or on one frame within it: comment threads AND Dev Mode annotations, which are a separate feature pinned to layers and are easy to miss otherwise. IMPORTANT: a URL copied off a selected frame carries node-id, and this tool scopes to that frame by default — threads elsewhere on the file are counted but not returned. Pass scope:"file" to read everything.',
    inputSchema: z.object({
      file: z
        .string()
        .describe('A Figma file URL (figma.com/design/<key>/...) or a bare file key. URLs are fine.'),
      node_id: z
        .string()
        .optional()
        .describe('Scope to this frame, overriding the URL. Accepts "132:5" or "132-5".'),
      scope: z
        .enum(['auto', 'file'])
        .optional()
        .default('auto')
        .describe(
          '"auto" (default): scope to node_id, else the URL\'s node-id, else the whole file. "file": whole file even when a frame was linked.'
        ),
      since: z
        .string()
        .optional()
        .describe('ISO 8601. Threads with any activity after this, including new replies to old threads.'),
      include_resolved: z.boolean().optional().default(false).describe('Include resolved threads'),
      include_annotations: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Include Dev Mode annotations pinned to layers. On by default — they read as feedback and are invisible to the comments API.'
        )
    })
  },
  async ({ file, node_id, scope, since, include_resolved, include_annotations }) => {
    try {
      const fileKey = parseFileKey(file);

      // An explicit node_id beats the URL; scope:"file" beats both. Anything
      // else, and a frame link means the frame.
      const scopeId =
        scope === 'file' ? null : node_id ? normalizeNodeId(node_id) : parseNodeId(file);

      const comments = await fetchComments(fileKey);

      const repliesByParent = new Map<string, FigmaComment[]>();
      for (const c of comments) {
        if (!c.parent_id) continue;
        const list = repliesByParent.get(c.parent_id) ?? [];
        list.push(c);
        repliesByParent.set(c.parent_id, list);
      }

      let threads = comments.filter((c) => !c.parent_id);
      if (!include_resolved) threads = threads.filter((c) => !c.resolved_at);

      if (since) {
        const cutoff = new Date(since).getTime();
        if (Number.isNaN(cutoff)) {
          throw new Error(`"${since}" is not a valid ISO 8601 timestamp.`);
        }
        // A thread counts as new if the root OR any reply landed after the cutoff.
        // Filtering on the root alone silently drops fresh replies to old threads,
        // which is usually the exact thing you were looking for.
        threads = threads.filter((root) =>
          [root, ...(repliesByParent.get(root.id) ?? [])].some(
            (c) => new Date(c.created_at).getTime() > cutoff
          )
        );
      }

      const candidates = threads.length;

      // A scoped call already holds the whole subtree, so it has every name it
      // needs; only a whole-file call has to go back for them.
      let names: Map<string, NodeInfo>;
      let annotations: AnnotatedNode[] = [];
      if (scopeId) {
        const subtree = await descendantNodes(fileKey, scopeId);
        names = subtree.names;
        annotations = subtree.annotations;
        threads = threads.filter((t) => {
          const id = pinNodeId(t.client_meta);
          return id ? names.has(id) : false;
        });
      } else {
        names = await resolveNodeNames(
          fileKey,
          threads.map((t) => pinNodeId(t.client_meta)).filter((id): id is string => !!id)
        );
        // No subtree to read them out of, so this one costs a full-file fetch.
        if (include_annotations) annotations = await fileAnnotations(fileKey);
      }
      if (!include_annotations) annotations = [];

      threads.sort(oldestFirst);

      const scopeLabel = scopeId
        ? `${names.get(scopeId)?.type.toLowerCase() ?? 'node'} ${scopeId} "${names.get(scopeId)?.name ?? '?'}"`
        : 'whole file';

      // Both counts on the headline. A frame with one comment and one
      // annotation reported "1 thread", and one number that looks complete is
      // worse than two that disagree with your memory.
      const annCount = countAnnotations(annotations);
      const headline =
        `${fileKey} · ${scopeLabel} · ${threads.length} thread${threads.length === 1 ? '' : 's'}` +
        (include_annotations
          ? ` · ${annCount} annotation${annCount === 1 ? '' : 's'}`
          : ' · annotations not read');

      const lines: string[] = [headline];

      // The count that would have prevented reading six comments as one frame's
      // worth. Silent filtering is as misleading as silent over-fetching.
      const excluded = candidates - threads.length;
      if (excluded > 0) {
        lines.push(
          `${excluded} more thread${excluded === 1 ? '' : 's'} elsewhere on this file — re-run with scope:"file" to read them.`
        );
      }

      for (const root of threads) {
        const pin = root.client_meta;
        const nodeId = pinNodeId(pin);
        const info = nodeId ? names.get(nodeId) : undefined;

        lines.push('');
        lines.push(`${root.id} · ${root.user.handle} · ${shortTime(root.created_at)}`);

        if (nodeId) {
          // A dragged region means "everything in this box", not "this spot".
          const area = pin && 'region_width' in pin && pin.region_width ? ' [area]' : '';
          const pinned = `  on ${nodeId} "${info?.name ?? '?'}" ${info?.type ?? '?'}${area}`;
          const layer = info ? describePin(info.doc, pin) : '';
          lines.push(layer ? `${pinned} ${layer}` : pinned);

          // Layer names go generic exactly where they matter most — a comment
          // on a pasted screenshot resolves to "image 21".
          if (info && !/^(FRAME|SECTION|COMPONENT|INSTANCE|GROUP)$/.test(info.type)) {
            lines.push('  (not a frame — call get_figma_comment_image to see it)');
          }
        } else if (pin && 'x' in pin) {
          lines.push('  on canvas (not pinned to a layer)');
        }

        lines.push(`  ${root.message.replace(/\n+/g, ' ')}`);

        for (const r of (repliesByParent.get(root.id) ?? []).sort(oldestFirst)) {
          lines.push(`  ↳ ${r.user.handle}: ${r.message.replace(/\n+/g, ' ')}`);
        }
      }

      lines.push(...annotationLines(annotations));

      if (threads.length === 0 && excluded === 0 && annCount === 0) {
        lines.push(
          include_annotations
            ? 'No unresolved comments and no annotations.'
            : 'No unresolved comments.'
        );
      }

      return text(lines.join('\n'));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  'get_figma_comment_image',
  {
    title: 'See what a Figma comment points at',
    description:
      'Render the layer a comment is pinned to. Costs real context — call it only when the words are not enough: a spatial note ("this spacing", "move this left"), or a pin on something that is not a frame. A layer name plus the comment text is usually sufficient. Drop scale below 1 for layout questions.',
    inputSchema: z.object({
      file: z.string().describe('A Figma file URL or a bare file key'),
      comment_id: z
        .string()
        .optional()
        .describe('Render whatever this comment is pinned to. Either this or node_id is required.'),
      node_id: z
        .string()
        .optional()
        .describe('Render this node directly. Accepts "132:5" or the "132-5" form used in URLs.'),
      scale: z.number().optional().default(1).describe('Render scale, 0.25–4. Higher costs more context.'),
      format: z.enum(['png', 'jpg']).optional().default('png').describe('Image format')
    })
  },
  async ({ file, comment_id, node_id, scale, format }) => {
    try {
      const fileKey = parseFileKey(file);

      let targetId: string | null = node_id ? normalizeNodeId(node_id) : null;
      let context: string;

      if (comment_id) {
        const comments = await fetchComments(fileKey);
        const target = comments.find((c) => c.id === comment_id);
        if (!target) {
          throw new Error(
            `No comment with id "${comment_id}" on this file. Run list_figma_comments to get current ids.`
          );
        }
        targetId = pinNodeId(target.client_meta);
        if (!targetId) {
          throw new Error(
            `Comment "${comment_id}" is not pinned to a layer, so there is nothing to render.`
          );
        }
        context = `Comment "${target.message}" is pinned to node ${targetId}.`;
      } else if (targetId) {
        context = `Node ${targetId}.`;
      } else {
        throw new Error('Pass either comment_id or node_id.');
      }

      const render = await renderNode(fileKey, targetId, { scale, format });

      const note = render.downscaled
        ? ` Rendered at scale ${render.scale} instead of ${scale} — at full size it was too large to return.`
        : '';

      return {
        content: [
          { type: 'text' as const, text: `${context}${note}` },
          { type: 'image' as const, data: render.data, mimeType: render.mimeType }
        ]
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.registerTool(
  'delete_figma_comment',
  {
    title: 'Delete a handled Figma comment thread',
    description:
      'Permanently delete one comment thread you have finished handling. This cannot be undone, and only the comment\'s author can do it. The reply count is a guard: if the thread no longer has expected_reply_count replies, nothing is deleted and the thread is printed as it stands, so a reply added since you read it is seen rather than destroyed. On success, returns the full text of what was deleted, which is the only record.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: z.object({
      file: z.string().describe('A Figma file URL or a bare file key'),
      comment_id: z
        .string()
        .describe(
          'The root comment of the thread, as printed by list_figma_comments. One thread per call; a reply id is refused.'
        ),
      expected_reply_count: z
        .number()
        .int()
        .min(0)
        .describe(
          'How many replies the thread had when you handled it: the ↳ lines in list_figma_comments, 0 if none. Report what you saw, and never fill this in from a refusal without reading the thread again.'
        )
    })
  },
  async ({ file, comment_id, expected_reply_count }) => {
    try {
      const fileKey = parseFileKey(file);
      const comments = await fetchComments(fileKey);

      const target = comments.find((c) => c.id === comment_id);
      if (!target) {
        return refusal(
          `Nothing was deleted: no comment with id "${comment_id}" on this file. Run list_figma_comments to get current ids.`
        );
      }

      const rootId = target.parent_id || target.id;
      const root = comments.find((c) => c.id === rootId) ?? target;
      const replies = comments.filter((c) => c.parent_id === rootId).sort(oldestFirst);
      const record = threadRecord(root, replies);

      if (target.parent_id) {
        return refusal(
          `Nothing was deleted: ${comment_id} is a reply, and this tool deletes whole threads. The thread's root is ${rootId}.\n\n${record}`
        );
      }

      if (replies.length !== expected_reply_count) {
        return refusal(
          `Nothing was deleted: this thread has ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}, not the ${expected_reply_count} you expected. Read it as it stands now and handle anything new before deleting it.\n\n${record}`
        );
      }

      try {
        await deleteComment(fileKey, target.id);
      } catch (err) {
        return refusal(`${deleteFailure(err, target.user.handle)}\n\n${record}`);
      }

      return text(
        `Deleted comment ${target.id} from ${fileKey}. This can't be undone, and Figma doesn't document what happens to replies, so treat them as gone. This is the only record:\n\n${record}`
      );
    } catch (err) {
      return toolError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
