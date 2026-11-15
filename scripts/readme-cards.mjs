#!/usr/bin/env node
// Generates the README's link cards — `npm run readme:cards`.
//
// Reads scripts/readme-cards.json and writes docs/readme/cards/<id>-dark.svg
// and <id>-light.svg (the README picks one per colour scheme with
// `<picture>`). Same spirit as scripts/generate-aws-icons.mjs: a committed
// generator, committed output, and a test that fails when the two disagree
// (tests/unit/docs/readme-cards.test.ts). The logic lives in
// scripts/readme-cards-lib.js so that test can run it in memory.
//
// The assets live under docs/readme/, not assets/: package.json#files ships
// assets/ in the npm tarball, and README images are served from the
// repository anyway.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadIcons, renderAll } = require('./readme-cards-lib.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs/readme/cards');
const manifest = JSON.parse(readFileSync(join(root, 'scripts/readme-cards.json'), 'utf8'));

const files = renderAll(manifest, loadIcons(root));
mkdirSync(outDir, { recursive: true });
// A card removed from the manifest leaves no orphan behind.
for (const name of readdirSync(outDir)) {
  if (name.endsWith('.svg') && !files.has(name)) rmSync(join(outDir, name));
}
for (const [name, content] of files) writeFileSync(join(outDir, name), content, 'utf8');
console.log(`readme-cards: wrote ${files.size} cards to docs/readme/cards/`);
