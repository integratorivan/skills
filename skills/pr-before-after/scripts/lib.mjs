// Shared helpers for shoot.mjs and record.mjs.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The skill is global, so Playwright is resolved from the project, the main checkout (git
// worktrees often have no node_modules), NODE_PATH, the skill cache and global npm.
export const CACHE_DIR = join(homedir(), '.cache', 'pr-before-after');

export function loadPlaywright() {
  const roots = [join(process.cwd(), 'noop.js')];
  try {
    const main = execSync('git worktree list --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .match(/^worktree (.+)$/m)?.[1];
    if (main) roots.push(join(main, 'noop.js'));
  } catch {}
  for (const dir of (process.env.NODE_PATH ?? '').split(':').filter(Boolean)) roots.push(join(dir, '..', 'noop.js'));
  roots.push(join(CACHE_DIR, 'noop.js'));
  try {
    roots.push(join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'noop.js'));
  } catch {}
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
      try {
        return createRequire(root)(name);
      } catch {}
    }
  }
  throw new Error(
    'Playwright не найден ни в проекте, ни в кэше скилла. Поставь его один раз в кэш:\n' +
      `  npm i --prefix ${CACHE_DIR} playwright\n` +
      'Браузер скачивать не обязательно: если версия Chromium не совпадёт, скрипты возьмут установленный Google Chrome.',
  );
}

// Projects pin different Playwright versions, and the matching Chromium build is often not
// downloaded. Fall back to the installed Chrome/Edge instead of failing.
export async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const errors = [];
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(`${options.channel ?? 'chromium'}: ${String(error.message).split('\n')[0]}`);
    }
  }
  throw new Error(`Не удалось запустить браузер.\n${errors.join('\n')}\nПоставь Chromium: npx playwright install chromium`);
}

// --key value, --flag, repeated keys collect into arrays.
export function parseArgs(argv, repeatable = []) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (repeatable.includes(key)) (args[key] ??= []).push(value);
    else args[key] = value;
  }
  return args;
}

export function parseViewport(value = '1440x900') {
  const [width, height] = String(value).split('x').map(Number);
  return { width, height };
}

// "selector => Подпись" → { selector, label }
// "selector :: подстрока => Подпись" frames only that piece of the element's text.
export function parseMark(value) {
  const at = value.indexOf('=>');
  const target = (at === -1 ? value : value.slice(0, at)).trim();
  const label = at === -1 ? '' : value.slice(at + 2).trim();
  const split = target.indexOf(' :: ');
  return split === -1
    ? { selector: target, text: '', label }
    : { selector: target.slice(0, split).trim(), text: target.slice(split + 4).trim(), label };
}

export async function newContext(browser, args, extra = {}) {
  const context = await browser.newContext({
    viewport: parseViewport(args.viewport),
    deviceScaleFactor: Number(args.scale ?? 2),
    colorScheme: args.theme === 'dark' ? 'dark' : 'light',
    locale: args.locale ?? 'ru-RU',
    storageState: typeof args['storage-state'] === 'string' ? args['storage-state'] : undefined,
    ...extra,
  });
  if (args.cookie && args.url) {
    const { hostname } = new URL(args.url);
    await context.addCookies(
      args.cookie.map((pair) => {
        const at = pair.indexOf('=');
        return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: hostname, path: '/' };
      }),
    );
  }
  return context;
}

// Flags shared by shoot.mjs and record.mjs that replace most one-off --setup files.
//   --local-storage key=value (repeatable, set before the app boots: theme, onboarding flags, locale)
//   --delay "**/api/**=800" (repeatable: hold matching requests, e.g. to catch a skeleton state)
//   --hide <selector> (repeatable: cookie banners, dev badges, chat widgets)   --css "<rules>"
//   --click <selector> (repeatable, in order)   --scroll-to <selector>   --scroll-y <px>
//   --timeout 8000 (per action; Playwright's 30 s default hides typos for half a minute)
export async function prepareContext(context, args) {
  const pairs = (args['local-storage'] ?? []).map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
  if (pairs.length) {
    await context.addInitScript((entries) => {
      try {
        for (const [key, value] of entries) localStorage.setItem(key, value);
      } catch {}
    }, pairs);
  }
  for (const rule of args.delay ?? []) {
    const at = rule.lastIndexOf('=');
    const pattern = rule.slice(0, at);
    const ms = Number(rule.slice(at + 1));
    await context.route(pattern, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await route.continue();
    });
  }
}

