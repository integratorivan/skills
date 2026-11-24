#!/usr/bin/env node
// Screenshot a page (or annotate an existing image) with red frames and arrows.
//
//   node shoot.mjs --url http://localhost:5173/reports --out after.png \
//     --mark "[data-testid=export] => Новая кнопка экспорта" --theme dark
//
//   node shoot.mjs --image raw.png --out marked.png --box "240,80,400,96 => Здесь"
//   (--box is in image pixels; --scale is the image's pixel ratio, 2 by default)
//
//   node shoot.mjs --text output.txt --title "$ npm run report" --out after.png \
//     --mark "text=Итого: 12 ч => Новая строка итога"
//   (terminal/API output for changes without UI; each line is its own element)
//
// Options: --viewport 1440x900  --scale 2  --theme light|dark  --full-page
//          --clip <selector>  --wait <selector>  --wait-ms 500  --timeout 8000
//          --storage-state auth.json  --cookie name=value (repeatable)
// Instead of a --setup file (lib.mjs → prepareContext/preparePage):
//          --click <selector> (repeatable, in order)  --scroll-to <selector>  --scroll-y 600
//          --hide <selector> (repeatable)  --css "<rules>"  --local-storage theme=dark (repeatable)
//          --delay "**/api/tasks*=3000" (repeatable: hold requests to catch a loading state)
//          --setup steps.mjs   (only for what flags can't do: export default async ({ page }) => { … })
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { contentRect, drawMarks, launchBrowser, locate, newContext, openPage, parseArgs, parseMark, prepareContext, preparePage, runMain, runSetup } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['mark', 'box', 'cookie', 'hide', 'click', 'local-storage', 'delay']);
if (!args.out || (!args.url && !args.image && !args.text)) {
  console.error('Нужны --out и одно из --url, --image, --text. Подробности в начале файла.');
  process.exit(1);
}

runMain(async () => {
  const browser = await launchBrowser();
  try {
    const page = await open(browser, args);
    const marks = (args.mark ?? []).map(parseMark);
    if (args.box) marks.push(...(await placeBoxes(page, args.box)));
    const area = await clipArea(page, args);
    if (marks.length) await drawMarks(page, marks, area);
    await page.waitForTimeout(150);
    await screenshot(page, args);
    console.log(resolve(args.out));
  } finally {
    await browser.close();
  }
});

function open(browser, args) {
  if (args.image) return openImage(browser, args);
  if (args.text) return openText(browser, args);
  return openUrl(browser, args);
}

async function openUrl(browser, args) {
  const context = await newContext(browser, args);
  await prepareContext(context, args);
  const page = await context.newPage();
  await openPage(page, args);
  await preparePage(page, args);
  await runSetup(args.setup, { page, context });
  // Hide carets and freeze animations so before/after pairs differ only by real changes.
  await page.addStyleTag({
    content: '*,*::before,*::after{caret-color:transparent!important;transition:none!important;animation:none!important}',
  });
  await page.waitForTimeout(Number(args['wait-ms'] ?? 300));
  return page;
}

// The image is shown at natural size / scale with the same device scale factor, so a 2x
// screenshot keeps its resolution and marks get the same visual weight as in URL mode.
async function openImage(browser, args) {
  const bytes = readFileSync(args.image);
  const mime = /\.jpe?g$/i.test(extname(args.image)) ? 'image/jpeg' : 'image/png';
  const scale = Number(args.scale ?? 2);
  const page = await browser.newPage({ deviceScaleFactor: scale });
  await page.setContent(
    `<body style="margin:0"><img id="pr-source" style="display:block" src="data:${mime};base64,${bytes.toString('base64')}"></body>`,
  );
  const size = await page.locator('#pr-source').evaluate((img, scale) => {
    img.style.width = `${img.naturalWidth / scale}px`;
    return { width: Math.ceil(img.naturalWidth / scale), height: Math.ceil(img.naturalHeight / scale) };
  }, scale);
  await page.setViewportSize(size);
  args.clip = '#pr-source';
  return page;
}

