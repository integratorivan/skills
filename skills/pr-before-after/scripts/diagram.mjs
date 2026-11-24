#!/usr/bin/env node
// Render Mermaid diagrams into a polished "Before → After" PNG card for a PR, instead of relying on
// GitHub/GitLab native Mermaid (their own theme, broken colors in dark mode, invisible in email,
// Slack previews and mobile apps).
//
//   node diagram.mjs --before before.mmd --after after.mmd --out docs/pr/<slug>/03-deps.png --lang ru
//   node diagram.mjs --md deps.md --out docs/pr/<slug>/03-deps.png      # two ```mermaid blocks (deps.mjs output)
//   node diagram.mjs --src flow.mmd --out docs/pr/<slug>/04-flow.png     # one diagram, no diff
//
// The diff is computed from the diagrams themselves (flowcharts):
//   - node id or edge (from → to) only in "before": removed (red, dashed, struck through);
//   - only in "after": added (green);
//   - same id with another label or another subgraph: changed (amber);
//   - `class X added|removed|changed` in the source forces a status (e.g. a file whose code changed).
// classDef / linkStyle / style lines are ignored: the renderer owns the look. Other diagram types
// (sequence, state, …) are rendered with the same theme, without diff marks.
//
// Options:
//   --layout auto|split|stack|unified  split = side by side, stack = one above the other,
//                                      unified = one merged graph with the diff drawn on it.
//                                      auto: split if it fits --max-width, else stack.
//   --theme light|dark|both            both → <out>.png and <out>-dark.png for a <picture> tag
//   --title "Зависимости: доска"       card title
//   --lang ru|en                       panel names, legend, counters (use the PR language)
//   --max-width 1680                   widest card before auto switches to stack
//   --svg                              also save each panel as .svg next to the PNG
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CACHE_DIR, launchBrowser, parseArgs } from './lib.mjs';

const MERMAID_VERSION = '11.17.2';
const args = parseArgs(process.argv.slice(2));
const sources = readSources();
if (!args.out || !sources.length) {
  console.error('Нужны --out и одно из: --before + --after, --md, --src. Подробности в начале файла.');
  process.exit(1);
}
const layout = args.layout ?? 'auto';
if (layout === 'unified' && sources.length !== 2) {
  console.error('--layout unified нужны две диаграммы: --before и --after (или --md с двумя блоками).');
  process.exit(1);
}
const themes = args.theme === 'both' ? ['light', 'dark'] : [args.theme === 'dark' ? 'dark' : 'light'];
const mermaidPath = await mermaidBundle();

const browser = await launchBrowser();
try {
  for (const theme of themes) {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1200 } });
    page.on('pageerror', (error) => console.error(error.message));
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: mermaidPath });
    const result = await page.evaluate(renderCard, {
      sources,
      layout,
      theme,
      lang: args.lang === 'en' ? 'en' : 'ru',
      title: typeof args.title === 'string' ? args.title : '',
      maxWidth: Number(args['max-width'] ?? 1680),
    });
    const out = theme === 'dark' && themes.length > 1 ? args.out.replace(/(\.png)?$/i, '-dark.png') : args.out;
    mkdirSync(dirname(resolve(out)), { recursive: true });
    await page.locator('#card').screenshot({ path: out, omitBackground: true });
    if (args.svg) result.svgs.forEach((svg, i) => writeFileSync(out.replace(/\.png$/i, `-${i + 1}.svg`), svg));
    console.log(`${resolve(out)}  (${result.layout}, ${result.summary})`);
    await page.close();
  }
  if (themes.length > 1) {
    const light = args.out.replace(/^.*\//, '');
    console.log(
      `\nДля GitHub:\n<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="<base>/${light.replace(/\.png$/i, '-dark.png')}?raw=true">\n` +
        `  <img alt="…" src="<base>/${light}?raw=true">\n</picture>`,
    );
  }
} finally {
  await browser.close();
}

