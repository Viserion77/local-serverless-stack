// The drawing surface for the service wiring diagram.
//
// This is the ONE place in `src/ui/` that paints instead of composing TreeUI.
// It exists under an approved temporary exception to rule 2 of `ui-ux.md`,
// recorded in that file's exception table and negotiated with the library as
// TREEUX-018: `@treeui/vue@0.29.0` has no node-edge primitive (TChart is
// categorical `number[]` aligned to labels, TSpanLanes is 1-D bars in a row,
// TTreeView is a DOM list), and its one canvas composable —
// `useDecorativeCanvas` — is contractually decorative: pointer-transparent, no
// `requestRedraw()`, and gated on `(pointer: coarse)` and reduced-motion, so on
// a touch device it paints exactly one frame and never repaints when the data,
// the locale or the theme changes. A diagram whose nodes are click targets and
// whose content refetches every 10 s needs the opposite of all three.
//
// Everything it borrows, it borrows properly:
//  - colours come from the TreeUI design tokens via `getComputedStyle`, so the
//    drawing follows the theme AND any `branding.colors` override the user set
//    in `lss.config.json` — no literal hex anywhere;
//  - the service marks are the vendored AWS Architecture artwork, reproduced
//    unmodified (uniform scale only, original fills) as the pack's terms and
//    `ui-ux.md` rule 3 require;
//  - every string it draws arrives already translated. It calls no `t()` itself.
import { awsIconArtwork } from '../../icons/aws';
import type { AwsIconName, AwsIconNode } from '../../icons/aws';
import { graphNodeIcons } from '../../icons/resourceIcons';
import type { GraphEdgeKind, GraphNode, ServiceGraph } from '../../services/api';
import type { GraphLayout, PlacedEdge, PlacedNode } from './graphLayout';
import { EDGE_STYLES, layoutGraph, nodeAt } from './graphLayout';

/**
 * Re-exported so `ServiceGraphCard.vue` can type its template ref without
 * naming a DOM global. In a `.vue` file `HTMLCanvasElement` is an ESLint
 * `no-undef` ERROR even in type position — see the note at the top of
 * `graphLayout.ts`.
 */
export type GraphCanvas = HTMLCanvasElement;

export interface GraphSurfaceHandlers {
  // A node was clicked. The card turns it into navigation; the surface does not
  // know the router exists.
  onActivate(node: GraphNode): void;
  // Hover moved onto a node or off every node. Drives the card's detail strip.
  onHover(node: GraphNode | null): void;
}

export interface GraphSurface {
  render(graph: ServiceGraph | null, hidden: ReadonlySet<GraphEdgeKind>): void;
  destroy(): void;
}

// Token → the value to fall back on if the name is ever wrong. This repo has
// shipped `--tree-font-mono` (real name `--tree-font-family-mono`) and
// `--tree-color-border` (real name `--tree-color-border-default`) as silent
// fallbacks before, the second one rendering light-on-dark; a canvas reading
// tokens by string is exactly that failure mode, so the names live in one map
// and every read goes through it.
const TOKENS = {
  surface: ['--tree-color-bg-surface', '#ffffff'],
  subtle: ['--tree-color-bg-subtle', '#f3f4f6'],
  border: ['--tree-color-border-default', '#e5e7eb'],
  borderStrong: ['--tree-color-border-strong', '#9ca3af'],
  text: ['--tree-color-text-primary', '#111827'],
  muted: ['--tree-color-text-muted', '#6b7280'],
  brand: ['--tree-color-brand-primary', '#0d9488'],
  focus: ['--tree-color-focus-ring', '#2563eb'],
  fontSans: ['--tree-font-family-sans', 'system-ui, sans-serif'],
  fontMono: ['--tree-font-family-mono', 'ui-monospace, monospace'],
} as const;

type TokenName = keyof typeof TOKENS;

type Palette = Record<TokenName, string> & { edge: Record<GraphEdgeKind, string> };

function readPalette(): Palette {
  const style = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  const palette = {} as Palette;
  for (const [key, [name, fallback]] of Object.entries(TOKENS)) {
    palette[key as TokenName] = read(name, fallback);
  }
  palette.edge = {} as Record<GraphEdgeKind, string>;
  for (const [kind, style_] of Object.entries(EDGE_STYLES)) {
    palette.edge[kind as GraphEdgeKind] = read(style_.token, palette.muted);
  }
  return palette;
}

// --- AWS marks ---------------------------------------------------------------

interface MarkShape {
  path: Path2D;
  fill: string;
}