// Dev servers (Next, Vite) compile a route on first hit and keep sockets open, so "networkidle"
// alone either times out or never settles. Wait for load, then give network idle a short chance.
export async function openPage(page, args) {
  page.setDefaultTimeout(Number(args.timeout ?? 8000));
  await page.goto(args.url, { waitUntil: 'load', timeout: Number(args['goto-timeout'] ?? 90_000) });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (typeof args.wait === 'string') await locate(page, args.wait);
}

export async function preparePage(page, args) {
  const css = [
    ...(args.hide ?? []).map((selector) => `${selector}{visibility:hidden!important}`),
    typeof args.css === 'string' ? args.css : '',
  ].join('\n');
  if (css.trim()) await page.addStyleTag({ content: css });
  for (const selector of args.click ?? []) {
    await (await locate(page, selector)).click();
    await page.waitForTimeout(350);
  }
  if (typeof args['scroll-to'] === 'string') {
    await (await locate(page, args['scroll-to'])).evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  }
  if (args['scroll-y'] !== undefined) await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), Number(args['scroll-y']));
  if (args['scroll-to'] !== undefined || args['scroll-y'] !== undefined) await page.waitForTimeout(300);
}

// Waits for a visible element; on failure lists similar elements so the next try is not a guess.
export async function locate(page, selector) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible' });
    return locator;
  } catch (error) {
    if (!/Timeout/i.test(error.message)) throw error;
    const hints = await similarElements(page, selector);
    throw new Error(
      `Не найден видимый элемент "${selector}".` +
        (hints.length ? `\nПохожие на странице:\n  ${hints.join('\n  ')}` : '\nНа странице нет похожих элементов: проверь URL, авторизацию и --setup.'),
    );
  }
}

async function similarElements(page, selector) {
  const words = (selector.match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => !['button', 'link', 'text', 'name', 'role', 'has', 'data', 'testid', 'heading', 'textbox'].includes(w));
  return page.evaluate((words) => {
    const roleOf = (el) =>
      el.getAttribute('role') ??
      ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading' })[el.tagName] ??
      null;
    const seen = new Set();
    const found = [];
    for (const el of document.querySelectorAll('a,button,input,textarea,select,h1,h2,h3,[role],[data-testid],[aria-label]')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const name = (el.getAttribute('aria-label') ?? el.innerText ?? el.getAttribute('placeholder') ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const testid = el.getAttribute('data-testid');
      const role = roleOf(el);
      const text = `${name} ${testid ?? ''}`.toLowerCase();
      const score = words.length ? words.filter((w) => text.includes(w)).length : 0;
      const hint = testid ? `[data-testid=${testid}]` : role && name ? `role=${role}[name="${name}"]` : name ? `text=${name}` : null;
      if (!hint || seen.has(hint)) continue;
      seen.add(hint);
      found.push({ hint, score });
    }
    return found.sort((a, b) => b.score - a.score).filter((f, i) => f.score > 0 || i < 8).slice(0, 10).map((f) => f.hint);
  }, words);
}

// One readable line instead of a Node stack trace, so `| tail -1` still shows the cause.
export function runMain(main) {
  main().catch((error) => {
    console.error(`Ошибка: ${String(error?.message ?? error).replace(/\n\s+at .*/g, '')}`);
    process.exit(1);
  });
}

export async function runSetup(file, ctx) {
  if (typeof file !== 'string') return;
  const module = await import(new URL(file, `file://${process.cwd()}/`).href);
  await module.default(ctx);
}

// Viewport rect of what is actually visible in an element: its text and child boxes, not the
// empty width of a block. With `text`, only that substring (case-insensitive, uppercase CSS is fine).
export async function contentRect(locator, text = '') {
  return locator.evaluate((el, text) => {
    const union = (rects) => {
      const list = rects.filter((r) => r.width > 0 && r.height > 0);
      if (!list.length) return null;
      const left = Math.min(...list.map((r) => r.left));
      const top = Math.min(...list.map((r) => r.top));
      const right = Math.max(...list.map((r) => r.right));
      const bottom = Math.max(...list.map((r) => r.bottom));
      return { x: left, y: top, width: right - left, height: bottom - top };
    };
    const box = el.getBoundingClientRect();
    if (text) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let full = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n, start: full.length });
        full += n.data;
      }
      const at = full.toLowerCase().indexOf(text.toLowerCase());
      if (at === -1) return { error: `в "${el.textContent.trim().slice(0, 80)}" нет текста "${text}"` };
      const locate = (offset) => {
        const hit = nodes.findLast((n) => n.start <= offset);
        return [hit.node, offset - hit.start];
      };
      const range = document.createRange();
      range.setStart(...locate(at));
      range.setEnd(...locate(at + text.length));
      return union([...range.getClientRects()]);
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const tight = union([...range.getClientRects()]);
    // Inputs, images and empty elements have no inner range: keep their own box.
    if (!tight || tight.width * tight.height > box.width * box.height * 0.85) return { x: box.x, y: box.y, width: box.width, height: box.height };
    return tight;
  }, text);
}

