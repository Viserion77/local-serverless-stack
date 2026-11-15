// The pure half of the README card generator: manifest + icons in, SVG strings
// out. CommonJS and dependency-free on purpose — the generator
// (`scripts/readme-cards.mjs`) and the guard test
// (`tests/unit/docs/readme-cards.test.ts`) both load it, and the test
// regenerates every card in memory and compares it byte for byte with the
// committed file, so a stale card fails CI.
//
// Why SVG and not PNG: GitHub and npm render README images through `<img>`,
// which scales an SVG crisply and serves a 2 KB file. The catch is that an
// `<img>`-embedded SVG cannot load a web font, so the cards use the system
// font stacks below — and since nothing measures text at generation time, a
// per-glyph width table does, and the generator FAILS when a title or a
// subtitle would overflow its card rather than shipping a clipped one.
'use strict';

const fs = require('fs');
const path = require('path');

const WIDTH = 296;
const HEIGHT = 64;
const TILE = 40;
const TEXT_LEFT = 64;
// Room the chevron keeps on the right.
const TEXT_RIGHT = 36;

const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// GitHub's own surface colours for each colour scheme, so a card sits in the
// README like a native element. `accent` fills the tile of a card whose icon
// is a functional glyph (the AWS marks bring their own tile).
const THEMES = {
  dark: { background: '#161b22', border: '#30363d', title: '#e6edf3', subtitle: '#8d96a0', chevron: '#8d96a0', accent: '#0f766e', glyph: '#ffffff' },
  light: { background: '#ffffff', border: '#d0d7de', title: '#1f2328', subtitle: '#59636e', chevron: '#59636e', accent: '#0d9488', glyph: '#ffffff' },
};

// Average advance per glyph, as a fraction of the font size, for the widest
// of the common system sans faces (Segoe UI / Helvetica bold) — erring wide
// so a card that passes here does not clip on any platform. Mono is 0.6 flat.
const NARROW = new Set("iljtfIr.,:;|!'`()[]{} ".split(''));
const WIDE = new Set('mwMW@%'.split(''));

function measure(text, size, { mono = false, bold = false } = {}) {
  let width = 0;
  for (const char of text) {
    if (mono) width += 0.6;
    else if (NARROW.has(char)) width += 0.32;
    else if (WIDE.has(char)) width += 0.9;
    else if (char >= 'A' && char <= 'Z') width += 0.7;
    else width += 0.58;
  }
  return width * size * (bold && !mono ? 1.07 : 1);
}

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The vendored AWS artwork tree, emitted verbatim (rule 3 of src/ui/ui-ux.md:
// the marks are reproduced unmodified, uniform scaling only).
function awsNodesToSvg(nodes) {
  return nodes.map((node) => {
    const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
    return node.children && node.children.length
      ? `<${node.tag}${attrs}>${awsNodesToSvg(node.children)}</${node.tag}>`
      : `<${node.tag}${attrs}/>`;
  }).join('');
}

// A TreeUI (Branchline) glyph: `[tag, attrs][]` on a 24×24 grid, stroked.
function glyphToSvg(nodes, colour) {
  const body = nodes.map(([tag, attrs]) =>
    `<${tag}${Object.entries(attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}/>`).join('');
  return `<g fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

/** Render one card for one theme. Throws when the text would not fit. */
function renderCard(card, themeName, icons) {
  const theme = THEMES[themeName];
  const maxText = WIDTH - TEXT_LEFT - TEXT_RIGHT;
  const titleWidth = measure(card.title, 14, { bold: true });
  const subtitleWidth = measure(card.subtitle, 11.5, { mono: true });
  if (titleWidth > maxText) throw new Error(`Card "${card.id}": title "${card.title}" is ${Math.ceil(titleWidth)} px, the card has ${maxText}`);
  if (subtitleWidth > maxText) throw new Error(`Card "${card.id}": subtitle "${card.subtitle}" is ${Math.ceil(subtitleWidth)} px, the card has ${maxText}`);

  let tile;
  if (card.icon.aws) {
    const artwork = icons.aws[card.icon.aws];
    if (!artwork) throw new Error(`Card "${card.id}": no vendored AWS mark "${card.icon.aws}"`);
    tile = `<g transform="translate(12 12) scale(${TILE / 24})">${awsNodesToSvg(artwork.nodes)}</g>`;
  } else {
    const glyph = icons.tree[card.icon.glyph];
    if (!glyph) throw new Error(`Card "${card.id}": no TreeUI glyph "${card.icon.glyph}"`);
    tile = `<rect x="12" y="12" width="${TILE}" height="${TILE}" rx="8" fill="${theme.accent}"/>`
      + `<g transform="translate(20 20)">${glyphToSvg(glyph, theme.glyph)}</g>`;
  }
  const chevron = icons.tree['chevron-right'];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
    `<title>${escape(card.title)} — ${escape(card.subtitle)}</title>`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="10" fill="${theme.background}" stroke="${theme.border}"/>`,
    tile,
    `<text x="${TEXT_LEFT}" y="29" font-family="${escape(FONT_SANS)}" font-size="14" font-weight="600" fill="${theme.title}">${escape(card.title)}</text>`,
    `<text x="${TEXT_LEFT}" y="47" font-family="${escape(FONT_MONO)}" font-size="11.5" fill="${theme.subtitle}">${escape(card.subtitle)}</text>`,
    `<g transform="translate(${WIDTH - 30} 22) scale(${20 / 24})">${glyphToSvg(chevron, theme.chevron)}</g>`,
    '</svg>',
    '',
  ].join('\n');
}

