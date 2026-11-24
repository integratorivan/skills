#!/usr/bin/env node
// Record a user flow with a visible cursor and turn it into a sharp GIF (or MP4).
//
//   node record.mjs --url http://localhost:5173/time --scenario flow.mjs --out after.gif
//   node record.mjs --url … --scenario flow.mjs --clip "[data-testid=timesheet]" --out after.gif
//   node record.mjs --video sim.mp4 --start 1.5 --duration 6 --out after.gif     # simulator/emulator/screen recording
//
// flow.mjs:
//   export default async ({ page, click, type, mark, pause, scrollTo }) => {
//     await click('text=Добавить запись');          // smooth cursor move + click
//     await type('[name=hours]', '2.5');
//     await mark('[data-testid=total] => Итог пересчитался');
//     await pause(1200);
//   };
//
// Quality: frames are device-pixel screenshots at --scale 2 (not Playwright's low-bitrate video),
// downscaled to --width with lanczos, so text stays crisp.
// --clip crops the recording to an element (plus padding) at the start: the change fills the frame
// instead of being a speck in a 1440px screen.
//
// Browser options: --viewport 1440x900  --scale 2  --clip <selector>  --theme light|dark
//                  --storage-state auth.json  --cookie name=value  --timeout 8000
//                  --hide/--css/--click/--scroll-to/--scroll-y/--local-storage/--delay (see lib.mjs)
// Video options:   --video in.mp4|mov  --start 1.5  --duration 6  --crop x,y,w,h  --box "x,y,w,h" (repeatable)
//                  (crop and box are in source video pixels)
// Output:          --out *.gif|*.mp4  --width <px> (default: 1440 desktop, 720 portrait video; never upscaled)
//                  --fps 15  --max-mb 10 (GIF only: lowers fps, then width, until it fits)
//                  MP4 (H.264, crf 18) shows inline on GitLab and in GitHub drag-and-drop uploads;
//                  for GitHub links from the repo use GIF.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  drawMarks, launchBrowser, locate, newContext, openPage, parseArgs, parseMark, parseViewport,
  prepareContext, preparePage, runMain, runSetup,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['cookie', 'hide', 'click', 'local-storage', 'delay', 'box']);
const asMp4 = /\.mp4$/i.test(args.out ?? '');
const fps = Number(args.fps ?? 15);
const maxMb = Number(args['max-mb'] ?? 10);

runMain(async () => {
  if (!args.out || (!args.video && (!args.url || !args.scenario))) {
    throw new Error('Нужны --out и либо --url + --scenario, либо --video. Подробности в начале файла.');
  }
  if (args.video) return fromVideo();
  return fromBrowser();
});

