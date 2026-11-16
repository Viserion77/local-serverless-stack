// Guard for the README's generated link cards (scripts/readme-cards.mjs).
//
// Three things must hold, and none of them is visible in review: every card
// the README shows exists in BOTH colour-scheme variants (a missing dark
// variant renders as a broken image only for dark-mode readers); every card's
// link lands somewhere (a file, or a heading / `id` anchor in it); and the
// committed SVGs are exactly what the manifest generates today — so editing
// the manifest, the icon artwork or the renderer without re-running
// `npm run readme:cards` fails here instead of shipping a stale card.
import fs from 'fs';
import path from 'path';

// CommonJS on purpose (the .mjs generator loads it too); `allowJs` types it.
const lib = require('../../../scripts/readme-cards-lib.js');

const ROOT = path.resolve(__dirname, '../../..');
const CARDS = path.join(ROOT, 'docs/readme/cards');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/readme-cards.json'), 'utf8'));

interface Card { id: string; title: string; subtitle: string; href: string; icon: { aws?: string; glyph?: string } }
const cards: Card[] = manifest.groups.flatMap((group: { cards: Card[] }) => group.cards);

describe('README cards', () => {
  it('every card the README references exists in both variants', () => {
    const referenced = [...README.matchAll(/docs\/readme\/cards\/([a-z0-9-]+)-(?:dark|light)\.svg/g)].map(match => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of new Set(referenced)) {
      expect(fs.existsSync(path.join(CARDS, `${id}-dark.svg`))).toBe(true);
      expect(fs.existsSync(path.join(CARDS, `${id}-light.svg`))).toBe(true);
    }
  });

  it('the README shows every card of the manifest, each wrapped in its own link', () => {
    for (const card of cards) {
      expect(README).toContain(`<a href="${card.href}"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/readme/cards/${card.id}-dark.svg">`);
    }
  });

  it.each(cards.map(card => [card.id, card.href]))('%s links somewhere real (%s)', (_id, href) => {
    const [file, anchor] = href.split('#');
    const target = path.join(ROOT, file || 'README.md');
    expect(fs.existsSync(target)).toBe(true);
    if (anchor) expect(lib.anchorsOf(fs.readFileSync(target, 'utf8')).has(anchor)).toBe(true);
  });

  it('the committed SVGs are byte-identical to a fresh generation, with no orphans', () => {
    const generated: Map<string, string> = lib.renderAll(manifest, lib.loadIcons(ROOT));
    const onDisk = fs.readdirSync(CARDS).filter(name => name.endsWith('.svg')).sort();
    expect(onDisk).toEqual([...generated.keys()].sort());
    for (const [name, content] of generated) {
      expect(fs.readFileSync(path.join(CARDS, name), 'utf8')).toBe(content);
    }
  });

  it('the cards are self-contained (no external reference an <img> could not load)', () => {
    for (const name of fs.readdirSync(CARDS)) {
      expect(fs.readFileSync(path.join(CARDS, name), 'utf8')).not.toMatch(/href=|url\(|@import|<style|<image|<script/);
    }
  });
});

describe('README card renderer', () => {
  const icons = lib.loadIcons(ROOT);
  const base = { id: 'x', title: 'Title', subtitle: 'subtitle', href: '#x', icon: { glyph: 'rocket' } };

  it('fails instead of clipping a title or subtitle that would overflow', () => {
    expect(() => lib.renderCard({ ...base, title: 'A title far too long to ever fit on one card' }, 'dark', icons)).toThrow(/title/);
    expect(() => lib.renderCard({ ...base, subtitle: 'a monospace subtitle that is far too long' }, 'light', icons)).toThrow(/subtitle/);
  });

  it('fails on an icon neither source carries', () => {
    expect(() => lib.renderCard({ ...base, icon: { aws: 'aws-nope' } }, 'dark', icons)).toThrow(/AWS mark/);
    expect(() => lib.renderCard({ ...base, icon: { glyph: 'nope' } }, 'dark', icons)).toThrow(/glyph/);
  });

  it('measures mono flat and sans by glyph class', () => {
    expect(lib.measure('iiii', 10, { mono: true })).toBe(lib.measure('MMMM', 10, { mono: true }));
    expect(lib.measure('iiii', 10)).toBeLessThan(lib.measure('MMMM', 10));
  });

  it('builds GitHub heading anchors, de-duplicated, ignoring fenced code', () => {
    const anchors = lib.anchorsOf('# CLI\n## CLI\n```\n# not a heading\n```\n### Lambda runtime & API Gateway\n<a id="engine-sqs"></a>');
    expect([...anchors].sort()).toEqual(['cli', 'cli-1', 'engine-sqs', 'lambda-runtime--api-gateway']);
    expect(() => lib.parseAwsArtwork('nothing here')).toThrow(/Unrecognised/);
  });
});
