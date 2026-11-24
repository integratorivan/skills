#!/usr/bin/env node
// Commit the PR media, push, pin every link in the PR body to that commit's SHA, and update the PR/MR.
// Safe to re-run after adding or re-shooting media: old SHA links are rewritten to the new commit.
//
//   node publish.mjs --dir docs/pr/<slug> --body pr.md
//
// In the body, reference media by their repo path (docs/pr/<slug>/01-x-after.png): plain paths, old
// GitHub blob/…?raw=true links and GitLab /-/raw/ links to the same folder are all rewritten.
//
// Steps: optimize large PNGs (lossless-looking palette, kept only if SSIM ≥ 0.995) → commit the folder
// alone → push → check every referenced file exists in that commit and the commit is on the remote →
// rewrite links in the body file (in place) → update the PR (gh pr edit, falls back to gh api when the
// token lacks read:project) or the MR (glab mr update --description-file).
//
// Options: --pr <number>       PR/MR to update (default: the one for the current branch, if any)
//          --remote origin     remote to push to and to build links for (repos with GitHub + GitLab remotes)
//          --host github|gitlab  override host detection (self-hosted GitHub Enterprise, unusual GitLab URLs)
//          --message "docs(pr): add before/after media"
//          --no-verify         pass to git commit (hooks that reject binary-only commits)
//          --no-optimize  --no-push  --no-pr  --dry-run (print the body, change nothing)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (typeof args.dir !== 'string' || typeof args.body !== 'string') fail('Нужны --dir docs/pr/<slug> и --body pr.md. Подробности в начале файла.');
const dir = posix.normalize(args.dir).replace(/^\.\//, '').replace(/\/$/, '');
if (!existsSync(dir)) fail(`Папки ${dir} нет.`);
if (!existsSync(args.body)) fail(`Файла ${args.body} нет.`);
const remote = typeof args.remote === 'string' ? args.remote : 'origin';
const dry = Boolean(args['dry-run']);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryRun = (cmd, a) => {
  try {
    return { ok: true, out: execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (error) {
    return { ok: false, out: `${error.stderr ?? ''}${error.stdout ?? ''}`.trim() || error.message };
  }
};
const warnings = [];

// 1. Sizes. GitHub shows images up to 10 MB, but every PNG also lands in the repo history forever.
const media = readdirSync(dir).filter((f) => /\.(png|gif|jpe?g|webp|svg|mp4|webm)$/i.test(f)).sort();
if (!media.length) fail(`В ${dir} нет медиафайлов.`);
if (!args['no-optimize'] && !dry) for (const f of media.filter((f) => /\.png$/i.test(f))) optimizePng(join(dir, f));
let total = 0;
for (const f of media) {
  const size = statSync(join(dir, f)).size;
  total += size;
  if (/\.gif$/i.test(f) && size > 10 * 1024 * 1024) warnings.push(`${f}: ${mb(size)} — GitHub не покажет GIF больше 10 МБ. Уменьши --width/--fps или сократи сценарий.`);
  else if (/\.png$/i.test(f) && size > 800 * 1024) warnings.push(`${f}: ${mb(size)} — сними с --clip или --scale 1.5.`);
}
if (total > 8 * 1024 * 1024) warnings.push(`Всего ${mb(total)} медиа: оставь в PR главное, остальное — в <details> или не коммить.`);

// 2. Commit only the media folder, so unrelated staged work stays out of the docs commit.
const remoteUrl = tryRun('git', ['remote', 'get-url', remote]);
if (!remoteUrl.ok) fail(`Нет remote "${remote}". Укажи --remote.`);
const repo = parseRemote(remoteUrl.out);
if (!dry) {
  git('add', '--', dir);
  const staged = tryRun('git', ['diff', '--cached', '--quiet', '--', dir]);
  if (!staged.ok) {
    const message = typeof args.message === 'string' ? args.message : 'docs(pr): add before/after media';
    const commit = tryRun('git', ['commit', ...(args['no-verify'] ? ['--no-verify'] : []), '-m', message, '--', dir]);
    if (!commit.ok) fail(`git commit не прошёл:\n${commit.out}\nЕсли хук отвергает коммит только с картинками, перезапусти с --no-verify.`);
    console.log(`Коммит: ${git('log', '-1', '--format=%h %s')}`);
  }
}
const sha = git('log', '-1', '--format=%H', '--', dir);
if (!sha) fail(`${dir} ещё не закоммичена.`);

// 3. Push and make sure the media commit is really on the remote branch.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (!dry && !args['no-push']) {
  const hasUpstream = tryRun('git', ['rev-parse', '--abbrev-ref', '@{u}']).ok;
  const push = tryRun('git', ['push', ...(hasUpstream ? [] : ['-u']), remote, 'HEAD']);
  if (!push.ok) fail(`git push не прошёл:\n${push.out}`);
}
if (!dry) {
  // git push updates the remote-tracking ref, so this checks what the remote accepted without a network call.
  if (!tryRun('git', ['merge-base', '--is-ancestor', sha, `refs/remotes/${remote}/${branch}`]).ok) {
    warnings.push(`Коммит ${sha.slice(0, 8)} не найден в ${remote}/${branch}: ссылки не откроются, пока ветка не запушена.`);
  }
}

// 4. Rewrite links in the body.
const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linkPattern = new RegExp(
  `(?:https?://[^\\s)"'<>]*?/(?:blob|-/raw|raw)/[0-9a-f]{7,40}/|\\.?/)?${escaped}/([^\\s)"'<>?#]+)(?:\\?raw=true)?`,
  'g',
);
const referenced = new Set();
const body = readFileSync(args.body, 'utf8').replace(linkPattern, (_, file) => {
  referenced.add(file);
  return mediaUrl(`${dir}/${file}`);
});
const missing = [...referenced].filter((f) => !tryRun('git', ['cat-file', '-e', `${sha}:${dir}/${f}`]).ok);
if (missing.length) fail(`В коммите ${sha.slice(0, 8)} нет файлов, на которые ссылается описание:\n  ${missing.join('\n  ')}`);
const unused = media.filter((f) => !referenced.has(f));
if (unused.length) warnings.push(`Файлы есть в ${dir}, но в описании не упомянуты: ${unused.join(', ')}`);
if (!referenced.size) warnings.push(`В ${args.body} нет ни одной ссылки на ${dir}/…: пиши в описании пути вида ${dir}/01-scene-after.png.`);

if (dry) {
  console.log(body);
  printWarnings();
  process.exit(0);
}
writeFileSync(args.body, body);
console.log(`Ссылки: ${referenced.size} → ${repo.kind === 'github' ? 'GitHub' : 'GitLab'} @ ${sha.slice(0, 8)} (${args.body} обновлён)`);

// 5. Update the PR/MR.
if (!args['no-pr']) updateReview();
noteVisibility();
printWarnings();

function mediaUrl(path) {
  return repo.kind === 'github'
    ? `https://${repo.host}/${repo.path}/blob/${sha}/${path}?raw=true`
    : `https://${repo.host}/${repo.path}/-/raw/${sha}/${path}`;
}

function updateReview() {
  if (repo.kind === 'github') {
    const number = typeof args.pr === 'string' ? args.pr : tryRun('gh', ['pr', 'view', branch, '--repo', repo.path, '--json', 'number', '-q', '.number']).out;
    if (!/^\d+$/.test(number ?? '')) return console.log(`PR для ветки ${branch} нет. Создай: gh pr create --repo ${repo.path} --head ${branch} --body-file ${args.body}`);
    const edit = tryRun('gh', ['pr', 'edit', number, '--repo', repo.path, '--body-file', args.body]);
    if (edit.ok) return console.log(`PR #${number} обновлён.`);
    // gh pr edit also reads projects and fails on tokens without read:project; the REST call does not.
    const api = tryRun('gh', ['api', '-X', 'PATCH', `repos/${repo.path}/pulls/${number}`, '-F', `body=@${args.body}`, '--silent']);
    if (api.ok) return console.log(`PR #${number} обновлён через gh api (gh pr edit: ${edit.out.split('\n')[0]}).`);
    warnings.push(`Не удалось обновить PR #${number}:\n${api.out}`);
  } else {
    let iid = typeof args.pr === 'string' ? args.pr : '';
    if (!iid) {
      const view = tryRun('glab', ['mr', 'view', branch, '--output', 'json']);
      try {
        iid = String(JSON.parse(view.out).iid ?? '');
      } catch {}
    }
    if (!/^\d+$/.test(iid)) return console.log(`MR для ветки ${branch} нет. Создай: glab mr create --description "$(cat ${args.body})"`);
    const update = tryRun('glab', ['mr', 'update', iid, '--description-file', args.body]);
    if (update.ok) return console.log(`MR !${iid} обновлён.`);
    warnings.push(`Не удалось обновить MR !${iid}:\n${update.out}`);
  }
}

// Private repos: images open only for signed-in members, and anonymous curl gets 404/302. That is
// expected, so verification relies on git (cat-file + remote ancestry), not on HTTP.
function noteVisibility() {
  const visibility = repo.kind === 'github'
    ? tryRun('gh', ['repo', 'view', repo.path, '--json', 'visibility', '-q', '.visibility']).out
    : (() => {
        try {
          return JSON.parse(tryRun('glab', ['api', `projects/${encodeURIComponent(repo.path)}`]).out).visibility;
        } catch {
          return '';
        }
      })();
  if (/private|internal/i.test(visibility ?? '')) {
    console.log('Репозиторий приватный: картинки видят только участники, вошедшие в аккаунт. Проверка по HTTP без токена даст 404 — это нормально.');
  }
}

function parseRemote(url) {
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (!m) fail(`Не разобрал адрес remote: ${url}`);
  const [, host, path] = m;
  const kind = args.host === 'github' || args.host === 'gitlab' ? args.host : /github/i.test(host) ? 'github' : 'gitlab';
  return { host, path, kind };
}

function optimizePng(file) {
  const before = statSync(file).size;
  if (before < 200 * 1024) return;
  const out = join(tmpdir(), `pr-opt-${process.pid}-${Date.now()}.png`);
  try {
    const palette = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf',
      'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', out]);
    if (palette.status !== 0 || !existsSync(out)) return;
    const after = statSync(out).size;
    if (after > before * 0.8) return;
    // ffmpeg prints the SSIM summary to stderr.
    const ssimRun = spawnSync('ffmpeg', ['-i', file, '-i', out, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
    const ssim = Number(ssimRun.stderr.match(/All:([0-9.]+)/)?.[1] ?? 0);
    if (ssim < 0.995) return;
    renameSync(out, file);
    console.log(`${posix.basename(file)}: ${mb(before)} → ${mb(after)} (SSIM ${ssim.toFixed(4)})`);
  } finally {
    rmSync(out, { force: true });
  }
}

function mb(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
}

function printWarnings() {
  for (const w of warnings) console.warn(`⚠ ${w}`);
}

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}