function readSources() {
  const read = (file) => readFileSync(file, 'utf8');
  if (typeof args.before === 'string' && typeof args.after === 'string') return [read(args.before), read(args.after)];
  if (typeof args.src === 'string') return [read(args.src)];
  if (typeof args.md === 'string') {
    const blocks = [...read(args.md).matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (blocks.length > 2) console.error(`В ${args.md} ${blocks.length} блоков mermaid, беру первые два.`);
    return blocks.slice(0, 2);
  }
  return [];
}

// Mermaid comes from the project if it has one, otherwise from the skill cache (downloaded once).
async function mermaidBundle() {
  try {
    const pkg = createRequire(join(process.cwd(), 'noop.js')).resolve('mermaid/package.json');
    const file = join(dirname(pkg), 'dist', 'mermaid.min.js');
    const major = Number(JSON.parse(readFileSync(pkg, 'utf8')).version.split('.')[0]);
    if (major === 11 && existsSync(file)) return file;
  } catch {}
  const cached = join(CACHE_DIR, `mermaid-${MERMAID_VERSION}.min.js`);
  if (existsSync(cached)) return cached;
  const url = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
  console.error(`Скачиваю ${url} в ${CACHE_DIR} (один раз)…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать Mermaid: HTTP ${response.status}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  return cached;
}

// Runs inside the page. Everything it needs must be defined in here.
async function renderCard({ sources, layout, theme, lang, title, maxWidth }) {
  const T = {
    light: {
      page: '#ffffff', panel: '#f6f8fa', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
      node: '#ffffff', nodeStroke: '#c8d1da', edge: '#8c959f', cluster: '#eef1f4', clusterStroke: '#d1d9e0',
      added: '#1a7f37', addedFill: '#dafbe1', addedText: '#0f5323',
      removed: '#cf222e', removedFill: '#ffebe9', removedText: '#82071e',
      changed: '#9a6700', changedFill: '#fff8c5', changedText: '#633c01',
      shadow: 'rgba(31,35,40,.08)',
    },
    dark: {
      page: '#0d1117', panel: '#151b23', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
      node: '#0d1117', nodeStroke: '#3d444d', edge: '#656c76', cluster: '#1b222c', clusterStroke: '#30363d',
      added: '#3fb950', addedFill: '#12261e', addedText: '#7ee787',
      removed: '#f85149', removedFill: '#2d1518', removedText: '#ffa198',
      changed: '#d29922', changedFill: '#272115', changedText: '#e3b341',
      shadow: 'rgba(0,0,0,.4)',
    },
  }[theme];
  const L = {
    ru: {
      before: 'Было', after: 'Стало', unified: 'Изменения',
      added: 'новое', removed: 'удалено', changed: 'изменено', same: 'без изменений',
      badge: { added: 'новый', removed: 'удалён', changed: 'изменён' },
      nodes: ['узел', 'узла', 'узлов'], edges: ['связь', 'связи', 'связей'], none: 'без изменений',
    },
    en: {
      before: 'Before', after: 'After', unified: 'Changes',
      added: 'added', removed: 'removed', changed: 'changed', same: 'unchanged',
      badge: { added: 'new', removed: 'removed', changed: 'changed' },
      nodes: ['node', 'nodes', 'nodes'], edges: ['link', 'links', 'links'], none: 'no changes',
    },
  }[lang];
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif';
  const STATUSES = ['added', 'removed', 'changed'];

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: FONT,
    themeVariables: {
      fontFamily: FONT, fontSize: '14px', background: T.panel,
      primaryColor: T.node, primaryBorderColor: T.nodeStroke, primaryTextColor: T.text,
      secondaryColor: T.cluster, tertiaryColor: T.cluster, lineColor: T.edge, textColor: T.text,
      clusterBkg: T.cluster, clusterBorder: T.clusterStroke, titleColor: T.muted,
      edgeLabelBackground: T.panel, noteBkgColor: T.changedFill, noteTextColor: T.text, noteBorderColor: T.changed,
      actorBkg: T.node, actorBorder: T.nodeStroke, actorTextColor: T.text, signalColor: T.muted, signalTextColor: T.text,
      labelBoxBkgColor: T.cluster, labelBoxBorderColor: T.nodeStroke, labelTextColor: T.text,
      activationBkgColor: T.cluster, activationBorderColor: T.nodeStroke, sequenceNumberColor: T.page,
    },
    flowchart: { curve: 'basis', htmlLabels: true, nodeSpacing: 40, rankSpacing: 60, padding: 14, diagramPadding: 12 },
    sequence: { useMaxWidth: false, mirrorActors: false, actorMargin: 60 },
  });

  const clean = (src) => src.split('\n').filter((line) => !/^\s*(classDef|linkStyle|style)\s/.test(line)).join('\n');

  async function model(src) {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(clean(src));
    if (!/^flowchart/.test(diagram.type)) return { flow: false, src: clean(src) };
    const db = diagram.db;
    const vertices = db.getVertices();
    const nodes = new Map();
    for (const [id, v] of vertices instanceof Map ? vertices : Object.entries(vertices)) {
      nodes.set(id, { id, text: v.text ?? id, type: v.type, classes: v.classes ?? [] });
    }
    const subgraphs = db.getSubGraphs();
    const parent = new Map();
    for (const sg of subgraphs) for (const child of sg.nodes) parent.set(child, sg.id);
    const edges = db.getEdges().map((e) => ({ id: e.id, start: e.start, end: e.end, key: `${e.start}\u0000${e.end}`, text: e.text ?? '', stroke: e.stroke, type: e.type }));
    return { flow: true, src: clean(src), nodes, edges, subgraphs, parent, direction: db.getDirection?.() ?? 'LR' };
  }

  const forced = (node) => STATUSES.find((s) => node.classes.includes(s));
  const differs = (a, b, other) => a.text !== b.text || (a.parent ?? '') !== (b.parent ?? '');

  // status maps for one panel: side = 'before' | 'after' | 'unified'
  function statuses(m, other, side) {
    const node = new Map();
    const edge = new Map();
    const cluster = new Map();
    const gone = side === 'before' ? 'removed' : 'added';
    for (const [id, n] of m.nodes) {
      const o = other?.nodes.get(id);
      const st = forced(n) ?? (!other ? 'same' : !o ? gone : differs({ ...n, parent: m.parent.get(id) }, { ...o, parent: other.parent.get(id) }) ? 'changed' : 'same');
      node.set(id, st);
    }
    const otherKeys = new Set(other?.edges.map((e) => e.key) ?? []);
    for (const e of m.edges) edge.set(e.id, !other || otherKeys.has(e.key) ? 'same' : gone);
    const otherClusters = new Set(other?.subgraphs.map((s) => s.id) ?? []);
    for (const sg of m.subgraphs) cluster.set(sg.id, !other || otherClusters.has(sg.id) ? 'same' : gone);
    return { node, edge, cluster };
  }

  // One merged flowchart: union of both sides, statuses taken from where each element exists.
  function unify(before, after) {
    const shape = (type, text) => {
      const t = `"${String(text).replace(/"/g, '#quot;')}"`;
      return ({
        round: `(${t})`, stadium: `([${t}])`, subroutine: `[[${t}]]`, cylinder: `[(${t})]`, circle: `((${t}))`,
        doublecircle: `(((${t})))`, odd: `>${t}]`, diamond: `{${t}}`, hexagon: `{{${t}}}`,
        lean_right: `[/${t}/]`, lean_left: `[\\${t}\\]`, trapezoid: `[/${t}\\]`, inv_trapezoid: `[\\${t}/]`,
      })[type] ?? `[${t}]`;
    };
    const nodes = new Map([...before.nodes, ...after.nodes]);
    const parent = new Map([...before.parent, ...after.parent]);
    const sgs = new Map([...before.subgraphs, ...after.subgraphs].map((s) => [s.id, s]));
    const node = new Map();
    for (const id of nodes.keys()) {
      const b = before.nodes.get(id);
      const a = after.nodes.get(id);
      node.set(id, forced(a ?? b) ?? (!a ? 'removed' : !b ? 'added' : differs({ ...a, parent: after.parent.get(id) }, { ...b, parent: before.parent.get(id) }) ? 'changed' : 'same'));
    }
    const edges = [];
    const seen = new Set();
    const afterKeys = new Set(after.edges.map((e) => e.key));
    const beforeKeys = new Set(before.edges.map((e) => e.key));
    for (const e of [...after.edges, ...before.edges]) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      edges.push({ ...e, st: !afterKeys.has(e.key) ? 'removed' : !beforeKeys.has(e.key) ? 'added' : 'same' });
    }
    const lines = [`flowchart ${after.direction}`];
    const emit = (id, indent) => {
      if (sgs.has(id)) {
        const sg = sgs.get(id);
        lines.push(`${indent}subgraph ${id}["${String(sg.title).replace(/"/g, '#quot;')}"]`);
        for (const [child, p] of parent) if (p === id) emit(child, indent + '  ');
        lines.push(`${indent}end`);
      } else if (nodes.has(id)) {
        lines.push(`${indent}${id}${shape(nodes.get(id).type, nodes.get(id).text)}`);
      }
    };
    for (const id of [...sgs.keys(), ...nodes.keys()]) if (!parent.has(id)) emit(id, '  ');
    edges.forEach((e, i) => lines.push(`  ${e.start} e${i}@-->${e.text ? `|"${e.text.replace(/"/g, '#quot;')}"|` : ''} ${e.end}`));
    const src = lines.join('\n');
    const cluster = new Map([...sgs.keys()].map((id) => [id, !after.subgraphs.some((s) => s.id === id) ? 'removed' : !before.subgraphs.some((s) => s.id === id) ? 'added' : 'same']));
    return { src, st: { node, edge: new Map(edges.map((e, i) => [`e${i}`, e.st])), cluster } };
  }

  let renderSeq = 0;
  async function draw(src, st) {
    const rid = `d${++renderSeq}`;
    const { svg } = await mermaid.render(rid, src);
    const holder = document.createElement('div');
    holder.className = 'canvas';
    holder.innerHTML = svg;
    const el = holder.querySelector('svg');
    el.removeAttribute('style');
    el.style.maxWidth = 'none';
    document.getElementById('stage').append(holder);
    if (st) decorate(el, rid, st);
    // Keep Mermaid's own viewBox (sequence lifelines are drawn longer and cropped by it), plus room for badges.
    const [x, y, width, height] = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const box = Number.isFinite(height) && width > 0 ? { x, y, width, height } : el.getBBox();
    const pad = 16;
    el.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`);
    el.setAttribute('width', box.width + pad * 2);
    el.setAttribute('height', box.height + pad * 2);
    return holder;
  }

  function decorate(svg, rid, st) {
    const ns = 'http://www.w3.org/2000/svg';
    for (const g of svg.querySelectorAll('g.node')) {
      const id = g.id.match(new RegExp(`^${rid}-flowchart-(.+)-\\d+$`))?.[1];
      const status = st.node.get(id) ?? 'same';
      g.dataset.st = status;
      g.querySelectorAll('rect.label-container, .basic.label-container').forEach((r) => r.tagName === 'rect' && (r.setAttribute('rx', 8), r.setAttribute('ry', 8)));
      if (status === 'same') continue;
      const box = g.getBBox();
      const badge = document.createElementNS(ns, 'g');
      badge.setAttribute('class', `badge badge-${status}`);
      const text = document.createElementNS(ns, 'text');
      text.textContent = L.badge[status];
      badge.append(text);
      g.append(badge);
      const tw = text.getComputedTextLength();
      const w = tw + 14;
      const h = 17;
      const x = box.x + box.width - w + 8;
      const y = box.y - h / 2 - 1;
      const pill = document.createElementNS(ns, 'rect');
      Object.entries({ x, y, width: w, height: h, rx: h / 2 }).forEach(([k, v]) => pill.setAttribute(k, v));
      text.setAttribute('x', x + 7);
      text.setAttribute('y', y + h / 2 + 0.5);
      badge.prepend(pill);
    }
    for (const g of svg.querySelectorAll('g.cluster')) {
      const id = g.id.slice(rid.length + 1);
      g.dataset.st = st.cluster.get(id) ?? 'same';
    }
    const markers = {};
    const defs = svg.querySelector('defs') ?? svg.insertBefore(document.createElementNS(ns, 'defs'), svg.firstChild);
    const markerFor = (status, end) => {
      const key = `${status}-${end}`;
      if (markers[key]) return markers[key];
      const base = svg.querySelector(`marker[id$="flowchart-v2-point${end}"]`);
      if (!base) return null;
      const clone = base.cloneNode(true);
      clone.id = `${rid}-arrow-${key}`;
      clone.querySelectorAll('path').forEach((p) => p.setAttribute('style', `fill: var(--edge-${status}); stroke: none;`));
      defs.append(clone);
      return (markers[key] = clone.id);
    };
    for (const path of svg.querySelectorAll('.edgePaths path[data-id], path.flowchart-link')) {
      const status = st.edge.get(path.dataset.id ?? path.id.slice(rid.length + 1)) ?? 'same';
      path.dataset.st = status;
      path.removeAttribute('style');
      for (const [attr, end] of [['marker-end', 'End'], ['marker-start', 'Start']]) {
        if ((path.getAttribute(attr) ?? '').includes('point')) {
          const id = markerFor(status, end);
          if (id) path.setAttribute(attr, `url(#${id})`);
        }
      }
    }
    for (const label of svg.querySelectorAll('.edgeLabel .label[data-id]')) {
      label.closest('.edgeLabel').dataset.st = st.edge.get(label.dataset.id) ?? 'same';
    }
  }

  const plural = (n, forms) => {
    if (lang === 'en') return `${n} ${n === 1 ? forms[0] : forms[1]}`;
    const m10 = n % 10, m100 = n % 100;
    return `${n} ${forms[m10 === 1 && m100 !== 11 ? 0 : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? 1 : 2]}`;
  };
  const count = (st, status, sign) => {
    const nodes = [...st.node.values()].filter((s) => s === status).length;
    const edges = [...st.edge.values()].filter((s) => s === status).length;
    return [nodes && `${sign}${plural(nodes, L.nodes)}`, edges && `${sign}${plural(edges, L.edges)}`].filter(Boolean);
  };
  const changedCount = (st) => {
    const n = [...st.node.values()].filter((s) => s === 'changed').length;
    return n ? [`~${plural(n, L.nodes)}`] : [];
  };

  document.head.insertAdjacentHTML('beforeend', `<style>
    html, body { margin: 0; background: transparent; }
    body { padding: 0; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
    #card { display: inline-flex; flex-direction: column; gap: 18px; padding: 24px; background: ${T.page};
      border: 1px solid ${T.border}; border-radius: 18px; color: ${T.text}; box-sizing: border-box;
      --edge-same: ${T.edge}; --edge-added: ${T.added}; --edge-removed: ${T.removed}; --edge-changed: ${T.changed}; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 32px; min-height: 22px; }
    header .title { font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
    .legend { display: flex; gap: 16px; font-size: 12.5px; color: ${T.muted}; flex-wrap: wrap; }
    .legend span { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
    .legend i { width: 22px; height: 0; border-top: 2.5px solid; display: inline-block; border-radius: 2px; }
    .legend b { width: 11px; height: 11px; border-radius: 3px; border: 1.5px solid; display: inline-block; box-sizing: border-box; }
    .panels { display: flex; gap: 14px; align-items: stretch; }
    .panels.stack { flex-direction: column; }
    .panel { background: ${T.panel}; border: 1px solid ${T.border}; border-radius: 14px; padding: 14px 16px 10px;
      display: flex; flex-direction: column; gap: 6px; min-width: 260px; }
    .panels.split .panel { flex: 1 1 auto; }
    .ph { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .tag { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; letter-spacing: .02em; text-transform: uppercase; color: ${T.muted}; }
    .tag::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: ${T.edge}; }
    .tag.before::before { background: ${T.removed}; } .tag.after::before { background: ${T.added}; } .tag.unified::before { background: ${T.changed}; }
    .stat { font-size: 12.5px; color: ${T.muted}; font-variant-numeric: tabular-nums; display: flex; gap: 10px; }
    .stat .added { color: ${T.added}; } .stat .removed { color: ${T.removed}; } .stat .changed { color: ${T.changed}; }
    .canvas { display: flex; justify-content: center; align-items: center; flex: 1; }
    .arrow { align-self: center; color: ${T.muted}; font-size: 22px; padding: 0 2px; }
    svg { overflow: hidden; }
    svg rect.actor { rx: 8px; ry: 8px; fill: ${T.node} !important; stroke: ${T.nodeStroke} !important; filter: drop-shadow(0 1px 1.5px ${T.shadow}); }
    svg .actor-line { stroke: ${T.border} !important; }
    svg foreignObject { overflow: visible; }
    svg .nodeLabel, svg .edgeLabel, svg .cluster-label { font-family: ${FONT} !important; }
    svg .nodeLabel p, svg .edgeLabel p { margin: 0; }
    svg .node :is(rect, polygon, circle, ellipse, path).label-container,
    svg .node > :is(rect, polygon, circle, ellipse, path) { fill: ${T.node} !important; stroke: ${T.nodeStroke} !important; stroke-width: 1.3px !important; filter: drop-shadow(0 1px 1.5px ${T.shadow}); }
    svg .node .nodeLabel { color: ${T.text} !important; }
    ${['added', 'removed', 'changed'].map((s) => `
    svg .node[data-st=${s}] :is(rect, polygon, circle, ellipse, path).label-container,
    svg .node[data-st=${s}] > :is(rect, polygon, circle, ellipse, path) { fill: ${T[s + 'Fill']} !important; stroke: ${T[s]} !important; stroke-width: 2px !important; }
    svg .node[data-st=${s}] .nodeLabel { color: ${T[s + 'Text']} !important; font-weight: 600; }
    svg .badge-${s} rect { fill: ${T[s]} !important; stroke: none !important; filter: none !important; }
    svg .cluster[data-st=${s}] rect { stroke: ${T[s]} !important; stroke-dasharray: 6 4; }`).join('')}
    svg .node[data-st=removed] :is(rect, polygon, circle, ellipse, path).label-container,
    svg .node[data-st=removed] > :is(rect, polygon, circle, ellipse, path) { stroke-dasharray: 5 4; }
    svg .node[data-st=removed] .nodeLabel { text-decoration: line-through; text-decoration-thickness: 1.5px; }
    svg .badge text { fill: #fff !important; stroke: none !important; font: 700 10px/1 ${FONT} !important; dominant-baseline: middle; letter-spacing: .02em; }
    svg .cluster rect { fill: ${T.cluster} !important; stroke: ${T.clusterStroke} !important; stroke-width: 1px !important; rx: 12px; ry: 12px; }
    svg .cluster-label .nodeLabel, svg .cluster-label span { color: ${T.muted} !important; font-weight: 600; font-size: 12.5px; }
    svg .edgePaths path { stroke: ${T.edge} !important; stroke-width: 1.6px !important; fill: none !important; }
    svg .edgePaths path.edge-pattern-dotted { stroke-dasharray: 3 4; }
    svg .edgePaths path[data-st=added] { stroke: ${T.added} !important; stroke-width: 2.6px !important; }
    svg .edgePaths path[data-st=removed] { stroke: ${T.removed} !important; stroke-width: 2.2px !important; stroke-dasharray: 7 5 !important; }
    svg .edgeLabel, svg .edgeLabel p, svg .labelBkg { background: ${T.panel} !important; color: ${T.muted} !important; font-size: 12.5px; }
    svg .edgeLabel[data-st=added] p { color: ${T.added} !important; } svg .edgeLabel[data-st=removed] p { color: ${T.removed} !important; }
    svg .marker { fill: ${T.edge} !important; stroke: none !important; }
  </style>`);
  document.body.innerHTML = '<div id="card"><header><div class="title"></div><div class="legend"></div></header><div id="stage" class="panels"></div></div>';
  document.querySelector('header .title').textContent = title;

  const models = await Promise.all(sources.map(model));
  const flow = models.every((m) => m.flow);
  const panels = [];
  const used = new Set();
  const track = (st) => st && [...st.node.values(), ...st.edge.values(), ...st.cluster.values()].forEach((s) => used.add(s));

  if (layout === 'unified') {
    if (!flow) throw new Error('--layout unified работает только для flowchart');
    const { src, st } = unify(models[0], models[1]);
    track(st);
    panels.push({ cls: 'unified', name: L.unified, holder: await draw(src, st), stats: [...count(st, 'added', '+').map((t) => ['added', t]), ...count(st, 'removed', '−').map((t) => ['removed', t]), ...changedCount(st).map((t) => ['changed', t])] });
  } else if (models.length === 2) {
    const [b, a] = models;
    const stB = flow ? statuses(b, a, 'before') : null;
    const stA = flow ? statuses(a, b, 'after') : null;
    track(stB); track(stA);
    panels.push({ cls: 'before', name: L.before, holder: await draw(b.src, stB), stats: stB ? [...count(stB, 'removed', '−').map((t) => ['removed', t]), ...changedCount(stB).map((t) => ['changed', t])] : [] });
    panels.push({ cls: 'after', name: L.after, holder: await draw(a.src, stA), stats: stA ? [...count(stA, 'added', '+').map((t) => ['added', t]), ...changedCount(stA).map((t) => ['changed', t])] : [] });
  } else {
    const m = models[0];
    const st = m.flow ? statuses(m, null, 'after') : null;
    track(st);
    panels.push({ cls: 'single', name: '', holder: await draw(m.src, st), stats: [] });
  }

  const stage = document.getElementById('stage');
  const widths = panels.map((p) => Number(p.holder.querySelector('svg').getAttribute('width')));
  const mode = layout === 'unified' || panels.length === 1 ? 'stack' : layout === 'split' ? 'split' : layout === 'stack' ? 'stack' : widths.reduce((s, w) => s + w + 34, 48 + 40) <= maxWidth ? 'split' : 'stack';
  stage.className = `panels ${mode}`;
  stage.replaceChildren();
  panels.forEach((p, i) => {
    const section = document.createElement('section');
    section.className = 'panel';
    if (p.name) {
      const head = document.createElement('div');
      head.className = 'ph';
      head.innerHTML = `<span class="tag ${p.cls}"></span><span class="stat"></span>`;
      head.querySelector('.tag').textContent = p.name;
      const stat = head.querySelector('.stat');
      for (const [cls, text] of p.stats.length || !flow ? p.stats : [['', L.none]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        stat.append(span);
      }
      section.append(head);
    }
    section.append(p.holder);
    if (i === 1 && mode === 'split') {
      const arrow = document.createElement('div');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      stage.append(arrow);
    }
    stage.append(section);
  });

  const legend = document.querySelector('.legend');
  const sample = { added: T.added, removed: T.removed, changed: T.changed };
  for (const s of ['added', 'removed', 'changed']) {
    if (!used.has(s)) continue;
    const item = document.createElement('span');
    item.innerHTML = s === 'changed' ? `<b style="border-color:${T.changed};background:${T.changedFill}"></b>` : `<i style="border-color:${sample[s]};${s === 'removed' ? 'border-top-style:dashed;' : ''}"></i>`;
    item.append(L[s]);
    legend.append(item);
  }
  if (!title && !legend.children.length) document.querySelector('header').remove();

  const svgs = panels.map((p) => p.holder.querySelector('svg').outerHTML);
  const summary = panels.map((p) => `${p.name || 'diagram'}: ${p.stats.map((s) => s[1]).join(', ') || '—'}`).join(' | ');
  return { layout: mode, svgs, summary };
}