/** Every file the manifest produces: `<id>-dark.svg` and `<id>-light.svg`. */
function renderAll(manifest, icons) {
  const files = new Map();
  for (const group of manifest.groups) {
    for (const card of group.cards) {
      for (const theme of Object.keys(THEMES)) files.set(`${card.id}-${theme}.svg`, renderCard(card, theme, icons));
    }
  }
  return files;
}

// --- Icon sources ------------------------------------------------------------

/**
 * The vendored AWS artwork, read from the generated TypeScript module without
 * a TypeScript toolchain: past its type annotation the exported value is a
 * plain object literal.
 */
function parseAwsArtwork(source) {
  const marker = source.indexOf('export const awsIconArtwork');
  const start = source.indexOf('= {', marker);
  const end = source.lastIndexOf('};');
  if (marker === -1 || start === -1 || end === -1) throw new Error('Unrecognised artwork.generated.ts');
  return new Function(`return (${source.slice(start + 2, end + 1)});`)();
}

/**
 * Load both icon sources the repository already carries: the vendored AWS
 * marks (`src/ui/src/icons/aws`) and TreeUI's MIT-licensed Branchline glyphs,
 * resolved through the dashboard's own `@treeui/vue` dependency (npm nests
 * `@treeui/icons` under it).
 */
function loadIcons(root) {
  const aws = parseAwsArtwork(fs.readFileSync(path.join(root, 'src/ui/src/icons/aws/artwork.generated.ts'), 'utf8'));
  const vue = path.dirname(path.dirname(require.resolve('@treeui/vue', { paths: [path.join(root, 'src/ui')] })));
  const tree = require(require.resolve('@treeui/icons', { paths: [vue] })).builtinTreeIconNodes;
  return { aws, tree };
}

/**
 * GitHub's heading anchor for a Markdown heading: lowercase, punctuation
 * dropped (hyphens and underscores kept), spaces to hyphens.
 */
function headingSlug(heading) {
  return heading.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Every anchor a Markdown file offers: heading slugs plus explicit `id="…"`. */
function anchorsOf(markdown) {
  const anchors = new Set();
  // GitHub de-duplicates repeated headings with -1, -2… (the README has a
  // "CLI" feature group AND a "CLI" usage section: `#cli` and `#cli-1`).
  const seen = new Map();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const slug = headingSlug(heading[1]);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of markdown.matchAll(/\bid="([^"]+)"/g)) anchors.add(match[1]);
  return anchors;
}

module.exports = {
  WIDTH, HEIGHT, THEMES, measure, renderCard, renderAll, parseAwsArtwork, loadIcons, headingSlug, anchorsOf,
};
