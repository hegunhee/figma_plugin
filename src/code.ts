/// <reference types="@figma/plugin-typings" />

// ─── Serialization Helpers ────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function serializePaint(paint: Paint): object {
  const base = { type: paint.type, visible: paint.visible ?? true, opacity: paint.opacity ?? 1 };
  if (paint.type === 'SOLID') {
    return { ...base, color: rgbToHex(paint.color.r, paint.color.g, paint.color.b) };
  }
  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    return {
      ...base,
      stops: paint.gradientStops.map((s) => ({
        color: rgbToHex(s.color.r, s.color.g, s.color.b),
        alpha: s.color.a,
        position: s.position,
      })),
    };
  }
  if (paint.type === 'IMAGE') {
    return { ...base, imageHash: paint.imageHash, scaleMode: paint.scaleMode };
  }
  return base;
}

function serializeEffect(effect: Effect): object {
  switch (effect.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW':
      return {
        type: effect.type,
        color: rgbToHex(effect.color.r, effect.color.g, effect.color.b),
        alpha: effect.color.a,
        offset: { x: effect.offset.x, y: effect.offset.y },
        radius: effect.radius,
        spread: effect.spread,
        visible: effect.visible,
      };
    case 'LAYER_BLUR':
    case 'BACKGROUND_BLUR':
      return { type: effect.type, radius: effect.radius, visible: effect.visible };
    default:
      return { type: effect.type };
  }
}

function isMixed(val: unknown): boolean {
  return val === figma.mixed;
}

function safeVal<T>(val: T | typeof figma.mixed): T | 'MIXED' {
  return isMixed(val) ? 'MIXED' : (val as T);
}

function serializeTextStyle(node: TextNode): object {
  const fills = node.fills;
  return {
    characters: node.characters,
    fontSize: safeVal(node.fontSize),
    fontName: safeVal(node.fontName),
    letterSpacing: safeVal(node.letterSpacing),
    lineHeight: safeVal(node.lineHeight),
    textCase: safeVal(node.textCase),
    textDecoration: safeVal(node.textDecoration),
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
    paragraphSpacing: node.paragraphSpacing,
    paragraphIndent: node.paragraphIndent,
    fills: isMixed(fills) ? 'MIXED' : (fills as Paint[]).map(serializePaint),
  };
}

function serializeNode(node: SceneNode, depth = 0, maxDepth = 5): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  if ('locked' in node) out.locked = node.locked;
  if ('x' in node) out.x = node.x;
  if ('y' in node) out.y = node.y;
  if ('width' in node) out.width = node.width;
  if ('height' in node) out.height = node.height;
  if ('rotation' in node) out.rotation = node.rotation;
  if ('opacity' in node) out.opacity = node.opacity;
  if ('blendMode' in node) out.blendMode = node.blendMode;

  // Fills & strokes
  if ('fills' in node) {
    out.fills = isMixed(node.fills) ? 'MIXED' : (node.fills as Paint[]).map(serializePaint);
  }
  if ('strokes' in node && (node as GeometryMixin).strokes.length > 0) {
    out.strokes = (node as GeometryMixin).strokes.map(serializePaint);
    if ('strokeWeight' in node) out.strokeWeight = safeVal((node as GeometryMixin).strokeWeight);
    if ('strokeAlign' in node) out.strokeAlign = (node as GeometryMixin).strokeAlign;
    if ('dashPattern' in node) out.dashPattern = (node as GeometryMixin).dashPattern;
  }

  // Corner radius
  if ('cornerRadius' in node) {
    const cr = (node as CornerMixin).cornerRadius;
    out.cornerRadius = isMixed(cr) ? 'MIXED' : cr;
  }
  if ('topLeftRadius' in node) {
    const n = node as RectangleNode;
    out.cornerRadii = {
      topLeft: n.topLeftRadius,
      topRight: n.topRightRadius,
      bottomLeft: n.bottomLeftRadius,
      bottomRight: n.bottomRightRadius,
    };
  }

  // Effects
  if ('effects' in node && (node as BlendMixin).effects.length > 0) {
    out.effects = (node as BlendMixin).effects.map(serializeEffect);
  }

  // Auto layout
  if ('layoutMode' in node) {
    const n = node as FrameNode;
    out.layout = {
      mode: n.layoutMode,
      primaryAxisSizing: n.primaryAxisSizingMode,
      counterAxisSizing: n.counterAxisSizingMode,
      primaryAxisAlign: n.primaryAxisAlignItems,
      counterAxisAlign: n.counterAxisAlignItems,
      paddingTop: n.paddingTop,
      paddingRight: n.paddingRight,
      paddingBottom: n.paddingBottom,
      paddingLeft: n.paddingLeft,
      itemSpacing: n.itemSpacing,
      layoutWrap: n.layoutWrap,
    };
  }

  // Layout child sizing
  if ('layoutAlign' in node) out.layoutAlign = (node as LayoutMixin).layoutAlign;
  if ('layoutGrow' in node) out.layoutGrow = (node as LayoutMixin).layoutGrow;
  if ('layoutSizingHorizontal' in node) out.layoutSizingHorizontal = (node as LayoutMixin).layoutSizingHorizontal;
  if ('layoutSizingVertical' in node) out.layoutSizingVertical = (node as LayoutMixin).layoutSizingVertical;

  // Constraints
  if ('constraints' in node) out.constraints = (node as ConstraintMixin).constraints;

  // Text-specific
  if (node.type === 'TEXT') {
    Object.assign(out, serializeTextStyle(node));
  }

  // Component instance
  if (node.type === 'INSTANCE') {
    try {
      out.componentId = node.mainComponent?.id;
      out.componentName = node.mainComponent?.name;
      out.componentSetName = node.mainComponent?.parent?.type === 'COMPONENT_SET'
        ? node.mainComponent.parent.name
        : undefined;
    } catch (_) {
      // Plugin might not have access to master component
    }
  }

  // Component
  if (node.type === 'COMPONENT') {
    out.description = node.description;
    out.remote = node.remote;
  }

  // Children (recursive)
  if ('children' in node && depth < maxDepth) {
    out.children = (node as ChildrenMixin).children.map((child) =>
      serializeNode(child as SceneNode, depth + 1, maxDepth)
    );
  } else if ('children' in node) {
    out.childCount = (node as ChildrenMixin).children.length;
  }

  return out;
}

