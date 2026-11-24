#!/usr/bin/env node
// Combine a "before" and an "after" shot into one card for the PR, in the same style as diagram.mjs.
//
//   node pair.mjs --before 01-list-before.png --after 01-list-after.png --out docs/pr/<slug>/01-list.png --diff
//
// Why one image instead of a Markdown table: GitHub squeezes each table cell to ~430px, so desktop
// crops become unreadable. The card picks the layout itself — side by side only when each shot is
// narrow enough to stay readable (≤ 520 CSS px), otherwise stacked at full width.
//
// --diff finds what changed between the two shots and outlines it (red dashed on "before", green
// on "after"), so small changes are visible without hand-placed marks. Use it on shots WITHOUT
// --mark (marks differ between shots and would show up as changes). If more than a third of the
// picture differs (layout shift, different data), the outlines are skipped with a warning.
//
// Options: --title "Список статей"  --lang ru|en  --layout auto|side|stack  --scale 2 (pixel ratio of the shots)
//          --caption-before "…" --caption-after "…" (short note under each panel)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, parseArgs, runMain } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));

runMain(async () => {
  if (typeof args.before !== 'string' || typeof args.after !== 'string' || typeof args.out !== 'string') {
    throw new Error('Нужны --before, --after и --out. Подробности в начале файла.');
  }
  const scale = Number(args.scale ?? 2);
  const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 2400, height: 1200 } });
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    const result = await page.evaluate(renderPair, {
      before: dataUrl(args.before),
      after: dataUrl(args.after),
      scale,
      lang: args.lang === 'en' ? 'en' : 'ru',
      title: typeof args.title === 'string' ? args.title : '',
      layout: args.layout ?? 'auto',
      diff: Boolean(args.diff),
      captions: [args['caption-before'], args['caption-after']].map((c) => (typeof c === 'string' ? c : '')),
    });
    await page.locator('#card').screenshot({ path: args.out, omitBackground: true });
    console.log(`${resolve(args.out)} (${result.layout}${result.note ? `, ${result.note}` : ''})`);
    if (result.warning) console.warn(`⚠ ${result.warning}`);
  } finally {
    await browser.close();
  }
});

