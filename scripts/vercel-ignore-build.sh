#!/usr/bin/env bash
# «Ignored Build Step» для Vercel-проектов монорепо (ключ `ignoreCommand`
# в <проект>/vercel.json). Vercel запускает команду из Root Directory
# проекта: код выхода 0 — сборку ПРОПУСТИТЬ, 1 — СОБИРАТЬ.
#
# Зачем: встроенный переключатель «Skip deployments when there are no
# changes to the root directory» работает только для монорепо на
# npm/yarn/pnpm/bun workspaces (корневой package.json с `workspaces`).
# У нас корневого package.json нет, каждый пакет — со своим lockfile,
# поэтому Vercel считает любое изменение глобальным и деплоит ВСЕ проекты
# на каждый коммит (doc/DEPLOYMENT.md, «Деплой только изменённых проектов»).
#
# Использование: bash ../scripts/vercel-ignore-build.sh <путь> [<путь>…]
#   пути — относительно Root Directory проекта: `.` — сам проект, плюс
#   папки других пакетов, которые сборка читает (у backend — словари
#   landing/ и frontend/ для базы знаний консультанта).
#
# База сравнения — VERCEL_GIT_PREVIOUS_SHA: коммит последнего УСПЕШНОГО
# деплоя этого проекта на этой ветке. Значит, если пушнули несколько
# коммитов сразу или прошлый деплой упал, изменения не потеряются.
# Любая неясность (нет базы, история не достаётся) — СОБИРАТЬ: лишний
# деплой дешевле пропущенного.
set -u

if [ "$#" -eq 0 ]; then
  echo "vercel-ignore-build: не заданы пути — собираю"
  exit 1
fi

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ]; then
  echo "vercel-ignore-build: нет прошлого успешного деплоя — собираю"
  exit 1
fi

# Vercel клонирует неглубоко: база может быть за пределами истории.
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=200 origin "$base" 2>/dev/null || true
fi
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "vercel-ignore-build: коммит ${base} недоступен в клоне — собираю"
  exit 1
fi

if git diff --quiet "$base" HEAD -- "$@"; then
  echo "vercel-ignore-build: с ${base:0:7} в [$*] изменений нет — пропускаю"
  exit 0
fi
echo "vercel-ignore-build: изменения в [$*] с ${base:0:7}:"
git diff --name-only "$base" HEAD -- "$@" | head -20
exit 1