/**
 * Flatten one vendored mark into Path2D shapes on its native 24x24 grid.
 *
 * The artwork is a small, closed vocabulary — three tags (`g`, `rect`, `path`),
 * eight attribute names, and every `transform` a pure `translate(a, b)` — which
 * is what makes this walker forty lines instead of an SVG renderer. The fill is
 * inherited from the nearest ancestor `<g fill>` because roughly a third of the
 * pack (Amazon S3 among them) puts the white glyph fill on the group rather
 * than on the path.
 *
 * The marks are NOT tinted, and must not be: they are AWS trademarks vendored
 * on the condition that they are reproduced unmodified, which is also why they
 * are the one thing on this canvas that ignores the theme.
 */
function flattenMark(nodes: readonly AwsIconNode[], inheritedFill: string, dx: number, dy: number): MarkShape[] {
  const shapes: MarkShape[] = [];
  for (const node of nodes) {
    const fill = node.attrs.fill ?? inheritedFill;
    let offsetX = dx;
    let offsetY = dy;
    const transform = node.attrs.transform;
    if (transform) {
      const match = /translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)/.exec(transform);
      if (match) {
        offsetX += Number(match[1]);
        offsetY += Number(match[2]);
      }
    }
    if (node.tag === 'rect') {
      const path = new Path2D();
      path.rect(
        Number(node.attrs.x ?? 0) + offsetX,
        Number(node.attrs.y ?? 0) + offsetY,
        Number(node.attrs.width ?? 0),
        Number(node.attrs.height ?? 0),
      );
      shapes.push({ path, fill });
    } else if (node.tag === 'path' && node.attrs.d) {
      // `addPath` with a matrix is the only way to bake a translate into a
      // Path2D built from a `d` string — the alternative is translating the
      // context per shape, which would not compose with the group nesting.
      const path = new Path2D();
      path.addPath(new Path2D(node.attrs.d), new DOMMatrix().translate(offsetX, offsetY));
      shapes.push({ path, fill });
    }
    if (node.children) shapes.push(...flattenMark(node.children, fill, offsetX, offsetY));
  }
  return shapes;
}

// Built once per mark and reused for every node that carries it — a 60-function
// service draws the Lambda mark sixty times per frame.
const markCache = new Map<string, MarkShape[]>();

function markFor(kind: GraphNode['kind']): MarkShape[] | null {
  const name = graphNodeIcons[kind];
  // `external` deliberately maps to a TreeUI glyph rather than a brand (it does
  // not stand for one AWS service), and TreeUI glyphs are stroked with
  // `currentColor` — drawing one here would mean re-implementing that stroking
  // and would breach rule 3's "functional icons come only from TreeUI". Those
  // nodes are drawn with a lettered chip instead.
  if (!name.startsWith('aws-')) return null;
  const cached = markCache.get(name);
  if (cached) return cached;
  const artwork = awsIconArtwork[name as AwsIconName];
  if (!artwork) return null;
  const shapes = flattenMark(artwork.nodes, '#000000', 0, 0);
  markCache.set(name, shapes);
  return shapes;
}

// --- Drawing -----------------------------------------------------------------

const MARK_SIZE = 22;
const RADIUS = 8;
// Below this the 12 px node label falls under ~7 px and stops being readable,
// so the diagram stops shrinking and the host scrolls instead.
const MIN_SCALE = 0.6;

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Ellipsis by measurement rather than by character count: a proportional font
// makes `WWWWWW` twice as wide as `iiiiii`, and the names here are arbitrary.
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
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

