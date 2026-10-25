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
# У первого preview на новой ветке базы нет: сравниваем дерево проекта
# с актуальной default-веткой origin. Это только skip неизменённого preview;
# production, неизвестная ветка/remote или ошибка fetch — всегда сборка.
# Любая неясность (нет базы, история не достаётся) — СОБИРАТЬ: лишний
# деплой дешевле пропущенного.
set -u

# Env-only changes have no Git diff. Enable for one deployment, then remove.
case "${VERCEL_FORCE_BUILD:-}" in
  1|true)
    echo "vercel-ignore-build: принудительный выпуск настроек — собираю"
    exit 1
    ;;
esac

if [ "$#" -eq 0 ]; then
  echo "vercel-ignore-build: не заданы пути — собираю"
  exit 1
fi

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ]; then
  [ -n "${VERCEL_GIT_COMMIT_REF:-}" ] && ref_known=yes || ref_known=no
  git remote 2>/dev/null | awk '$0 == "origin" { found = 1 } END { exit !found }' && origin_known=yes || origin_known=no
  echo "vercel-ignore-build: env=${VERCEL_ENV:-unknown}, branch-known=$ref_known, origin-known=$origin_known"
fi
if [ -z "$base" ] && [ "${VERCEL_ENV:-}" = "preview" ] && [ -n "${VERCEL_GIT_COMMIT_REF:-}" ]; then
  default_ref="$(git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=10 ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" && $3 == "HEAD" { print $2; exit }')"
  [ -n "$default_ref" ] && echo "vercel-ignore-build: default branch найдена" || echo "vercel-ignore-build: default branch недоступна"
  case "$default_ref" in
    refs/heads/*)
      if git check-ref-format "$default_ref" >/dev/null 2>&1 &&
         [ "${default_ref#refs/heads/}" != "$VERCEL_GIT_COMMIT_REF" ] &&
         git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=10 fetch --quiet --depth=1 origin "$default_ref" 2>/dev/null; then
        base="$(git rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null || true)"
        [ -z "$base" ] || echo "vercel-ignore-build: первый preview — сравниваю с ${default_ref#refs/heads/}"
      fi
      ;;
  esac
fi
if [ -z "$base" ]; then
  echo "vercel-ignore-build: нет достоверной базы — собираю"
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
