#!/usr/bin/env node
// Render diagrams into a polished "Before → After" PNG card for a PR, instead of relying on
// GitHub/GitLab native Mermaid (their own theme, broken colors in dark mode, invisible in email,
// Slack previews and mobile apps).
//
// The renderer is Pele (https://pele.run, MIT): Mermaid syntax, its own clean layout and look, every
// Mermaid diagram type plus Pele's own (agentflow, swimlane, treeView, venn, wardley, …).
//
//   node diagram.mjs --before before.mmd --after after.mmd --out docs/pr/<slug>/03-deps.png --lang ru
//   node diagram.mjs --md deps.md --out docs/pr/<slug>/03-deps.png      # two ```mermaid blocks (deps.mjs output)
//   node diagram.mjs --src flow.mmd --out docs/pr/<slug>/04-flow.png     # one diagram, no diff
//
// The diff is computed from the diagrams themselves:
//   flowcharts — node id or edge (from → to) only in "before": removed (red, dashed, struck through);
//     only in "after": added (green); same id with another label or another subgraph: changed (amber);
//   other types (class, ER, state, mindmap, sequence participants, …) — the same by element id: a node
//     only on one side is removed/added, a node whose text changed is changed; links are compared when
//     their id names both ends (class, ER), not when it is just a position (state, sequence messages).
//   `class X added|removed|changed` in a flowchart forces a status (e.g. a file whose code changed).
// classDef / linkStyle / style lines are ignored: the renderer owns the look.
//
// Options:
//   --layout auto|split|stack|unified  split = side by side, stack = one above the other,
//                                      unified = one merged flowchart with the diff drawn on it.
//                                      auto: split if it fits --max-width, else stack.
//   --theme light|dark|both            both → <out>.png and <out>-dark.png for a <picture> tag
//   --title "Зависимости: доска"       card title
//   --lang ru|en                       panel names, legend, counters (use the PR language)
//   --max-width 1680                   widest card before auto switches to stack
//   --svg                              also save each panel as a self-contained .svg next to the PNG
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CACHE_DIR, launchBrowser, parseArgs } from './lib.mjs';

const PELE_VERSION = '1.13.0';
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
const pelePath = await peleBundle();