function drawEdge(ctx: CanvasRenderingContext2D, placed: PlacedEdge, palette: Palette, dimmed: boolean): void {
  const style = EDGE_STYLES[placed.edge.kind];
  const colour = palette.edge[placed.edge.kind] ?? palette.muted;
  ctx.save();
  ctx.globalAlpha = dimmed ? 0.18 : 1;
  ctx.strokeStyle = colour;
  // Inferred links are thinner as well as dashed. The two weak kinds (`iam`
  // fan-out, `env` name match) are the most numerous on a real service, and if
  // they carried the same weight as a declared route the diagram's loudest
  // signal would be its least trustworthy one.
  ctx.lineWidth = placed.edge.confidence === 'inferred' ? 1 : 1.75;
  ctx.setLineDash(style.dashed ? [5, 4] : []);

  const dx = Math.max(36, Math.abs(placed.toX - placed.fromX) * 0.45);
  ctx.beginPath();
  ctx.moveTo(placed.fromX, placed.fromY);
  if (placed.backwards) {
    // Same-side departure and arrival: bow the curve outwards so a return path
    // reads as a return path and does not disappear behind the boxes.
    const bow = 40;
    ctx.bezierCurveTo(
      placed.fromX - bow, placed.fromY,
      placed.toX + bow, placed.toY,
      placed.toX, placed.toY,
    );
  } else {
    ctx.bezierCurveTo(
      placed.fromX + dx, placed.fromY,
      placed.toX - dx, placed.toY,
      placed.toX, placed.toY,
    );
  }
  ctx.stroke();

  // Arrowhead at the target, pointing the way the link flows. Direction is the
  // whole point of this diagram — "who calls whom" is the question it answers.
  const inward = placed.backwards ? -1 : 1;
  ctx.setLineDash([]);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(placed.toX, placed.toY);
  ctx.lineTo(placed.toX - 8 * inward, placed.toY - 4);
  ctx.lineTo(placed.toX - 8 * inward, placed.toY + 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  placed: PlacedNode,
  palette: Palette,
  state: { hovered: boolean; dimmed: boolean },
): void {
  const { x, y, width, height, node } = placed;
  ctx.save();
  ctx.globalAlpha = state.dimmed ? 0.3 : 1;

  roundedRect(ctx, x, y, width, height, RADIUS);
  ctx.fillStyle = node.kind === 'external' ? palette.subtle : palette.surface;
  ctx.fill();
  ctx.lineWidth = state.hovered ? 2 : 1;
  ctx.strokeStyle = state.hovered ? palette.brand : palette.border;
  // An external node is drawn with a dashed outline: it belongs to another
  // service, and the picture should say so without relying on the fill alone.
  ctx.setLineDash(node.kind === 'external' ? [4, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);

  const mark = markFor(node.kind);
  const textLeft = x + 12 + (mark ? MARK_SIZE + 10 : 0);
  if (mark) {
    ctx.save();
    ctx.translate(x + 12, y + (height - MARK_SIZE) / 2);
    ctx.scale(MARK_SIZE / 24, MARK_SIZE / 24);
    for (const shape of mark) {
      ctx.fillStyle = shape.fill;
      ctx.fill(shape.path, 'evenodd');
    }
    ctx.restore();
  }

  const maxText = x + width - 12 - textLeft;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = palette.text;
  // Routes and ARNs are identifiers, so they take the mono face — the same
  // decision `TText family="mono"` expresses everywhere else in this dashboard.
  ctx.font = `600 12px ${node.kind === 'route' ? palette.fontMono : palette.fontSans}`;
  ctx.fillText(fitText(ctx, node.label, maxText), textLeft, y + (node.handler || node.arn ? 21 : 29));

  const secondary = node.handler ?? node.arn ?? '';
  if (secondary) {
    ctx.fillStyle = palette.muted;
    ctx.font = `11px ${palette.fontMono}`;
    ctx.fillText(fitText(ctx, secondary, maxText), textLeft, y + 35);
  }
  ctx.restore();
}

/**
 * Wire a canvas element to a graph.
 *
 * Owns exactly four things the TreeUI composable does not provide: a
 * container-relative size (the rule-2 exception — no TreeUI prop stretches an
 * arbitrary child, and `useDecorativeCanvas` measures but never sizes), a
 * repaint on demand, pointer hit-testing, and a re-read of the design tokens
 * whenever the theme or the branding changes.
 */
export function createGraphSurface(canvas: GraphCanvas, handlers: GraphSurfaceHandlers): GraphSurface {
  let graph: ServiceGraph | null = null;
  let hidden: ReadonlySet<GraphEdgeKind> = new Set();
  let layout: GraphLayout | null = null;
  let palette = readPalette();
  let hovered: PlacedNode | null = null;
  let frame = 0;
  // The factor the drawing is currently shrunk by. Pointer coordinates arrive
  // in CSS pixels and the layout is in diagram units, so hit-testing has to
  // undo it.
  let scale = 1;

  const paint = (): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx || !layout) return;

    const host = canvas.parentElement;
    const available = host?.clientWidth ?? 0;
    // A hidden tab measures 0. Painting then would compute a scale of 0 and
    // blank the canvas, and the resize that follows re-showing it repaints
    // anyway — so hold the last frame instead.
    if (available === 0) return;

    // Fit the diagram to the space it has. A four-function service lays out
    // 1168 px wide, which is more than the card gets on most screens, and the
    // old behaviour — draw at full size and let the host scroll — pushed a
    // horizontal scrollbar onto a picture whose whole job is to be taken in at
    // a glance. Shrinking is the better trade right up to the point where the
    // labels stop being readable; past MIN_SCALE the diagram is genuinely too
    // big for the card and scrolling is the honest answer.
    scale = Math.min(1, Math.max(MIN_SCALE, available / layout.width));
    const drawnWidth = layout.width * scale;
    // Fill the host when the diagram is narrower than it, so the picture is
    // never a small drawing floating in a wide empty box.
    const cssWidth = Math.max(available, drawnWidth);
    const cssHeight = layout.height * scale;

    // The backing store is sized in device pixels and the element in CSS
    // pixels, so the drawing is sharp on a HiDPI screen. Capped at 2 because
    // beyond that the memory cost of a wide diagram buys nothing visible.
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
    ctx.clearRect(0, 0, cssWidth / scale, cssHeight / scale);

    // Hovering a node fades everything it is not connected to. On a service
    // with sixty functions that is the difference between a diagram and a mesh.
    const connected = new Set<string>();
    if (hovered) {
      connected.add(hovered.node.id);
      for (const placed of layout.edges) {
        if (placed.edge.from === hovered.node.id) connected.add(placed.edge.to);
        if (placed.edge.to === hovered.node.id) connected.add(placed.edge.from);
      }
    }

    for (const placed of layout.edges) {
      if (hidden.has(placed.edge.kind)) continue;
      const touches = !hovered
        || placed.edge.from === hovered.node.id
        || placed.edge.to === hovered.node.id;
      drawEdge(ctx, placed, palette, !touches);
    }
    for (const placed of layout.nodes) {
      drawNode(ctx, placed, palette, {
        hovered: hovered?.node.id === placed.node.id,
        dimmed: Boolean(hovered) && !connected.has(placed.node.id),
      });
    }
  };

  // Coalesce the repaint triggers — a resize, a theme flip and a refetch can
  // land in the same tick, and painting three times would be three times the
  // work for one picture.
  const schedule = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  // Pointer coordinates come in CSS pixels; the layout is in unscaled diagram
  // units. Undo the fit factor or every hit lands short of its box.
  const pointAt = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!layout) return;
    const { x, y } = pointAt(event);
    const found = nodeAt(layout, x, y);
    if (found?.node.id === hovered?.node.id) return;
    hovered = found;
    // The affordance has to be set here rather than in CSS: the hit area is a
    // rectangle inside a canvas, and no stylesheet can know where it is.
    canvas.style.cursor = found ? 'pointer' : 'default';
    handlers.onHover(found ? found.node : null);
    schedule();
  };

  const onPointerLeave = (): void => {
    if (!hovered) return;
    hovered = null;
    canvas.style.cursor = 'default';
    handlers.onHover(null);
    schedule();
  };

  const onClick = (event: MouseEvent): void => {
    if (!layout) return;
    const { x, y } = pointAt(event);
    const found = nodeAt(layout, x, y);
    if (found) handlers.onActivate(found.node);
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);

  const observer = new ResizeObserver(schedule);
  const host = canvas.parentElement;
  if (host) {
    observer.observe(host);
    // The second half of the rule-2 exception. A wide service lays out wider
    // than the card, and the only alternatives are truncating the diagram or
    // letting the page scroll sideways — `ui-ux.md` rule 4 rules out the
    // second, and the first hides data. TreeUI has no scroll-container prop
    // (TPane fills its parent; nothing takes an axis), so the canvas's own host
    // is told to scroll. It is set once, on the element this module owns, and
    // never on a `t-*` class.
    host.style.overflowX = 'auto';
    host.style.maxWidth = '100%';
    // Without this the host is a flex item with the default `min-width: auto`,
    // so it refuses to shrink below the canvas it contains: instead of the box
    // scrolling, the CARD grows and the whole page scrolls sideways. That is
    // the "weird scroll" this element exists to contain.
    host.style.minWidth = '0';
    host.style.width = '100%';
  }

  // The theme is a `data-tree-theme` attribute on <html> and there is no
  // reactive token API, so the only way to notice a flip is to watch for it.
  // Branding overrides arrive as a <style> element injected into <head> at
  // runtime (the Settings screen can change them mid-session), which lands in
  // the same computed values — re-reading covers both.
  const themeObserver = new MutationObserver(() => {
    palette = readPalette();
    schedule();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tree-theme'] });

  return {
    render(next, nextHidden) {
      graph = next;
      hidden = nextHidden;
      layout = graph ? layoutGraph(graph) : null;
      // A refetch replaces the node objects, so a stale hover would point at an
      // object no longer in the layout — re-resolve it by id instead of keeping
      // the reference.
      hovered = hovered && layout
        ? layout.nodes.find(node => node.node.id === hovered!.node.id) ?? null
        : null;
      palette = readPalette();
      schedule();
    },
    destroy() {
      if (frame) window.cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('click', onClick);
      observer.disconnect();
      themeObserver.disconnect();
    },
  };
}
