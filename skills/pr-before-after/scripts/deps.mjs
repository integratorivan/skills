#!/usr/bin/env node
// Build "Было / Стало" Mermaid dependency graphs from real imports at two git refs.
//
//   node deps.mjs --base origin/main --head HEAD                 # changed files + direct neighbours
//   node deps.mjs --base main --files "apps/api/src/routes/*.ts"  # explicit scope (git pathspec)
//   node deps.mjs --base main --level dir                         # collapse files into folders
//
// Prints Markdown with two ```mermaid blocks: removed edges/modules are red in "Before",
// added ones are green in "After". Edit the result by hand to tell the story; the raw
// graph is a starting point, not the final picture.
//
// Options: --importers (also show who imports the changed files)  --externals (bare imports)
//          --max-nodes 40  --direction LR|TB  --lang en|ru (headings; use the PR language)
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path/posix';
import { parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const base = args.base ?? 'origin/main';
const head = args.head ?? 'HEAD';
const level = args.level === 'dir' ? 'dir' : 'file';
const maxNodes = Number(args['max-nodes'] ?? 40);
const direction = args.direction ?? 'LR';
const headings = args.lang === 'ru' ? { before: 'Было', after: 'Стало' } : { before: 'Before', after: 'After' };
const codeFile = /\.(m?[jt]sx?|cjs|vue|svelte|astro)$/;

const git = (...params) => execFileSync('git', params, { encoding: 'utf8', maxBuffer: 1 << 28 });
const treeOf = (ref) => new Set(git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean));
const read = (ref, path) => {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return '';
  }
};

const trees = { base: treeOf(base), head: treeOf(head) };
const scope = scopeFiles();
if (!scope.length) {
  console.error('Нет изменённых файлов с кодом. Укажи --files или проверь --base/--head.');
  process.exit(1);
}

const graphs = { base: edgesAt('base', base), head: edgesAt('head', head) };
const before = toNodes(graphs.base, 'base');
const after = toNodes(graphs.head, 'head');
// One id per path across both diagrams, so diagram.mjs can diff "before" and "after" by id.
const id = idFactory();
const removedEdges = new Set([...graphs.base].filter((e) => !graphs.head.has(e)));
const addedEdges = new Set([...graphs.head].filter((e) => !graphs.base.has(e)));

console.log(`### ${headings.before}\n`);
// A module that exists on both sides is drawn on both, even without edges on one of them, so it
// is not mistaken for a new or deleted one (diagram.mjs diffs the two diagrams by node id).
const drawn = new Set([...graphs.base, ...graphs.head].flatMap((edge) => edge.split('\t')));
const existsAt = (side, node) => {
  if (node.startsWith('pkg:')) return false;
  const tree = trees[side];
  return level === 'dir' ? [...tree].some((f) => f.startsWith(`${node}/`) && dirname(f) === node) : tree.has(node);
};
const extra = (side) => [...drawn].filter((n) => existsAt(side, n));
console.log(mermaid(graphs.base, (n) => !after.has(n) && !existsAt('head', n), removedEdges, 'removed', extra('base')));
console.log(`\n### ${headings.after}\n`);
console.log(mermaid(graphs.head, (n) => !before.has(n) && !existsAt('base', n), addedEdges, 'added', extra('head')));
console.log(
  `\n<!-- deps.mjs: ${scope.length} файлов в области, рёбер было ${graphs.base.size}, стало ${graphs.head.size}, ` +
    `удалено ${removedEdges.size}, добавлено ${addedEdges.size} -->`,
);

function scopeFiles() {
  const files = typeof args.files === 'string'
    ? [...new Set([...trees.base, ...trees.head])].filter((f) => matchesPathspec(f, args.files.split(/\s+/)))
    : git('diff', '--name-only', `${base}...${head}`).split('\n');
  return files.filter((f) => codeFile.test(f));
}

function matchesPathspec(file, specs) {
  return specs.some((spec) => {
    const pattern = spec
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/?/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    return new RegExp(`^${pattern}$`).test(file) || file.startsWith(spec.replace(/\/$/, '') + '/');
  });
}