async function renderPair({ before, after, scale, lang, title, layout, diff, captions }) {
  const L = lang === 'en'
    ? { before: 'Before', after: 'After', changed: (n) => `${n} change${n === 1 ? '' : 's'} outlined` }
    : { before: 'Было', after: 'Стало', changed: (n) => `изменений обведено: ${n}` };
  const T = {
    page: '#ffffff', panel: '#f6f8fa', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
    added: '#1a7f37', removed: '#cf222e',
  };
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif';
  const load = (src) => new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
  });
  const [b, a] = await Promise.all([load(before), load(after)]);
  const cssWidth = Math.max(b.naturalWidth, a.naturalWidth) / scale;
  const mode = layout === 'side' || layout === 'stack' ? layout : cssWidth <= 520 ? 'side' : 'stack';

  // Changed regions on a grid: cells with a visible pixel difference, grown a little and merged.
  let boxes = [];
  let warning = '';
  if (diff) {
    const w = Math.max(b.naturalWidth, a.naturalWidth);
    const h = Math.max(b.naturalHeight, a.naturalHeight);
    const pixels = (img) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const pb = pixels(b);
    const pa = pixels(a);
    const cell = Math.round(6 * scale);
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    const hot = new Uint8Array(cols * rows);
    // Exact pixel extents per cell, so outlines hug the change instead of snapping to the grid.
    const minX = new Float32Array(cols * rows).fill(Infinity);
    const minY = new Float32Array(cols * rows).fill(Infinity);
    const maxX = new Float32Array(cols * rows).fill(-Infinity);
    const maxY = new Float32Array(cols * rows).fill(-Infinity);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        if (Math.abs(pb[i] - pa[i]) + Math.abs(pb[i + 1] - pa[i + 1]) + Math.abs(pb[i + 2] - pa[i + 2]) > 60) {
          const c = Math.floor(y / cell) * cols + Math.floor(x / cell);
          hot[c] = 1;
          if (x < minX[c]) minX[c] = x;
          if (y < minY[c]) minY[c] = y;
          if (x > maxX[c]) maxX[c] = x;
          if (y > maxY[c]) maxY[c] = y;
        }
      }
    }
    const share = hot.reduce((s, v) => s + v, 0) / hot.length;
    if (share > 0.33) {
      warning = `Отличается ${Math.round(share * 100)}% кадра (сдвиг вёрстки или другие данные): обводку не рисую. Проверь, что кадры сняты с одинаковыми параметрами.`;
    } else {
      const seen = new Uint8Array(cols * rows);
      const grow = 2;
      for (let start = 0; start < hot.length; start++) {
        if (!hot[start] || seen[start]) continue;
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const c = stack.pop();
          const cx = c % cols;
          const cy = Math.floor(c / cols);
          x0 = Math.min(x0, minX[c]); y0 = Math.min(y0, minY[c]); x1 = Math.max(x1, maxX[c]); y1 = Math.max(y1, maxY[c]);
          for (let dy = -grow; dy <= grow; dy++) {
            for (let dx = -grow; dx <= grow; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
              const n = ny * cols + nx;
              if (hot[n] && !seen[n]) {
                seen[n] = 1;
                stack.push(n);
              }
            }
          }
        }
        boxes.push({ x: x0 / scale, y: y0 / scale, w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale });
      }
      boxes = boxes.filter((box) => box.w * box.h >= 36);
    }
  }

  document.head.insertAdjacentHTML('beforeend', `<style>
    html, body { margin: 0; background: transparent; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
    #card { display: inline-flex; flex-direction: column; gap: 16px; padding: 22px; background: ${T.page};
      border: 1px solid ${T.border}; border-radius: 18px; color: ${T.text}; }
    .title { font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
    .panels { display: flex; gap: 14px; align-items: flex-start; }
    .panels.stack { flex-direction: column; }
    .panel { background: ${T.panel}; border: 1px solid ${T.border}; border-radius: 14px; padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
    .ph { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .tag { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; letter-spacing: .02em; text-transform: uppercase; color: ${T.muted}; }
    .tag::before { content: ''; width: 8px; height: 8px; border-radius: 50%; }
    .before .tag::before { background: ${T.removed}; } .after .tag::before { background: ${T.added}; }
    .note { font-size: 12.5px; color: ${T.muted}; }
    .shot { position: relative; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 1px ${T.border}; line-height: 0; }
    .shot img { display: block; }
    .box { position: absolute; border-radius: 6px; border: 2.5px dashed; box-sizing: border-box; }
    .before .box { border-color: ${T.removed}; background: ${T.removed}0f; }
    .after .box { border-color: ${T.added}; border-style: solid; background: ${T.added}12; }
  </style>`);
  const card = document.createElement('div');
  card.id = 'card';
  if (title) {
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = title;
    card.append(t);
  }
  const panels = document.createElement('div');
  panels.className = `panels ${mode}`;
  [[b, 'before', L.before, captions[0]], [a, 'after', L.after, captions[1]]].forEach(([img, cls, name, caption]) => {
    const panel = document.createElement('section');
    panel.className = `panel ${cls}`;
    const head = document.createElement('div');
    head.className = 'ph';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = name;
    head.append(tag);
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = caption || (cls === 'after' && boxes.length ? L.changed(boxes.length) : '');
    head.append(note);
    panel.append(head);
    const shot = document.createElement('div');
    shot.className = 'shot';
    const el = document.createElement('img');
    el.src = img.src;
    el.style.width = `${img.naturalWidth / scale}px`;
    shot.append(el);
    for (const box of boxes) {
      const pad = 3;
      const div = document.createElement('div');
      div.className = 'box';
      Object.assign(div.style, { left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.w + pad * 2}px`, height: `${box.h + pad * 2}px` });
      shot.append(div);
    }
    panel.append(shot);
    panels.append(panel);
  });
  card.append(panels);
  document.body.append(card);
  return { layout: mode, note: diff && !warning ? `изменений: ${boxes.length}` : '', warning };
}
