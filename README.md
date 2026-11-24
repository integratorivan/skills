# Skills

Скиллы для Claude Code, Codex и других агентов, которые понимают формат [Agent Skills](https://github.com/vercel-labs/skills): папка с `SKILL.md`, справочниками и скриптами.

*Agent skills for Claude Code, Codex and other compatible agents. Install all of them with `npx skills add integratorivan/skills -g --skill '*'`.*

## Что внутри

| Скилл | Что делает |
| --- | --- |
| [`pr-before-after`](skills/pr-before-after/SKILL.md) | Оформляет pull/merge request с визуальными доказательствами: скриншоты «Было → Стало» с метками, автоматическая обводка изменений, чёткие GIF сценариев, диаграммы зависимостей в собственном рендере вместо нативного Mermaid, публикация медиа со ссылками по SHA. |

## Установка

### Все скиллы одной командой

Нужен Node.js 18+. Установщик — CLI [`skills`](https://github.com/vercel-labs/skills):

```bash
npx skills add integratorivan/skills -g --skill '*'
```

- `-g` ставит скиллы для пользователя (в `~/.agents/skills` с ссылками в папки агентов), а не в текущий проект. Без `-g` скиллы установятся только в проект, в котором вы находитесь.
- CLI спросит, для каких агентов поставить. Чтобы не спрашивал, укажите агента: `-a claude-code` (можно несколько: `-a claude-code codex`). `--all` ставит все скиллы во все найденные агенты без вопросов.
- Посмотреть список скиллов в репозитории без установки: `npx skills add integratorivan/skills --list`.

### Один скилл

```bash
npx skills add integratorivan/skills -g --skill pr-before-after -a claude-code
```

### Обновление и удаление

```bash
npx skills check                     # есть ли обновления
npx skills update                    # обновить установленные скиллы
npx skills list                      # что установлено
npx skills remove pr-before-after    # удалить
```

### Вручную, без CLI

Клонируйте репозиторий и сделайте ссылки на каждый скилл в папку агента. Обновление — `git pull` в клоне.

```bash
git clone https://github.com/integratorivan/skills.git ~/src/skills

# Claude Code
mkdir -p ~/.claude/skills
for dir in ~/src/skills/skills/*/; do
  ln -sfn "$dir" ~/.claude/skills/"$(basename "$dir")"
done
```

Для Codex и других агентов, которые читают `~/.agents/skills`, повторите цикл с этой папкой вместо `~/.claude/skills`.

После установки перезапустите сессию агента. В Claude Code скилл подхватывается сам по описанию задачи («открой PR», «оформи merge request») или вызывается явно: `/pr-before-after`.

## Зависимости `pr-before-after`

| Что | Зачем | Как поставить |
| --- | --- | --- |
| Node.js 18+ | скрипты в `scripts/` | — |
| Playwright | скриншоты, GIF, рендер диаграмм | ищется в проекте, в `NODE_PATH` и в кэше скилла; если нигде нет: `npm i --prefix ~/.cache/pr-before-after playwright` |
| Chromium или Google Chrome | браузер для Playwright | если браузер нужной версии Playwright не скачан, скрипты сами запускают установленный Google Chrome; иначе `npx playwright install chromium` |
| ffmpeg | GIF, MP4, сжатие PNG | `brew install ffmpeg` |
| `gh` / `glab` | создание и обновление PR/MR | `brew install gh glab`, затем `gh auth login` / `glab auth login` |

Mermaid для диаграмм скачивается один раз в `~/.cache/pr-before-after` при первом запуске `diagram.mjs`.

## Как добавить скилл в репозиторий

1. Создайте папку `skills/<имя>/` и в ней `SKILL.md` с frontmatter:

   ```markdown
   ---
   name: <имя>
   description: Что делает скилл и когда его использовать. По этому тексту агент решает, подключать ли скилл.
   ---

   # Инструкция для агента
   ```

2. Справочники кладите в `references/`, исполняемые помощники — в `scripts/`, и ссылайтесь на них из `SKILL.md` относительными путями.
3. Добавьте строку в таблицу «Что внутри» и проверьте, что CLI видит скилл: `npx skills add ./ --list` из корня репозитория.