// Draws a red frame around each target and a label with an arrow. The label goes where it covers
// the least text (and its arrow crosses the fewest lines), inside `bounds` (viewport CSS px) when
// given, e.g. the --clip area, so the crop never has to grow into neighbouring content.
export async function drawMarks(page, marks, bounds = null) {
  const items = [];
  for (const { selector, text, label } of marks) {
    const locator = await locate(page, selector);
    await locator.scrollIntoViewIfNeeded();
    const rect = await contentRect(locator, text);
    if (!rect || rect.error) throw new Error(`Метка "${selector}${text ? ` :: ${text}` : ''}": ${rect?.error ?? 'нет видимой области'}`);
    items.push({ rect, label });
  }
  await page.evaluate(({ items, bounds }) => {
    const color = '#ff2d55';
    const area = bounds ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const sx = scrollX;
    const sy = scrollY;
    const root = document.createElement('div');
    root.dataset.prMarks = '';
    Object.assign(root.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483647', pointerEvents: 'none' });
    document.body.append(root);
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', document.documentElement.scrollWidth);
    svg.setAttribute('height', document.documentElement.scrollHeight);
    Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', overflow: 'visible' });
    svg.innerHTML = `<defs><marker id="pr-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`;
    root.append(svg);
    const set = (node, attrs) => Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));

    // Obstacles: visible text lines and media inside the area (viewport coordinates).
    const obstacles = [];
    const inArea = (r) => r.right > area.x && r.left < area.x + area.width && r.bottom > area.y && r.top < area.y + area.height;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = document.createRange();
    for (let n = walker.nextNode(); n && obstacles.length < 4000; n = walker.nextNode()) {
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width && r.height && inArea(r)) obstacles.push(r);
    }
    const areaSize = area.width * area.height;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('[data-pr-marks]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || !inArea(r)) continue;
      const media = /^(IMG|SVG|VIDEO|CANVAS|BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(el.tagName);
      // Small filled blocks (progress bars, badges, chips) matter too; big backgrounds do not.
      const filled = r.width * r.height < areaSize * 0.2 && getComputedStyle(el).backgroundColor.replace(/\s/g, '').match(/rgba?\(([^)]+)\)/)?.[1].split(',')[3] !== '0';
      if (media || filled) obstacles.push(r);
    }
    const overlap = (a, b) =>
      Math.max(0, Math.min(a.x + a.w, b.right) - Math.max(a.x, b.left)) * Math.max(0, Math.min(a.y + a.h, b.bottom) - Math.max(a.y, b.top));
    const placed = [];

    for (const { rect, label } of items) {
      const pad = Math.max(5, Math.min(8, rect.height * 0.25));
      const f = { x: rect.x - pad, y: rect.y - pad, w: rect.width + pad * 2, h: rect.height + pad * 2 };
      const frame = document.createElementNS(svgNs, 'rect');
      set(frame, { x: f.x + sx, y: f.y + sy, width: f.w, height: f.h, rx: 6, fill: 'none', stroke: color, 'stroke-width': 3 });
      svg.append(frame);
      placed.push({ left: f.x, top: f.y, right: f.x + f.w, bottom: f.y + f.h });
      if (!label) continue;

      const bubble = document.createElement('div');
      bubble.textContent = label;
      Object.assign(bubble.style, {
        position: 'absolute', width: 'max-content', maxWidth: '280px', padding: '6px 10px', borderRadius: '8px',
        background: color, color: '#fff', font: '600 14px/1.3 -apple-system, system-ui, sans-serif',
        boxShadow: '0 4px 14px rgba(0,0,0,.25)', whiteSpace: 'normal',
      });
      root.append(bubble);
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      const candidates = [];
      for (const gap of [24, 40, 64, 96, 140]) {
        const straight = candidates.length;
        candidates.push(
          { x: f.x + f.w + gap, y: cy - bh / 2 }, { x: f.x - gap - bw, y: cy - bh / 2 },
          { x: cx - bw / 2, y: f.y - gap - bh }, { x: cx - bw / 2, y: f.y + f.h + gap },
          { x: f.x + f.w + gap * 0.7, y: f.y - gap * 0.7 - bh }, { x: f.x + f.w + gap * 0.7, y: f.y + f.h + gap * 0.7 },
          { x: f.x - gap * 0.7 - bw, y: f.y - gap * 0.7 - bh }, { x: f.x - gap * 0.7 - bw, y: f.y + f.h + gap * 0.7 },
          { x: f.x, y: f.y - gap - bh }, { x: f.x, y: f.y + f.h + gap }, { x: f.x + f.w - bw, y: f.y - gap - bh }, { x: f.x + f.w - bw, y: f.y + f.h + gap },
        );
        // The first four are straight sides; prefer them when the rest is equal.
        for (let i = straight + 4; i < candidates.length; i++) candidates[i].penalty = 30;
      }
      // Closest points between the bubble and the frame, for the arrow.
      const ends = (b) => {
        const tx = Math.max(f.x, Math.min(b.x + bw / 2, f.x + f.w));
        const ty = Math.max(f.y, Math.min(b.y + bh / 2, f.y + f.h));
        const fx = Math.max(b.x, Math.min(tx, b.x + bw));
        const fy = Math.max(b.y, Math.min(ty, b.y + bh));
        return { from: [fx, fy], to: [tx, ty] };
      };
      let best = null;
      for (const c of candidates) {
        const b = { ...c, w: bw, h: bh };
        const out =
          Math.max(0, area.x + 6 - b.x) + Math.max(0, b.x + bw - (area.x + area.width - 6)) +
          Math.max(0, area.y + 6 - b.y) + Math.max(0, b.y + bh - (area.y + area.height - 6));
        let cover = 0;
        const grown = { x: b.x - 4, y: b.y - 4, w: bw + 8, h: bh + 8 };
        for (const o of obstacles) cover += overlap(grown, o);
        for (const o of placed) cover += overlap(grown, o) * 4;
        const { from, to } = ends(b);
        const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
        let crossings = 0;
        for (let i = 1; i < 12; i++) {
          const px = from[0] + ((to[0] - from[0]) * i) / 12;
          const py = from[1] + ((to[1] - from[1]) * i) / 12;
          if (obstacles.some((o) => px > o.left && px < o.right && py > o.top && py < o.bottom)) crossings++;
        }
        const score = out * 5000 + cover * 3 + crossings * 400 + length * 2 + (c.penalty ?? 0);
        if (!best || score < best.score) best = { ...b, score };
      }
      Object.assign(bubble.style, { left: `${best.x + sx}px`, top: `${best.y + sy}px` });
      placed.push({ left: best.x, top: best.y, right: best.x + bw, bottom: best.y + bh });
      const { from, to } = ends(best);
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      if (length < 14) continue;
      const line = document.createElementNS(svgNs, 'line');
      // Stop a few px short of the frame so the arrowhead does not sit on the stroke.
      set(line, {
        x1: from[0] + sx, y1: from[1] + sy, x2: to[0] - (dx / length) * 5 + sx, y2: to[1] - (dy / length) * 5 + sy,
        stroke: color, 'stroke-width': 4, 'stroke-linecap': 'round', 'marker-end': 'url(#pr-arrow)',
      });
      svg.append(line);
    }
  }, { items, bounds });
}