const browser = await launchBrowser();
try {
  for (const theme of themes) {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1200 } });
    page.on('pageerror', (error) => console.error(error.message));
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await page.addScriptTag({ path: pelePath });
    let result;
    try {
      result = await page.evaluate(renderCard, {
        sources,
        layout,
        theme,
        lang: args.lang === 'en' ? 'en' : 'ru',
        title: typeof args.title === 'string' ? args.title : '',
        maxWidth: Number(args['max-width'] ?? 1680),
      });
    } catch (error) {
      const message = String(error.message ?? error).replace(/^.*?Error:\s*/, '').split('\n').filter((line) => !/^\s+at /.test(line)).join('\n');
      console.error(`Диаграмма не отрисовалась: ${message}`);
      console.error('Проверь синтаксис в песочнице https://pele.run/playground');
      process.exitCode = 1;
      break;
    }
    const out = theme === 'dark' && themes.length > 1 ? args.out.replace(/(\.png)?$/i, '-dark.png') : args.out;
    mkdirSync(dirname(resolve(out)), { recursive: true });
    await page.locator('#card').screenshot({ path: out, omitBackground: true });
    if (args.svg) result.svgs.forEach((svg, i) => writeFileSync(out.replace(/\.png$/i, `-${i + 1}.svg`), svg));
    console.log(`${resolve(out)}  (${result.types.join(' → ')}, ${result.layout}, ${result.summary})`);
    await page.close();
  }
  if (themes.length > 1 && !process.exitCode) {
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
    const blocks = [...read(args.md).matchAll(/```(?:mermaid|pele)\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (blocks.length > 2) console.error(`В ${args.md} ${blocks.length} блоков mermaid, беру первые два.`);
    return blocks.slice(0, 2);
  }
  return [];
}

// Pele comes from the project if it has one, otherwise from the skill cache (downloaded once).
async function peleBundle() {
  try {
    const pkg = createRequire(join(process.cwd(), 'noop.js')).resolve('pele/package.json');
    const file = join(dirname(pkg), 'dist', 'pele.global.js');
    const major = Number(JSON.parse(readFileSync(pkg, 'utf8')).version.split('.')[0]);
    if (major === 1 && existsSync(file)) return file;
  } catch {}
  const cached = join(CACHE_DIR, `pele-${PELE_VERSION}.global.js`);
  if (existsSync(cached)) return cached;
  const url = `https://cdn.jsdelivr.net/npm/pele@${PELE_VERSION}/dist/pele.global.js`;
  console.error(`Скачиваю ${url} в ${CACHE_DIR} (один раз)…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать Pele: HTTP ${response.status}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  return cached;
}

// Runs inside the page. Everything it needs must be defined in here.
async function renderCard({ sources, layout, theme, lang, title, maxWidth }) {
  const T = {
    light: {
      page: '#ffffff', panel: '#f6f8fa', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
      node: '#ffffff', nodeStroke: '#c8d1da', edge: '#8c959f', cluster: '#eef1f4', clusterStroke: '#d1d9e0', accent: '#0969da',
      added: '#1a7f37', addedFill: '#dafbe1', addedText: '#0f5323',
      removed: '#cf222e', removedFill: '#ffebe9', removedText: '#82071e',
      changed: '#9a6700', changedFill: '#fff8c5', changedText: '#633c01',
      series: ['#0969da', '#1a7f37', '#bf8700', '#cf222e', '#8250df', '#1b7c83', '#bc4c00', '#57606a'],
      shadow: 'rgba(31,35,40,.08)',
    },
    dark: {
      page: '#0d1117', panel: '#151b23', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
      node: '#0d1117', nodeStroke: '#3d444d', edge: '#656c76', cluster: '#1b222c', clusterStroke: '#30363d', accent: '#4493f8',
      added: '#3fb950', addedFill: '#12261e', addedText: '#7ee787',
      removed: '#f85149', removedFill: '#2d1518', removedText: '#ffa198',
      changed: '#d29922', changedFill: '#272115', changedText: '#e3b341',
      series: ['#4493f8', '#3fb950', '#d29922', '#f85149', '#ab7df8', '#39c5cf', '#db6d28', '#9198a1'],
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
  const MONO = 'ui-monospace, "SF Mono", "Fira Code", Menlo, Consolas, monospace';
  const STATUSES = ['added', 'removed', 'changed'];
  const ns = 'http://www.w3.org/2000/svg';

  const VARS = {
    '--pele-bg': T.panel, '--pele-fg': T.text, '--pele-muted': T.muted, '--pele-line': T.edge,
    '--pele-surface': T.node, '--pele-surface-alt': T.cluster, '--pele-border': T.nodeStroke, '--pele-accent': T.accent,
    '--pele-font': FONT, '--pele-font-mono': MONO, '--pele-radius': '8px',
    ...Object.fromEntries(T.series.map((c, i) => [`--pele-series-${i + 1}`, c])),
  };
  const shapes = ':is(rect, polygon, circle, ellipse, path):not(.pele-marker)';
  // Diff marks. Kept apart from the card CSS so a saved .svg carries them too.
  const SVG_CSS = `
    .pele-node > ${shapes}:not(.badge *) { filter: drop-shadow(0 1px 1.5px ${T.shadow}); }
    .pele-cluster > rect { stroke: ${T.clusterStroke}; }
    .pele-cluster-label { font-weight: 600; font-size: 12.5px; }
    ${STATUSES.map((s) => `
    .pele-node[data-st=${s}] ${shapes}:not(.badge *) { fill: ${T[s + 'Fill']}; stroke: ${T[s]}; stroke-width: 2px; }
    .pele-node[data-st=${s}] text:not(.badge *) { fill: ${T[s + 'Text']}; font-weight: 600; }
    .pele-cluster[data-st=${s}] > rect { stroke: ${T[s]}; stroke-dasharray: 6 4; }
    .pele-edge[data-st=${s}] path { stroke: ${T[s]}; }
    .pele-edge[data-st=${s}] .pele-marker { fill: ${T[s]}; }
    .pele-edge-label[data-st=${s}] text { fill: ${T[s]}; }
    .badge-${s} rect { fill: ${T[s]}; }`).join('')}
    .pele-edge[data-st=added] path:not(.pele-marker) { stroke-width: 2.6px; }
    .pele-edge[data-st=removed] path:not(.pele-marker) { stroke-width: 2.2px; stroke-dasharray: 7 5; }
    .pele-node[data-st=removed] ${shapes}:not(.badge *) { stroke-dasharray: 5 4; }
    .pele-node[data-st=removed] text:not(.badge *) { text-decoration: line-through; text-decoration-thickness: 1.5px; }
    .badge rect { stroke: none; filter: none; }
    .badge text { fill: #fff; stroke: none; font: 700 10px/1 ${FONT}; dominant-baseline: middle; letter-spacing: .02em; text-decoration: none; }`;

  const clean = (src) => src.split('\n').filter((line) => !/^\s*(classDef|linkStyle|style)\s/.test(line)).join('\n');

  // Flowcharts get a full model (labels, subgraphs, forced classes); other types are diffed by element id.
  function model(raw) {
    const src = clean(raw);
    const parsed = pele.parse(src);
    if (parsed.type !== 'flowchart') return { flow: false, src, type: parsed.type };
    const nodes = new Map();
    for (const [id, v] of parsed.nodes instanceof Map ? parsed.nodes : Object.entries(parsed.nodes)) {
      nodes.set(id, { id, text: v.text ?? id, type: v.type, classes: v.classes ?? [] });
    }
    const subgraphs = parsed.subgraphs ?? [];
    const parent = new Map();
    for (const sg of subgraphs) for (const child of sg.nodes) parent.set(child, sg.id);
    const edges = parsed.edges.map((e) => ({ id: e.id, start: e.start, end: e.end, key: `${e.start}\u0000${e.end}`, text: e.text ?? '' }));
    return { flow: true, src, type: parsed.type, nodes, edges, subgraphs, parent, direction: parsed.direction ?? 'LR' };
  }

  const forced = (node) => STATUSES.find((s) => node.classes.includes(s));
  const differs = (a, b) => a.text !== b.text || (a.parent ?? '') !== (b.parent ?? '');

  // Flowchart status maps for one panel: side = 'before' | 'after'
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

  // Any other type: what each rendered element is, by its data-id.
  const positional = (id) => /^(edge|i|e|L)?\d+$/.test(id);
  function inventory(svg) {
    const text = (el) => [...el.querySelectorAll('text')].map((t) => t.textContent.trim()).filter(Boolean).join(' | ');
    const node = new Map();
    for (const g of svg.querySelectorAll('.pele-node[data-id]')) if (!node.has(g.dataset.id)) node.set(g.dataset.id, text(g));
    const edge = new Map();
    for (const g of svg.querySelectorAll('.pele-edge[data-id]')) if (!positional(g.dataset.id)) edge.set(g.dataset.id, '');
    return { node, edge };
  }
  function domStatuses(mine, other, side) {
    const gone = side === 'before' ? 'removed' : 'added';
    const node = new Map([...mine.node].map(([id, t]) => [id, !other.node.has(id) ? gone : other.node.get(id) !== t ? 'changed' : 'same']));
    const edge = new Map([...mine.edge.keys()].map((id) => [id, other.edge.has(id) ? 'same' : gone]));
    return { node, edge, cluster: new Map() };
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
        lines.push(`${indent}subgraph ${id}["${String(sg.title ?? id).replace(/"/g, '#quot;')}"]`);
        for (const [child, p] of parent) if (p === id) emit(child, indent + '  ');
        lines.push(`${indent}end`);
      } else if (nodes.has(id)) {
        lines.push(`${indent}${id}${shape(nodes.get(id).type, nodes.get(id).text)}`);
      }
    };
    for (const id of [...sgs.keys(), ...nodes.keys()]) if (!parent.has(id)) emit(id, '  ');
    for (const e of edges) lines.push(`  ${e.start} -->${e.text ? `|"${e.text.replace(/"/g, '#quot;')}"|` : ''} ${e.end}`);
    const src = lines.join('\n');
    // Edge ids come from the renderer; match them back by their ends.
    const byKey = new Map(edges.map((e) => [e.key, e.st]));
    const edge = new Map(pele.parse(src).edges.map((e) => [e.id, byKey.get(`${e.start}\u0000${e.end}`) ?? 'same']));
    const cluster = new Map([...sgs.keys()].map((id) => [id, !after.subgraphs.some((s) => s.id === id) ? 'removed' : !before.subgraphs.some((s) => s.id === id) ? 'added' : 'same']));
    return { src, st: { node, edge, cluster } };
  }

  let renderSeq = 0;
  function draw(src) {
    const { svg } = pele.render(src, { fontFamily: FONT, fontFamilyMono: MONO, fontSize: 14, idPrefix: `d${++renderSeq}-`, autoDirection: false });
    const holder = document.createElement('div');
    holder.className = 'canvas';
    holder.innerHTML = svg;
    const el = holder.querySelector('svg');
    el.style.maxWidth = 'none';
    for (const [k, v] of Object.entries(VARS)) el.style.setProperty(k, v);
    document.getElementById('stage').append(holder);
    return holder;
  }

  // Room for badges that stick out over the top-right corner of a node.
  function pad(el) {
    const [x, y, width, height] = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const box = Number.isFinite(height) && width > 0 ? { x, y, width, height } : el.getBBox();
    const p = 16;
    el.setAttribute('viewBox', `${box.x - p} ${box.y - p} ${box.width + p * 2} ${box.height + p * 2}`);
    el.setAttribute('width', box.width + p * 2);
    el.setAttribute('height', box.height + p * 2);
  }

  function decorate(svg, st) {
    for (const g of svg.querySelectorAll('.pele-node[data-id]')) {
      const status = st.node.get(g.dataset.id) ?? 'same';
      g.dataset.st = status;
      if (status === 'same' || g.querySelector(':scope > .badge')) continue;
      // Sequence diagrams draw each participant twice; badge only the top one.
      if ([...svg.querySelectorAll(`.pele-node[data-id="${CSS.escape(g.dataset.id)}"]`)][0] !== g) continue;
      const box = g.getBBox();
      const badge = document.createElementNS(ns, 'g');
      badge.setAttribute('class', `badge badge-${status}`);
      const text = document.createElementNS(ns, 'text');
      text.textContent = L.badge[status];
      badge.append(text);
      g.append(badge);
      const w = text.getComputedTextLength() + 14;
      const h = 17;
      const x = box.x + box.width - w + 8;
      const y = box.y - h / 2 - 1;
      const pill = document.createElementNS(ns, 'rect');
      Object.entries({ x, y, width: w, height: h, rx: h / 2 }).forEach(([k, v]) => pill.setAttribute(k, v));
      text.setAttribute('x', x + 7);
      text.setAttribute('y', y + h / 2 + 0.5);
      badge.prepend(pill);
    }
    for (const g of svg.querySelectorAll('.pele-cluster[data-id]')) g.dataset.st = st.cluster.get(g.dataset.id) ?? 'same';
    for (const g of svg.querySelectorAll('.pele-edge[data-id], .pele-edge-label[data-id]')) g.dataset.st = st.edge.get(g.dataset.id) ?? 'same';
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
      border: 1px solid ${T.border}; border-radius: 18px; color: ${T.text}; box-sizing: border-box; }
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
    svg.pele { overflow: hidden; }
    ${SVG_CSS.replace(/^(\s*)\./gm, '$1svg.pele .')}
  </style>`);
  document.body.innerHTML = '<div id="card"><header><div class="title"></div><div class="legend"></div></header><div id="stage" class="panels"></div></div>';
  document.querySelector('header .title').textContent = title;

  const models = sources.map(model);
  const flow = models.every((m) => m.flow);
  const panels = [];
  const used = new Set();
  const track = (st) => st && [...st.node.values(), ...st.edge.values(), ...st.cluster.values()].forEach((s) => used.add(s));
  const finish = (holder, st) => {
    const svg = holder.querySelector('svg');
    if (st) decorate(svg, st);
    pad(svg);
    return holder;
  };

  if (layout === 'unified') {
    if (!flow) throw new Error('--layout unified работает только для flowchart');
    const { src, st } = unify(models[0], models[1]);
    track(st);
    panels.push({ cls: 'unified', name: L.unified, holder: finish(draw(src), st), stats: [...count(st, 'added', '+').map((t) => ['added', t]), ...changedCount(st).map((t) => ['changed', t]), ...count(st, 'removed', '−').map((t) => ['removed', t])] });
  } else if (models.length === 2) {
    const [b, a] = models;
    const [hb, ha] = [draw(b.src), draw(a.src)];
    // Diff only like with like: a flowchart turned into a sequence diagram is two pictures, not a diff.
    const comparable = b.type === a.type;
    let stB = null, stA = null;
    if (flow) {
      stB = statuses(b, a, 'before');
      stA = statuses(a, b, 'after');
    } else if (comparable) {
      const [ib, ia] = [inventory(hb.querySelector('svg')), inventory(ha.querySelector('svg'))];
      stB = domStatuses(ib, ia, 'before');
      stA = domStatuses(ia, ib, 'after');
    }
    track(stB); track(stA);
    panels.push({ cls: 'before', name: L.before, holder: finish(hb, stB), stats: stB ? [...count(stB, 'removed', '−').map((t) => ['removed', t]), ...changedCount(stB).map((t) => ['changed', t])] : [], diffed: !!stB });
    panels.push({ cls: 'after', name: L.after, holder: finish(ha, stA), stats: stA ? [...count(stA, 'added', '+').map((t) => ['added', t]), ...changedCount(stA).map((t) => ['changed', t])] : [], diffed: !!stA });
  } else {
    const m = models[0];
    const st = m.flow ? statuses(m, null, 'after') : null;
    track(st);
    panels.push({ cls: 'single', name: '', holder: finish(draw(m.src), st), stats: [] });
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
      for (const [cls, text] of p.stats.length || !p.diffed ? p.stats : [['', L.none]]) {
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
  for (const s of STATUSES) {
    if (!used.has(s)) continue;
    const item = document.createElement('span');
    item.innerHTML = s === 'changed' ? `<b style="border-color:${T.changed};background:${T.changedFill}"></b>` : `<i style="border-color:${sample[s]};${s === 'removed' ? 'border-top-style:dashed;' : ''}"></i>`;
    item.append(L[s]);
    legend.append(item);
  }
  if (!title && !legend.children.length) document.querySelector('header').remove();

  const svgs = panels.map((p) => {
    const svg = p.holder.querySelector('svg').cloneNode(true);
    const style = document.createElementNS(ns, 'style');
    style.textContent = SVG_CSS;
    svg.prepend(style);
    svg.style.background = T.panel;
    return svg.outerHTML;
  });
  const summary = panels.map((p) => `${p.name || 'diagram'}: ${p.stats.map((s) => s[1]).join(', ') || '—'}`).join(' | ');
  return { layout: mode, svgs, summary, types: models.map((m) => m.type) };
}