function edgesAt(side, ref) {
  const tree = trees[side];
  const edges = new Set();
  const present = scope.filter((f) => tree.has(f));
  for (const file of present) {
    for (const target of importsOf(ref, tree, file)) edges.add(`${file}\t${target}`);
  }
  if (args.importers) {
    for (const file of present) {
      for (const importer of importersOf(ref, tree, file)) edges.add(`${importer}\t${file}`);
    }
  }
  return collapse(edges);
}

function importsOf(ref, tree, file) {
  const source = read(ref, file);
  const specs = [...source.matchAll(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3]);
  const targets = [];
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const resolved = resolveRelative(tree, file, spec);
      if (resolved) targets.push(resolved);
    } else if (args.externals && !spec.startsWith('node:')) {
      targets.push(`pkg:${spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]}`);
    }
  }
  return targets;
}

function resolveRelative(tree, from, spec) {
  const raw = normalize(join(dirname(from), spec));
  const stem = raw.replace(/\.(m?js|cjs|jsx)$/, '');
  const candidates = [raw, ...['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro'].flatMap((ext) => [stem + ext, `${raw}/index${ext}`])];
  return candidates.find((c) => tree.has(c));
}

function importersOf(ref, tree, file) {
  const name = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  let hits = [];
  try {
    hits = git('grep', '-l', '-F', name, ref, '--').split('\n').map((l) => l.replace(`${ref}:`, ''));
  } catch {}
  return hits.filter((h) => codeFile.test(h) && h !== file && importsOf(ref, tree, h).includes(file));
}

function collapse(edges) {
  if (level === 'file') return edges;
  const result = new Set();
  for (const edge of edges) {
    const [from, to] = edge.split('\t').map((n) => (n.startsWith('pkg:') ? n : dirname(n)));
    if (from !== to) result.add(`${from}\t${to}`);
  }
  return result;
}

function toNodes(edges, side) {
  const present = scope.filter((f) => trees[side].has(f));
  const nodes = new Set(present.map((f) => (level === 'dir' ? dirname(f) : f)));
  for (const edge of edges) edge.split('\t').forEach((n) => nodes.add(n));
  return nodes;
}

function mermaid(edges, isChanged, changedEdges, kind, extraNodes = []) {
  const nodes = new Set(extraNodes);
  for (const edge of edges) edge.split('\t').forEach((n) => nodes.add(n));
  if (nodes.size > maxNodes) {
    console.error(`Узлов ${nodes.size} > ${maxNodes}: попробуй --level dir или сузь --files.`);
  }
  const color = kind === 'removed' ? '#d73a49' : '#22863a';
  const lines = ['```mermaid', `flowchart ${direction}`];
  for (const node of [...nodes].sort()) lines.push(`  ${id(node)}["${label(node)}"]`);
  const sorted = [...edges].sort();
  sorted.forEach((edge) => {
    const [from, to] = edge.split('\t');
    lines.push(`  ${id(from)} ${changedEdges.has(edge) ? (kind === 'removed' ? '-.->' : '==>') : '-->'} ${id(to)}`);
  });
  lines.push(`  classDef ${kind} fill:${color}22,stroke:${color},stroke-width:2px`);
  lines.push('  classDef external fill:#8881,stroke:#888,stroke-dasharray:3 3');
  const changed = [...nodes].filter(isChanged).map(id);
  if (changed.length) lines.push(`  class ${changed.join(',')} ${kind}`);
  const externals = [...nodes].filter((n) => n.startsWith('pkg:')).map(id);
  if (externals.length) lines.push(`  class ${externals.join(',')} external`);
  const styled = sorted.flatMap((edge, index) => (changedEdges.has(edge) ? [index] : []));
  if (styled.length) lines.push(`  linkStyle ${styled.join(',')} stroke:${color},stroke-width:3px`);
  lines.push('```');
  return lines.join('\n');
}

function idFactory() {
  const ids = new Map();
  return (node) => {
    if (!ids.has(node)) ids.set(node, `n${ids.size}`);
    return ids.get(node);
  };
}

function label(node) {
  if (node.startsWith('pkg:')) return node.slice(4);
  const parts = node.split('/');
  return (parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : node).replace(/"/g, "'");
}