async function openText(browser, args) {
  const escape = (value) => value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const lines = readFileSync(args.text, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
  const title = typeof args.title === 'string' ? `<div class="title">${escape(args.title)}</div>` : '';
  const page = await browser.newPage({ viewport: { width: 1100, height: 400 }, deviceScaleFactor: Number(args.scale ?? 2) });
  await page.setContent(`<style>
    body{margin:0;padding:32px;background:#fff;width:max-content}
    #pr-terminal{background:#0d1117;color:#e6edf3;border-radius:10px;padding:16px 20px;min-width:640px;max-width:1400px;
      font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 6px 24px rgba(0,0,0,.18)}
    .title{color:#7ee787;margin-bottom:8px}.line{white-space:pre-wrap;min-height:1.55em;padding:3px 0}
  </style><div id="pr-terminal">${title}${lines.map((l) => `<div class="line">${escape(l)}</div>`).join('')}</div>`);
  const size = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
  await page.setViewportSize(size);
  args.clip = '#pr-terminal';
  return page;
}

// "x,y,w,h => label" in image pixels → invisible anchor elements that drawMarks can target.
async function placeBoxes(page, boxes) {
  const marks = [];
  for (const [index, raw] of boxes.entries()) {
    const { selector: rect, label } = parseMark(raw);
    const scale = Number(args.scale ?? 2);
    const [x, y, width, height] = rect.split(',').map((n) => Number(n) / scale);
    await page.evaluate(
      ({ index, x, y, width, height }) => {
        const anchor = document.createElement('div');
        anchor.id = `pr-box-${index}`;
        Object.assign(anchor.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
        document.body.append(anchor);
      },
      { index, x, y, width, height },
    );
    marks.push({ selector: `#pr-box-${index}`, label });
  }
  return marks;
}

// The --clip area: what the element actually shows (text and child boxes, not min-height
// emptiness) plus padding, inside the viewport. Marks are placed inside it.
async function clipArea(page, args) {
  if (typeof args.clip !== 'string') return null;
  const locator = await locate(page, args.clip);
  await locator.scrollIntoViewIfNeeded();
  const rect = args.image || args.text ? await locator.boundingBox() : await contentRect(locator);
  const pad = args.image || args.text ? 0 : 24;
  const view = page.viewportSize();
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  return {
    x, y,
    width: Math.min(view.width - x, rect.x + rect.width + pad - x),
    height: Math.min(view.height - y, rect.y + rect.height + pad - y),
  };
}

async function screenshot(page, args) {
  const area = await clipArea(page, args);
  if (!area) {
    await page.screenshot({ path: args.out, fullPage: Boolean(args['full-page']) });
    return;
  }
  const marks = await page.locator('[data-pr-marks] > div, [data-pr-marks] rect, [data-pr-marks] line').evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect()).filter((r) => r.width && r.height).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
  );
  let left = Math.min(area.x, ...marks.map((r) => r.x - 12));
  let top = Math.min(area.y, ...marks.map((r) => r.y - 12));
  let right = Math.max(area.x + area.width, ...marks.map((r) => r.x + r.width + 12));
  let bottom = Math.max(area.y + area.height, ...marks.map((r) => r.y + r.height + 12));
  if (!args.image && !args.text) [left, top, right, bottom] = await snapToText(page, [left, top, right, bottom]);
  const view = page.viewportSize();
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(view.width, right);
  bottom = Math.min(view.height, bottom);
  await page.screenshot({ path: args.out, clip: { x: left, y: top, width: right - left, height: bottom - top } });
}

// Move crop edges off text lines: include a line the edge cuts if that costs ≤ 48px, otherwise
// pull the edge back in front of it, so the shot never shows half a word.
async function snapToText(page, box) {
  return page.evaluate(([l, t, r, b]) => {
    const lines = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.data.trim() && !n.parentElement.closest('[data-pr-marks]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = document.createRange();
    for (let n = walker.nextNode(); n && lines.length < 4000; n = walker.nextNode()) {
      range.selectNodeContents(n);
      for (const rect of range.getClientRects()) if (rect.width && rect.height) lines.push(rect);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const o of lines) {
        const vertical = o.bottom > t && o.top < b;
        const horizontal = o.right > l && o.left < r;
        if (vertical && o.left < r && o.right > r) r = o.right - r <= 48 ? o.right + 4 : Math.max(l + 40, o.left - 4);
        if (vertical && o.left < l && o.right > l) l = l - o.left <= 48 ? o.left - 4 : Math.min(r - 40, o.right + 4);
        if (horizontal && o.top < b && o.bottom > b) b = o.bottom - b <= 48 ? o.bottom + 4 : Math.max(t + 20, o.top - 2);
        if (horizontal && o.top < t && o.bottom > t) t = t - o.top <= 48 ? o.top - 4 : Math.min(b - 20, o.bottom + 2);
      }
    }
    return [l, t, r, b];
  }, box);
}
