// Painting and interaction for the wiring diagrams, on TreeUI's
// `TCanvasSurface`.
//
// The surface owns the element: its box (a `height` prop, `inline-size: 100%`),
// the device-pixel ratio, coalesced repaints and the pointer → canvas-space
// conversion. This module owns only what is genuinely the diagram's: the
// pixels inside the box and the view transform (pan and zoom) applied to them.
// It writes no `style`, inserts nothing into the document and owns no
// listener — the `.vue` binds the surface's events to the handlers returned by
// `createGraphView`.
// That is what took the canvas row out of rule 2's exception table in
// `ui-ux.md`.
//
// Everything it borrows, it borrows properly:
//  - colours come from the TreeUI design tokens via `getComputedStyle`, so the
//    drawing follows the theme AND any `branding.colors` override — no literal
//    hex outside the fallback map;
//  - the service marks are the vendored AWS Architecture artwork, reproduced
//    unmodified (uniform scale only, original fills), as rule 3 requires;
//  - every string it draws arrives already translated (`GraphText`).
import type { CanvasSurfaceFrame, CanvasSurfacePoint } from '@treeui/vue';
import { awsIconArtwork } from '../../icons/aws/artwork.generated';
import type { AwsIconName } from '../../icons/aws/artwork.generated';
import type { AwsIconNode } from '../../icons/aws/types';
import type { GraphEdgeKind, GraphNode } from '../../services/api';
import type { GraphLayout, LegendKey, PlacedEdge, PlacedFrame, PlacedNode } from './graphLayout';
import { EDGE_COLOURS, ROUTE_ROW_HEIGHT, frameHeaderAt, neighbourhood, nodeAt } from './graphLayout';
import type { GraphText } from './graphText';
import type { Palette, TokenName } from './graphPaint';
import {
  CARD_RADIUS, FRAME_RADIUS, MARK_SIZE, STROKES, TOKENS, legendArrows, legendPositions, longestLeg, markNameFor, methodColours,
} from './graphPaint';

export type { Palette } from './graphPaint';

/** Read every token off the document — call again on a theme flip. */
export function readPalette(): Palette {
  const style = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const palette = {} as Palette;
  for (const [key, [name, fallback]] of Object.entries(TOKENS)) palette[key as TokenName] = read(name, fallback);
  palette.edge = {} as Record<GraphEdgeKind, string>;
  for (const [kind, token] of Object.entries(EDGE_COLOURS)) palette.edge[kind as GraphEdgeKind] = read(token, palette.muted);
  return palette;
}

// --- AWS marks -------------------------------------------------------------------

interface MarkShape {
  path: Path2D;
  fill: string;
}

/**
 * Flatten one vendored mark into Path2D shapes on its native 24×24 grid. The
 * artwork is a closed vocabulary (`g`/`rect`/`path`, `translate()` only), and
 * the fill is inherited from the nearest `<g fill>` — a third of the pack puts
 * the glyph fill on the group. Never tinted: the marks are trademarks vendored
 * on the condition that they are reproduced unmodified.
 */
function flattenMark(nodes: readonly AwsIconNode[], inheritedFill: string, dx: number, dy: number): MarkShape[] {
  const shapes: MarkShape[] = [];
  for (const node of nodes) {
    const fill = node.attrs.fill ?? inheritedFill;
    let offsetX = dx;
    let offsetY = dy;
    const match = node.attrs.transform ? /translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)/.exec(node.attrs.transform) : null;
    if (match) {
      offsetX += Number(match[1]);
      offsetY += Number(match[2]);
    }
    if (node.tag === 'rect') {
      const path = new Path2D();
      path.rect(Number(node.attrs.x ?? 0) + offsetX, Number(node.attrs.y ?? 0) + offsetY, Number(node.attrs.width ?? 0), Number(node.attrs.height ?? 0));
      shapes.push({ path, fill });
    } else if (node.tag === 'path' && node.attrs.d) {
      const path = new Path2D();
      path.addPath(new Path2D(node.attrs.d), new DOMMatrix().translate(offsetX, offsetY));
      shapes.push({ path, fill });
    }
    if (node.children) shapes.push(...flattenMark(node.children, fill, offsetX, offsetY));
  }
  return shapes;
}

const markCache = new Map<string, MarkShape[]>();

function markShapes(name: AwsIconName): MarkShape[] {
  const cached = markCache.get(name);
  if (cached) return cached;
  const shapes = flattenMark(awsIconArtwork[name].nodes, '#000000', 0, 0);
  markCache.set(name, shapes);
  return shapes;
}

