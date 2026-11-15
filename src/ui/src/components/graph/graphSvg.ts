// The wiring diagram as a standalone SVG document — the "Download SVG" button
// on both graph screens, and the stack map at the top of the README
// (`docs/readme/stack-map.svg`, exported from `examples/self-hosted`).
//
// Pure: a layout, a palette and the translated text in, a string out. It paints
// the SAME layout the canvas paints (`graphLayout.ts`), with the same stroke,
// colour and mark decisions (`graphPaint.ts`), so the file is what the screen
// shows. Self-contained by construction — inline attributes only, no
// `<style>`, no `<image href>`, no web font (an SVG embedded through `<img>`
// cannot load one, which is how GitHub and npm render the README): text uses
// the token's font stack and is fitted with a per-glyph width table.
//
// The AWS marks are emitted from the vendored artwork verbatim — the same
// elements and attributes, scaled uniformly — as rule 3 and `NOTICE.md`
// require.
import { awsIconArtwork } from '../../icons/aws/artwork.generated';
import type { AwsIconNode } from '../../icons/aws/types';
import type { GraphLayout, PlacedEdge, PlacedFrame, PlacedNode, Point } from './graphLayout';
import { ROUTE_ROW_HEIGHT } from './graphLayout';
import type { Palette } from './graphPaint';
import {
  CARD_RADIUS, FRAME_RADIUS, MARK_SIZE, STROKES, legendArrows, legendPositions, longestLeg, markNameFor, methodColours,
} from './graphPaint';
import type { GraphText } from './graphText';

// --- Text metrics --------------------------------------------------------------

// Average advance per glyph class, as a fraction of the font size, for a
// typical system sans (narrow/regular/wide/caps) — enough to fit a label inside
// a card without a browser to measure it. Mono is a flat 0.6.
const NARROW = new Set('iljtfI.,:;|!\'`()[]{} '.split(''));
const WIDE = new Set('mwMW@%'.split(''));

/** Approximate rendered width of `text` at `size` px. */
export function textWidth(text: string, size: number, mono = false, bold = false): number {
  let width = 0;
  for (const char of text) {
    if (mono) width += 0.6;
    else if (NARROW.has(char)) width += 0.3;
    else if (WIDE.has(char)) width += 0.85;
    else if (char >= 'A' && char <= 'Z') width += 0.66;
    else width += 0.55;
  }
  return width * size * (bold ? 1.06 : 1);
}