async function fromBrowser() {
  args.viewport ??= '1440x900';
  const scale = Number(args.scale ?? 2);
  const viewport = parseViewport(args.viewport);
  const work = mkdtempSync(join(tmpdir(), 'pr-record-'));
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser, { ...args, scale });
    await prepareContext(context, args);
    await context.addInitScript(cursorScript);
    const page = await context.newPage();
    await openPage(page, args);
    await preparePage(page, args);
    await page.waitForTimeout(300);

    let crop = null;
    if (typeof args.clip === 'string') {
      const box = await (await locate(page, args.clip)).boundingBox();
      const pad = 24;
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      crop = {
        x, y,
        width: Math.min(viewport.width - x, box.width + pad * 2),
        height: Math.min(viewport.height - y, box.height + pad * 2),
      };
      if (crop.width < 40 || crop.height < 40) {
        throw new Error(`--clip "${args.clip}" почти не виден в окне (${Math.round(crop.width)}×${Math.round(crop.height)}): добавь --scroll-to или увеличь --viewport.`);
      }
    }

    // Sample real device-pixel screenshots in a loop (~15 fps at 2x). CDP screencast frames are
    // 1x regardless of the device scale factor, and Playwright's own video is low-bitrate VP8.
    const frames = [];
    let recording = true;
    const sampler = (async () => {
      while (recording) {
        const t = Date.now() / 1000;
        const data = await page
          .screenshot({ type: 'jpeg', quality: 92, scale: 'device', animations: 'allow', caret: 'initial', timeout: 0 })
          .catch(() => null);
        if (data) frames.push({ data, t });
      }
    })();

    const click = async (selector) => {
      const target = await locate(page, selector);
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
      await page.waitForTimeout(200);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(500);
    };
    const type = async (selector, text) => {
      await click(selector);
      await page.keyboard.type(text, { delay: 70 });
      await page.waitForTimeout(400);
    };
    const mark = async (value) => drawMarks(page, [parseMark(value)], crop);
    const pause = (ms = 1000) => page.waitForTimeout(ms);
    const scrollTo = async (selector) => {
      await (await locate(page, selector)).evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await page.waitForTimeout(700);
    };

    await page.waitForTimeout(500);
    await runSetup(args.scenario, { page, context, click, type, mark, pause, scrollTo });
    await page.waitForTimeout(800);
    recording = false;
    await sampler;
    await context.close();
    if (frames.length < 2) throw new Error('Не удалось снять кадры: сценарий закончился мгновенно или страница не отрисовывалась.');

    // Frames arrive only when the picture changes, so each one is held until the next.
    const list = [];
    frames.forEach((frame, i) => {
      const name = `f${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(join(work, name), frame.data);
      const duration = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frame.t) : 1.2;
      list.push(`file '${name}'`, `duration ${duration.toFixed(4)}`);
    });
    list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
    writeFileSync(join(work, 'frames.txt'), list.join('\n'));

    const frameWidth = probeWidth(join(work, 'f00000.jpg'));
    const ratio = frameWidth / viewport.width;
    const cropFilter = crop
      ? `crop=${even(crop.width * ratio)}:${even(crop.height * ratio)}:${Math.round(crop.x * ratio)}:${Math.round(crop.y * ratio)},`
      : '';
    const sourceWidth = crop ? even(crop.width * ratio) : frameWidth;
    encode(['-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt')], cropFilter, Math.min(Number(args.width ?? 1440), sourceWidth));
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}

function fromVideo() {
  const input = ['-i', args.video];
  if (args.start !== undefined) input.unshift('-ss', String(args.start));
  if (args.duration !== undefined) input.unshift('-t', String(args.duration));
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', args.video], { encoding: 'utf8' })
    .trim().split(',').map(Number);
  let filters = '';
  for (const raw of args.box ?? []) {
    const [x, y, bw, bh] = raw.split('=>')[0].split(',').map((n) => Math.round(Number(n)));
    filters += `drawbox=x=${x}:y=${y}:w=${bw}:h=${bh}:color=0xFF2D55:t=${Math.max(4, Math.round(w / 200))},`;
  }
  let sourceWidth = w;
  let sourceHeight = h;
  if (typeof args.crop === 'string') {
    const [x, y, cw, ch] = args.crop.split(',').map(Number);
    filters += `crop=${even(cw)}:${even(ch)}:${x}:${y},`;
    sourceWidth = even(cw);
    sourceHeight = even(ch);
  }
  const portrait = sourceHeight > sourceWidth;
  encode(input, filters, Math.min(Number(args.width ?? (portrait ? 720 : 1440)), sourceWidth));
}

// Encodes to GIF (shrinking until it fits --max-mb) or MP4.
function encode(input, preFilters, width) {
  if (asMp4) {
    run([...input, '-vf', `${preFilters}fps=30,scale=${even(width)}:-2:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', '-an', args.out]);
    return report();
  }
  const attempts = [
    [fps, width], [Math.min(fps, 12), width], [Math.min(fps, 12), Math.round(width * 0.85)], [10, Math.round(width * 0.72)],
  ];
  for (const [rate, w] of attempts) {
    const palette = 'split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle';
    run([...input, '-vf', `${preFilters}fps=${rate},scale=${w}:-1:flags=lanczos,${palette}`, '-loop', '0', args.out]);
    const mb = statSync(args.out).size / 1024 / 1024;
    if (mb <= maxMb) return report(`${w}px, ${rate} fps`);
    console.error(`${mb.toFixed(1)} МБ при ${w}px/${rate} fps > ${maxMb} МБ, ужимаю…`);
  }
  report();
  console.warn(`GIF всё ещё больше ${maxMb} МБ: сократи сценарий, добавь --clip или сохрани в .mp4.`);
}

function run(params) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...params], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
}

function probeWidth(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

function report(detail = '') {
  const mb = statSync(args.out).size / 1024 / 1024;
  console.log(`${resolve(args.out)} (${mb.toFixed(1)} МБ${detail ? `, ${detail}` : ''})`);
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// Screenshots don't include the system cursor, so draw one that also pulses on click.
function cursorScript() {
  const install = () => {
    if (document.getElementById('pr-cursor')) return;
    const dot = document.createElement('div');
    dot.id = 'pr-cursor';
    Object.assign(dot.style, {
      position: 'fixed', left: '-40px', top: '-40px', width: '22px', height: '22px', marginLeft: '-11px', marginTop: '-11px',
      borderRadius: '50%', background: 'rgba(255,45,85,.35)', border: '2px solid #ff2d55', zIndex: '2147483647',
      pointerEvents: 'none', transition: 'transform .12s ease',
    });
    document.documentElement.append(dot);
    addEventListener('mousemove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { dot.style.transform = 'scale(.6)'; }, true);
    addEventListener('mouseup', () => { dot.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
  else install();
}