// --- Drawing primitives ---------------------------------------------------------------

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Ellipsis by measurement: names are arbitrary and the font is proportional.
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

// A polyline with softened corners, so a right-angle route reads as one
// connector rather than a string of segments.
function tracePolyline(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[], radius: number): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1];
    const here = points[index];
    const next = points[index + 1];
    const r = Math.min(radius, Math.hypot(here.x - prev.x, here.y - prev.y) / 2, Math.hypot(next.x - here.x, next.y - here.y) / 2);
    ctx.arcTo(here.x, here.y, next.x, next.y, r);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

function arrowhead(ctx: CanvasRenderingContext2D, tip: { x: number; y: number }, from: { x: number; y: number }): void {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - 8 * cos + 4 * sin, tip.y - 8 * sin - 4 * cos);
  ctx.lineTo(tip.x - 8 * cos - 4 * sin, tip.y - 8 * sin + 4 * cos);
  ctx.closePath();
  ctx.fill();
}

function drawEdge(ctx: CanvasRenderingContext2D, placed: PlacedEdge, palette: Palette, alpha: number, emphasis: boolean): void {
  const colour = palette.edge[placed.colourKind] ?? palette.muted;
  const stroke = STROKES[placed.stroke];
  const weight = placed.edge.weight ?? 1;
  ctx.save();
  ctx.globalAlpha = alpha * (placed.stroke === 'link' ? 0.7 : 1);
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = stroke.width + (emphasis ? 0.8 : 0) + (weight > 1 ? Math.min(weight, 6) * 0.35 : 0);
  ctx.setLineDash(stroke.dash);
  tracePolyline(ctx, placed.points, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  const points = placed.points;
  if (placed.arrowEnd) arrowhead(ctx, points[points.length - 1], points[points.length - 2]);
  if (placed.arrowStart) arrowhead(ctx, points[0], points[1]);
  // An aggregated arrow between collapsed services says how many links it
  // stands for, on a pill at the middle of its longest leg.
  if (weight > 1) {
    const leg = longestLeg(points);
    const mx = (points[leg].x + points[leg + 1].x) / 2;
    const my = (points[leg].y + points[leg + 1].y) / 2;
    const label = String(weight);
    ctx.font = `600 10px ${palette.fontSans}`;
    const w = ctx.measureText(label).width + 10;
    roundedRect(ctx, mx - w / 2, my - 8, w, 16, 8);
    ctx.fillStyle = palette.surface;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = palette.text;
    ctx.textAlign = 'center';
    ctx.fillText(label, mx, my + 3.5);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

function drawFrame(ctx: CanvasRenderingContext2D, frame: PlacedFrame, palette: Palette, text: GraphText): void {
  ctx.save();
  roundedRect(ctx, frame.x, frame.y, frame.width, frame.height, FRAME_RADIUS);
  ctx.fillStyle = palette.subtle;
  ctx.fill();
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = palette.text;
  ctx.font = `600 13px ${palette.fontSans}`;
  ctx.fillText(fitText(ctx, frame.group, frame.width - 160), frame.x + 16, frame.y + 20);
  if (text.frameHint) {
    ctx.fillStyle = palette.muted;
    ctx.font = `11px ${palette.fontSans}`;
    ctx.textAlign = 'right';
    ctx.fillText(text.frameHint, frame.x + frame.width - 16, frame.y + 20);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  placed: PlacedNode,
  palette: Palette,
  text: GraphText,
  state: { hovered: boolean; focused: boolean; alpha: number },
): void {
  const { x, y, width, height, node } = placed;
  const external = node.kind === 'external';
  ctx.save();
  ctx.globalAlpha = state.alpha;

  roundedRect(ctx, x, y, width, height, CARD_RADIUS);
  ctx.fillStyle = external ? palette.subtle : palette.surface;
  ctx.fill();
  ctx.lineWidth = state.hovered || state.focused ? 2 : 1;
  ctx.strokeStyle = state.focused ? palette.focus : state.hovered ? palette.brand : node.kind === 'service' ? palette.borderStrong : palette.border;
  // Outside the stack: a dashed outline, so the card says so without relying
  // on its fill alone.
  ctx.setLineDash(external ? [4, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);

  const markName = markNameFor(node);
  if (markName) {
    ctx.save();
    ctx.translate(x + 12, y + 13);
    ctx.scale(MARK_SIZE / 24, MARK_SIZE / 24);
    for (const shape of markShapes(markName)) {
      ctx.fillStyle = shape.fill;
      ctx.fill(shape.path, 'evenodd');
    }
    ctx.restore();
  } else {
    roundedRect(ctx, x + 12, y + 13, MARK_SIZE, MARK_SIZE, 5);
    ctx.fillStyle = palette.borderStrong;
    ctx.fill();
    ctx.fillStyle = palette.surface;
    ctx.font = `700 8px ${palette.fontSans}`;
    ctx.textAlign = 'center';
    ctx.fillText(text.httpTile, x + 12 + MARK_SIZE / 2, y + 13 + MARK_SIZE / 2 + 3);
    ctx.textAlign = 'left';
  }

  const textLeft = x + 12 + MARK_SIZE + 10;
  const counter = text.counter(node);
  let counterWidth = 0;
  if (counter) {
    ctx.font = `600 10px ${palette.fontSans}`;
    counterWidth = ctx.measureText(counter.text).width + 8;
    ctx.fillStyle = counter.tone === 'danger' ? palette.danger : palette.muted;
    ctx.textAlign = 'right';
    ctx.fillText(counter.text, x + width - 10, y + 25);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = palette.text;
  ctx.font = `600 12px ${palette.fontMono}`;
  ctx.fillText(fitText(ctx, node.label, x + width - 10 - counterWidth - textLeft), textLeft, y + 25);
  ctx.fillStyle = palette.muted;
  ctx.font = `11px ${palette.fontSans}`;
  ctx.fillText(fitText(ctx, text.subtitle(node), x + width - 12 - textLeft), textLeft, y + 42);

  // Route chips: the verb in its status colour, the path in mono.
  let rowY = y + 54;
  for (const route of placed.routes) {
    const colours = methodColours(palette, route.method);
    ctx.font = `700 9.5px ${palette.fontMono}`;
    const chipWidth = Math.max(40, ctx.measureText(route.method).width + 12);
    roundedRect(ctx, x + 12, rowY, chipWidth, 15, 4);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.fillStyle = colours.text;
    ctx.textAlign = 'center';
    ctx.fillText(route.method, x + 12 + chipWidth / 2, rowY + 11);
    ctx.textAlign = 'left';
    ctx.fillStyle = palette.text;
    ctx.font = `11px ${palette.fontMono}`;
    ctx.fillText(fitText(ctx, route.path, width - chipWidth - 32), x + 12 + chipWidth + 8, rowY + 11.5);
    rowY += ROUTE_ROW_HEIGHT;
  }
  if (placed.hiddenRoutes > 0) {
    ctx.fillStyle = palette.muted;
    ctx.font = `11px ${palette.fontSans}`;
    ctx.fillText(text.moreRoutes(placed.hiddenRoutes), x + 12, rowY + 11.5);
  }
  ctx.restore();
}

function drawLegendSample(ctx: CanvasRenderingContext2D, key: LegendKey, x: number, y: number, palette: Palette): void {
  ctx.save();
  ctx.strokeStyle = palette.text;
  ctx.fillStyle = palette.text;
  if (key === 'external') {
    roundedRect(ctx, x, y - 7, 30, 14, 4);
    ctx.fillStyle = palette.subtle;
    ctx.fill();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = palette.borderStrong;
    ctx.stroke();
    ctx.restore();
    return;
  }
  const stroke = key === 'async' ? STROKES.async : key === 'inferred' ? STROKES.inferred : STROKES.sync;
  if (key === 'cross-service') {
    ctx.strokeStyle = palette.edge['cross-service'];
    ctx.fillStyle = palette.edge['cross-service'];
  }
  ctx.lineWidth = stroke.width;
  ctx.setLineDash(stroke.dash);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 30, y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (legendArrows(key).end) arrowhead(ctx, { x: x + 30, y }, { x, y });
  if (legendArrows(key).start) arrowhead(ctx, { x, y }, { x: x + 30, y });
  ctx.restore();
}

function drawLegend(ctx: CanvasRenderingContext2D, layout: GraphLayout, palette: Palette, text: GraphText): void {
  if (!layout.legend.length) return;
  const y = layout.legendY + 22;
  ctx.save();
  ctx.font = `11px ${palette.fontSans}`;
  const labels = layout.legend.map(key => text.legend(key));
  const positions = legendPositions(layout.legend, labels, label => ctx.measureText(label).width);
  layout.legend.forEach((key, index) => {
    drawLegendSample(ctx, key, positions[index], y, palette);
    ctx.fillStyle = palette.muted;
    ctx.fillText(labels[index], positions[index] + 40, y + 4);
  });
  ctx.restore();
}

// --- The view: pan, zoom, hover, focus -------------------------------------------------

export interface GraphViewHandlers {
  onActivate(node: GraphNode): void;
  onHover(node: GraphNode | null): void;
  // A frame header was clicked (the stack map collapses that service).
  onFrame?(group: string): void;
  onCursor(cursor: string): void;
  requestRedraw(): void;
  toPoint(event: { clientX: number; clientY: number }): CanvasSurfacePoint | null;
}

export interface GraphView {
  setLayout(layout: GraphLayout | null, text: GraphText, palette: Palette): void;
  draw(frame: CanvasSurfaceFrame): void;
  fit(): void;
  zoomBy(factor: number): void;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onPointerLeave(): void;
  onWheel(event: WheelEvent): void;
  onKeyDown(event: KeyboardEvent): void;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
// A press that moves less than this is a click, not a drag.
const CLICK_SLOP = 4;

/**
 * The interactive half of the diagram. Holds the view transform (fit on first
 * layout and whenever the drawing's size changes; preserved across a refetch
 * that lays out the same picture, so the user's zoom survives the 10 s poll),
 * the hover and keyboard focus, and the drag state.
 */
export function createGraphView(handlers: GraphViewHandlers): GraphView {
  let layout: GraphLayout | null = null;
  let text: GraphText | null = null;
  let palette: Palette | null = null;
  let size = { width: 0, height: 0 };
  let view = { scale: 1, x: 0, y: 0 };
  let fitted: string | null = null;
  let hovered: PlacedNode | null = null;
  let focusIndex = -1;
  let drag: { x: number; y: number; viewX: number; viewY: number; moved: boolean } | null = null;

  const fitView = () => {
    if (!layout || !size.width || !size.height) return;
    const scale = Math.max(MIN_ZOOM, Math.min(1, (size.width - 16) / layout.width, (size.height - 16) / layout.height));
    view = { scale, x: (size.width - layout.width * scale) / 2, y: Math.max(8, (size.height - layout.height * scale) / 2) };
  };
  const toDiagram = (point: CanvasSurfacePoint) => ({ x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale });
  const focused = () => (layout && focusIndex >= 0 ? layout.nodes[focusIndex] ?? null : null);
  const setHover = (next: PlacedNode | null) => {
    if (next?.node.id === hovered?.node.id) return;
    hovered = next;
    handlers.onHover(next ? next.node : null);
    handlers.requestRedraw();
  };
  const zoomAbout = (point: CanvasSurfacePoint, factor: number) => {
    const before = toDiagram(point);
    view.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
    view.x = point.x - before.x * view.scale;
    view.y = point.y - before.y * view.scale;
    handlers.requestRedraw();
  };

  const api: GraphView = {
    setLayout(next, nextText, nextPalette) {
      layout = next;
      text = nextText;
      palette = nextPalette;
      // A refetch replaces the node objects: re-resolve hover and focus by id.
      const hoveredId = hovered?.node.id;
      const focusedId = focused()?.node.id;
      hovered = hoveredId && layout ? layout.nodes.find(node => node.node.id === hoveredId) ?? null : null;
      focusIndex = focusedId && layout ? layout.nodes.findIndex(node => node.node.id === focusedId) : -1;
      const signature = layout ? `${layout.width}x${layout.height}` : null;
      if (signature !== fitted) {
        fitted = signature;
        fitView();
      }
      handlers.requestRedraw();
    },
    draw(frame) {
      const { context: ctx, width, height } = frame;
      const resized = width !== size.width || height !== size.height;
      size = { width, height };
      if (resized) fitView();
      ctx.clearRect(0, 0, width, height);
      if (!layout || !text || !palette) return;
      ctx.save();
      ctx.translate(view.x, view.y);
      ctx.scale(view.scale, view.scale);
      const focus = hovered ?? focused();
      const lit = focus ? neighbourhood(layout, focus.node.id) : null;
      for (const frameBox of layout.frames) drawFrame(ctx, frameBox, palette, text);
      for (const edge of layout.edges) {
        const touches = !focus || edge.edge.from === focus.node.id || edge.edge.to === focus.node.id;
        drawEdge(ctx, edge, palette, touches ? 1 : 0.12, Boolean(focus) && touches);
      }
      const focusedId = focused()?.node.id;
      for (const node of layout.nodes) {
        drawNode(ctx, node, palette, text, {
          hovered: hovered?.node.id === node.node.id,
          focused: focusedId === node.node.id,
          alpha: lit && !lit.has(node.node.id) ? 0.28 : 1,
        });
      }
      drawLegend(ctx, layout, palette, text);
      ctx.restore();
    },
    fit() {
      fitView();
      handlers.requestRedraw();
    },
    zoomBy(factor) {
      zoomAbout({ x: size.width / 2, y: size.height / 2 }, factor);
    },
    onPointerDown(event) {
      const point = handlers.toPoint(event);
      if (!point || event.button !== 0) return;
      drag = { x: point.x, y: point.y, viewX: view.x, viewY: view.y, moved: false };
      (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      const point = handlers.toPoint(event);
      if (!point || !layout) return;
      if (drag) {
        const dx = point.x - drag.x;
        const dy = point.y - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
        drag.moved = true;
        view.x = drag.viewX + dx;
        view.y = drag.viewY + dy;
        handlers.onCursor('grabbing');
        handlers.requestRedraw();
        return;
      }
      const at = toDiagram(point);
      const found = nodeAt(layout, at.x, at.y);
      const header = !found && handlers.onFrame ? frameHeaderAt(layout, at.x, at.y) : null;
      // The affordance cannot come from CSS: the hit area is a rectangle inside
      // the bitmap. It goes back to the surface through its `cursor` prop.
      handlers.onCursor(found || header ? 'pointer' : 'grab');
      setHover(found);
    },
    onPointerUp(event) {
      const point = handlers.toPoint(event);
      const wasDrag = drag?.moved ?? false;
      drag = null;
      (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
      if (!point || !layout || wasDrag) {
        handlers.onCursor('grab');
        return;
      }
      const at = toDiagram(point);
      const found = nodeAt(layout, at.x, at.y);
      if (found) {
        handlers.onActivate(found.node);
        return;
      }
      const header = handlers.onFrame ? frameHeaderAt(layout, at.x, at.y) : null;
      if (header) handlers.onFrame!(header.group);
    },
    onPointerLeave() {
      if (drag) return;
      handlers.onCursor('grab');
      setHover(null);
    },
    onWheel(event) {
      const point = handlers.toPoint(event);
      if (!point) return;
      event.preventDefault();
      // Zoom about the pointer, so what is under it stays under it.
      zoomAbout(point, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
    },
    onKeyDown(event) {
      if (!layout || !layout.nodes.length) return;
      const count = layout.nodes.length;
      // Reading order (column by column, top to bottom) for keyboard focus.
      const order = layout.nodes.map((node, index) => ({ node, index }))
        .sort((a, b) => a.node.column - b.node.column || a.node.y - b.node.y);
      const position = order.findIndex(entry => entry.index === focusIndex);
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          focusIndex = order[(position + 1) % count].index;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          focusIndex = order[(position - 1 + count) % count].index;
          break;
        case 'Enter':
        case ' ': {
          const node = focused();
          if (node) handlers.onActivate(node.node);
          event.preventDefault();
          return;
        }
        case 'Escape':
          focusIndex = -1;
          handlers.onHover(null);
          handlers.requestRedraw();
          return;
        case '+':
        case '=':
          api.zoomBy(1.2);
          return;
        case '-':
          api.zoomBy(1 / 1.2);
          return;
        case '0':
          api.fit();
          return;
        default:
          return;
      }
      event.preventDefault();
      const node = focused()!;
      handlers.onHover(node.node);
      // Keep the focused card on screen.
      const left = node.x * view.scale + view.x;
      const top = node.y * view.scale + view.y;
      if (left < 0 || top < 0 || left + node.width * view.scale > size.width || top + node.height * view.scale > size.height) {
        view.x = size.width / 2 - (node.x + node.width / 2) * view.scale;
        view.y = size.height / 2 - (node.y + node.height / 2) * view.scale;
      }
      handlers.requestRedraw();
    },
  };
  return api;
}

/**
 * Save an SVG string as a file. The anchor is never attached to the document:
 * it exists for the one synthetic click a download needs.
 */
export function downloadSvg(svg: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Call `onChange` whenever the theme flips. The theme is a `data-tree-theme`
 * attribute on <html> and there is no reactive token API, so the only way to
 * notice is to watch for it; branding overrides land in the same computed
 * values, so re-reading the palette covers both. Returns the disconnect.
 */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tree-theme'] });
  return () => observer.disconnect();
}