function fit(text: string, max: number, size: number, mono = false, bold = false): string {
  if (max <= 0) return '';
  if (textWidth(text, size, mono, bold) <= max) return text;
  let cut = text.length;
  while (cut > 0 && textWidth(`${text.slice(0, cut)}…`, size, mono, bold) > max) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const r2 = (value: number) => Math.round(value * 100) / 100;

// --- Shapes ----------------------------------------------------------------------

// The canvas softens corners with `arcTo`; SVG gets the same look with a
// quadratic curve through each corner.
export function roundedPolyline(points: readonly Point[], radius: number): string {
  let d = `M${r2(points[0].x)} ${r2(points[0].y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1];
    const here = points[index];
    const next = points[index + 1];
    const inLength = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLength = Math.hypot(next.x - here.x, next.y - here.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const ax = here.x - ((here.x - prev.x) / inLength) * r;
    const ay = here.y - ((here.y - prev.y) / inLength) * r;
    const bx = here.x + ((next.x - here.x) / outLength) * r;
    const by = here.y + ((next.y - here.y) / outLength) * r;
    d += ` L${r2(ax)} ${r2(ay)} Q${r2(here.x)} ${r2(here.y)} ${r2(bx)} ${r2(by)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${r2(last.x)} ${r2(last.y)}`;
}

function arrow(tip: Point, from: Point, colour: string): string {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const a = `${r2(tip.x - 8 * cos + 4 * sin)},${r2(tip.y - 8 * sin - 4 * cos)}`;
  const b = `${r2(tip.x - 8 * cos - 4 * sin)},${r2(tip.y - 8 * sin + 4 * cos)}`;
  return `<polygon points="${r2(tip.x)},${r2(tip.y)} ${a} ${b}" fill="${colour}"/>`;
}

function markSvg(nodes: readonly AwsIconNode[]): string {
  return nodes.map(node => {
    const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
    const children = node.children ? markSvg(node.children) : '';
    return children ? `<${node.tag}${attrs}>${children}</${node.tag}>` : `<${node.tag}${attrs}/>`;
  }).join('');
}

function edgeSvg(placed: PlacedEdge, palette: Palette): string {
  const colour = palette.edge[placed.colourKind] ?? palette.muted;
  const stroke = STROKES[placed.stroke];
  const weight = placed.edge.weight ?? 1;
  const width = stroke.width + (weight > 1 ? Math.min(weight, 6) * 0.35 : 0);
  const dash = stroke.dash.length ? ` stroke-dasharray="${stroke.dash.join(' ')}"` : '';
  const opacity = placed.stroke === 'link' ? ' stroke-opacity="0.7"' : '';
  const points = placed.points;
  let out = `<path d="${roundedPolyline(points, 6)}" fill="none" stroke="${colour}" stroke-width="${r2(width)}"${dash}${opacity}/>`;
  if (placed.arrowEnd) out += arrow(points[points.length - 1], points[points.length - 2], colour);
  if (placed.arrowStart) out += arrow(points[0], points[1], colour);
  if (weight > 1) {
    const leg = longestLeg(points);
    const mx = (points[leg].x + points[leg + 1].x) / 2;
    const my = (points[leg].y + points[leg + 1].y) / 2;
    const label = String(weight);
    const w = textWidth(label, 10, false, true) + 10;
    out += `<rect x="${r2(mx - w / 2)}" y="${r2(my - 8)}" width="${r2(w)}" height="16" rx="8" fill="${palette.surface}" stroke="${colour}"/>`;
    out += `<text x="${r2(mx)}" y="${r2(my + 3.5)}" text-anchor="middle" font-size="10" font-weight="600" fill="${palette.text}">${label}</text>`;
  }
  return out;
}

function frameSvg(frame: PlacedFrame, palette: Palette): string {
  return `<rect x="${r2(frame.x)}" y="${r2(frame.y)}" width="${r2(frame.width)}" height="${r2(frame.height)}" rx="${FRAME_RADIUS}" fill="${palette.subtle}" stroke="${palette.border}"/>`
    + `<text x="${r2(frame.x + 16)}" y="${r2(frame.y + 20)}" font-size="13" font-weight="600" fill="${palette.text}">${escape(fit(frame.group, frame.width - 160, 13, false, true))}</text>`;
}

function nodeSvg(placed: PlacedNode, palette: Palette, text: GraphText): string {
  const { x, y, width, height, node } = placed;
  const external = node.kind === 'external';
  let out = `<rect x="${r2(x)}" y="${r2(y)}" width="${width}" height="${height}" rx="${CARD_RADIUS}" fill="${external ? palette.subtle : palette.surface}" stroke="${node.kind === 'service' ? palette.borderStrong : palette.border}"${external ? ' stroke-dasharray="4 3"' : ''}/>`;
  const mark = markNameFor(node);
  if (mark) {
    out += `<g transform="translate(${r2(x + 12)} ${r2(y + 13)}) scale(${MARK_SIZE / 24})">${markSvg(awsIconArtwork[mark].nodes)}</g>`;
  } else {
    out += `<rect x="${r2(x + 12)}" y="${r2(y + 13)}" width="${MARK_SIZE}" height="${MARK_SIZE}" rx="5" fill="${palette.borderStrong}"/>`
      + `<text x="${r2(x + 12 + MARK_SIZE / 2)}" y="${r2(y + 13 + MARK_SIZE / 2 + 3)}" text-anchor="middle" font-size="8" font-weight="700" fill="${palette.surface}">${escape(text.httpTile)}</text>`;
  }
  const left = x + 12 + MARK_SIZE + 10;
  const counter = text.counter(node);
  let counterWidth = 0;
  if (counter) {
    counterWidth = textWidth(counter.text, 10, false, true) + 8;
    out += `<text x="${r2(x + width - 10)}" y="${r2(y + 25)}" text-anchor="end" font-size="10" font-weight="600" fill="${counter.tone === 'danger' ? palette.danger : palette.muted}">${escape(counter.text)}</text>`;
  }
  out += `<text x="${r2(left)}" y="${r2(y + 25)}" font-family="${escape(palette.fontMono)}" font-size="12" font-weight="600" fill="${palette.text}">${escape(fit(node.label, x + width - 10 - counterWidth - left, 12, true, true))}</text>`;
  out += `<text x="${r2(left)}" y="${r2(y + 42)}" font-size="11" fill="${palette.muted}">${escape(fit(text.subtitle(node), x + width - 12 - left, 11))}</text>`;
  let rowY = y + 54;
  for (const route of placed.routes) {
    const colours = methodColours(palette, route.method);
    const chip = Math.max(40, textWidth(route.method, 9.5, true, true) + 12);
    out += `<rect x="${r2(x + 12)}" y="${r2(rowY)}" width="${r2(chip)}" height="15" rx="4" fill="${colours.fill}"/>`
      + `<text x="${r2(x + 12 + chip / 2)}" y="${r2(rowY + 11)}" text-anchor="middle" font-family="${escape(palette.fontMono)}" font-size="9.5" font-weight="700" fill="${colours.text}">${escape(route.method)}</text>`
      + `<text x="${r2(x + 12 + chip + 8)}" y="${r2(rowY + 11.5)}" font-family="${escape(palette.fontMono)}" font-size="11" fill="${palette.text}">${escape(fit(route.path, width - chip - 32, 11, true))}</text>`;
    rowY += ROUTE_ROW_HEIGHT;
  }
  if (placed.hiddenRoutes > 0) {
    out += `<text x="${r2(x + 12)}" y="${r2(rowY + 11.5)}" font-size="11" fill="${palette.muted}">${escape(text.moreRoutes(placed.hiddenRoutes))}</text>`;
  }
  return out;
}

function legendSvg(layout: GraphLayout, palette: Palette, text: GraphText): string {
  if (!layout.legend.length) return '';
  const y = layout.legendY + 22;
  const labels = layout.legend.map(key => text.legend(key));
  const positions = legendPositions(layout.legend, labels, label => textWidth(label, 11));
  return layout.legend.map((key, index) => {
    const x = positions[index];
    let sample: string;
    if (key === 'external') {
      sample = `<rect x="${x}" y="${y - 7}" width="30" height="14" rx="4" fill="${palette.subtle}" stroke="${palette.borderStrong}" stroke-dasharray="4 3"/>`;
    } else {
      const stroke = key === 'async' ? STROKES.async : key === 'inferred' ? STROKES.inferred : STROKES.sync;
      const colour = key === 'cross-service' ? palette.edge['cross-service'] : palette.text;
      const dash = stroke.dash.length ? ` stroke-dasharray="${stroke.dash.join(' ')}"` : '';
      sample = `<line x1="${x}" y1="${y}" x2="${x + 30}" y2="${y}" stroke="${colour}" stroke-width="${stroke.width}"${dash}/>`;
      const arrows = legendArrows(key);
      if (arrows.end) sample += arrow({ x: x + 30, y }, { x, y }, colour);
      if (arrows.start) sample += arrow({ x, y }, { x: x + 30, y }, colour);
    }
    return `${sample}<text x="${x + 40}" y="${y + 4}" font-size="11" fill="${palette.muted}">${escape(labels[index])}</text>`;
  }).join('');
}

/**
 * Render a laid-out graph as an SVG document. `title` becomes the document's
 * `<title>` (its accessible name when embedded with `<img>`).
 */
export function renderGraphSvg(layout: GraphLayout, palette: Palette, text: GraphText, title: string): string {
  const body = [
    `<rect width="${layout.width}" height="${layout.height}" fill="${palette.page}"/>`,
    ...layout.frames.map(frame => frameSvg(frame, palette)),
    ...layout.edges.map(edge => edgeSvg(edge, palette)),
    ...layout.nodes.map(node => nodeSvg(node, palette, text)),
    legendSvg(layout, palette, text),
  ].join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" font-family="${escape(palette.fontSans)}">`,
    `<title>${escape(title)}</title>`,
    body,
    '</svg>',
    '',
  ].join('\n');
}