// ─── Plugin Entry ─────────────────────────────────────────────────────────────

figma.showUI(__html__, {
  width: 280,
  height: 380,
  themeColors: true,
});

figma.ui.onmessage = async (msg: { type: string; payload?: Record<string, unknown>; requestId?: string }) => {
  const { type, payload = {}, requestId } = msg;

  const reply = (data: unknown) =>
    figma.ui.postMessage({ type: 'response', requestId, data });

  const replyError = (error: string) =>
    figma.ui.postMessage({ type: 'response', requestId, error });

  try {
    switch (type) {
      // ── Selection ──────────────────────────────────────────────────────────
      case 'get_selection': {
        const maxDepth = (payload.maxDepth as number) ?? 5;
        const nodes = figma.currentPage.selection.map((n) => serializeNode(n, 0, maxDepth));
        reply({ nodes, count: nodes.length });
        break;
      }

      // ── Single node by ID ──────────────────────────────────────────────────
      case 'get_node': {
        const nodeId = payload.nodeId as string;
        const node = figma.getNodeById(nodeId);
        if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
          replyError(`Node "${nodeId}" not found or not a scene node`);
          return;
        }
        const maxDepth = (payload.maxDepth as number) ?? 5;
        reply(serializeNode(node as SceneNode, 0, maxDepth));
        break;
      }

      // ── All nodes on current page ──────────────────────────────────────────
      case 'get_page_nodes': {
        const maxDepth = (payload.maxDepth as number) ?? 3;
        const nodes = figma.currentPage.children.map((n) => serializeNode(n as SceneNode, 0, maxDepth));
        reply({ pageName: figma.currentPage.name, nodeCount: nodes.length, nodes });
        break;
      }

      // ── File info ──────────────────────────────────────────────────────────
      case 'get_file_info': {
        reply({
          fileName: figma.root.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fileKey: (figma as any).fileKey ?? null,
          pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
          currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
          selectionCount: figma.currentPage.selection.length,
        });
        break;
      }

      // ── Comments ───────────────────────────────────────────────────────────
      case 'get_comments': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const getCommentsAsync = (figma as any).getCommentsAsync;
        if (typeof getCommentsAsync !== 'function') {
          replyError('figma.getCommentsAsync is not supported in Figma Desktop plugin API. Use the Figma REST API MCP (figma_get_comments) instead.');
          break;
        }
        const comments = await getCommentsAsync.call(figma);
        const serialized = (comments as Comment[]).map((c) => ({
          id: c.id,
          message: c.message,
          author: c.author,
          createdAt: c.createdAt,
          resolved: c.resolvedAt !== null,
          resolvedAt: c.resolvedAt,
          orderId: c.orderId,
          reactions: c.reactions,
          position: 'x' in c.clientMeta
            ? { x: (c.clientMeta as Vector).x, y: (c.clientMeta as Vector).y }
            : { nodeId: (c.clientMeta as FrameOffset).node.id, offset: (c.clientMeta as FrameOffset).offset },
        }));
        reply({ count: serialized.length, comments: serialized });
        break;
      }

      // ── Export node as image ───────────────────────────────────────────────
      case 'export_node': {
        const nodeId = payload.nodeId as string;
        const node = figma.getNodeById(nodeId);
        if (!node || !('exportAsync' in node)) {
          replyError(`Node "${nodeId}" not found or not exportable`);
          return;
        }
        const format = (payload.format as 'PNG' | 'JPG' | 'SVG') ?? 'PNG';
        const scale = (payload.scale as number) ?? 2;
        const bytes = await (node as ExportMixin).exportAsync({
          format,
          constraint: { type: 'SCALE', value: scale },
        });
        const base64 = figma.base64Encode(bytes);
        reply({ base64, format });
        break;
      }

      // ── Local styles ───────────────────────────────────────────────────────
      case 'get_styles': {
        reply({
          paintStyles: figma.getLocalPaintStyles().map((s) => ({
            id: s.id, name: s.name, key: s.key,
            paints: (s.paints as Paint[]).map(serializePaint),
          })),
          textStyles: figma.getLocalTextStyles().map((s) => ({
            id: s.id, name: s.name, key: s.key,
            fontSize: s.fontSize, fontName: s.fontName,
            lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
          })),
          effectStyles: figma.getLocalEffectStyles().map((s) => ({
            id: s.id, name: s.name, key: s.key,
            effects: (s.effects as Effect[]).map(serializeEffect),
          })),
        });
        break;
      }

      default:
        replyError(`Unknown message type: "${type}"`);
    }
  } catch (e) {
    replyError(String(e));
  }
};
