#!/usr/bin/env node
/**
 * Какие джобы CI запускать на этом коммите (джоба `changes` в
 * .github/workflows/ci.yml). Зачем: приватный репозиторий платит минутами
 * GitHub Actions, а полный прогон — ≈28 оплачиваемых минут на коммит
 * (9 джоб). Большинство коммитов трогает одну-две папки.
 *
 * База сравнения:
 *  - pull_request — база PR;
 *  - push — коммит ПОСЛЕДНЕГО УСПЕШНОГО прогона CI на этой ветке (как
 *    VERCEL_GIT_PREVIOUS_SHA у scripts/vercel-ignore-build.sh): прогон,
 *    отменённый следующим пушем (concurrency), или красный прогон не
 *    «съедают» свои изменения — они попадут в следующее сравнение;
 *  - нет успешного прогона, база не предок HEAD, workflow_dispatch,
 *    сбой API — запускается ВСЁ (лишний прогон дешевле пропущенного).
 *
 * Вывод — строки `<джоба>=true|false` и `next_apps=[…]` для $GITHUB_OUTPUT.
 *
 *   node scripts/ci-changes.mjs              — в CI
 *   node scripts/ci-changes.mjs --self-test  — проверка правил (make ci-docs,
 *                                              джоба «репозиторий»)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Джоба → префиксы путей, изменение которых её запускает. Источник
 * зависимостей — то, что джоба реально читает:
 *  - backend: prebuild собирает базу знаний консультанта из словарей
 *    landing/ и frontend/; sync-legal сверяет doc/legal с TERMS_VERSION;
 *  - sites_backend: копии backend/src/common (sync-sites-shared) и правила
 *    графа импортов;
 *  - assist: тесты сверяют формы с исходниками sites-backend/src, кит —
 *    site-tma-kit (sync-site-tma-kit);
 *  - widget: тест бренда импортирует sites-backend/src/brand.ts;
 *  - assist_integrations (Э3: npm-пакет, плагин WordPress, GTM): зеркала
 *    бренда сверяются с sites-backend/src/brand.ts; векторы подписи
 *    вебхука целей (assist-integrations/fixtures/) читает и спек
 *    sites-backend — поэтому они же запускают sites_backend;
 *  - frontend: unit-скрипты импортируют backend/src.
 * Тест «джобы ↔ правила» ниже падает, если в ci.yml появилась джоба без
 * условия или условие без правила.
 */
export const FILTERS = {
  backend: ['backend/', 'landing/src/dictionaries/', 'frontend/src/dictionaries/', 'doc/legal/'],
  sites_backend: [
    'sites-backend/',
    'backend/src/common/',
    'scripts/sync-sites-shared.mjs',
    'scripts/check-sites-import-graph.mjs',
    'assist-integrations/fixtures/',
  ],
  assist: ['assist/', 'site-tma-kit/', 'sites-backend/src/', 'scripts/sync-site-tma-kit.mjs'],
  widget: ['widget/', 'sites-backend/src/brand.ts'],
  assist_integrations: ['assist-integrations/', 'sites-backend/src/brand.ts'],
  // Лендинг (Л2–Л3): CI собирает виджет и гоняет его e2e на стенде; тест
  // контракта читает формы событий/черновиков и контраст из sites-backend;
  // deeplink `wd_` — из кита.
  sites_landing: [
    'sites-landing/',
    'widget/',
    'sites-backend/src/modules/assist-widget/landing/',
    'sites-backend/src/modules/assist-site-setup/widget-config.ts',
    'sites-backend/src/config/assist-defaults.ts',
    'site-tma-kit/src/start-param.ts',
    // Л4–Л5: тесты лендинга сверяют песочницу, код установки, имена и
    // подпись вебхука целей с исходниками продукта и пакета интеграций.
    'sites-backend/src/brand.ts',
    'sites-backend/src/modules/assist-sandbox/',
    'sites-backend/src/modules/assist-knowledge-core/api-types.ts',
    'sites-backend/src/modules/assist-site-setup/snippet.ts',
    'sites-backend/src/modules/assist-site-setup/keys.ts',
    'sites-backend/src/modules/assist-analytics/webhook-signature.ts',
    'sites-backend/src/modules/assist-analytics/goal-webhook.controller.ts',
    'sites-backend/src/modules/assist-analytics/goal-webhook.service.ts',
    'sites-backend/src/modules/site-core/hosts/host-normalize.ts',
    'assist-integrations/',
  ],
  frontend: ['frontend/', 'backend/src/'],
  admin: ['admin/'],
  landing: ['landing/'],
  // Реле живого входа (Э-С Ш0.2): свои исходники и источники копий
  // фильтра исходящего трафика (scripts/sync-relay-shared.mjs).
  live_login_relay: [
    'live-login-relay/',
    'backend/src/common/external-url-guard.ts',
    'backend/src/common/egress-filter-proxy.ts',
    'scripts/sync-relay-shared.mjs',
    // Тест защит скрипта правил хоста (live-login-relay/test/egress-script.spec.ts).
    'doc/relay-egress-docker-user.sh',
  ],
  // Браузерный воркер (Э-С Ш3): свои исходники и источники копий
  // (scripts/sync-worker-shared.mjs) — фильтр трафика и подпись из backend,
  // протокол очереди, конверт учёток и стоп-лист кликов из sites-backend.
  browser_worker: [
    'browser-worker/',
    'backend/src/common/external-url-guard.ts',
    'backend/src/common/egress-filter-proxy.ts',
    'backend/src/common/sites-internal-signature.ts',
    'backend/src/modules/client-site-tutorial/danger-words.ts',
    'sites-backend/src/modules/assist-ui-core/normalize.ts',
    'sites-backend/src/modules/assist-ui-core/action-words.ts',
    'sites-backend/src/modules/browser-jobs/protocol.ts',
    'sites-backend/src/modules/browser-jobs/worker-seal.ts',
    'scripts/sync-worker-shared.mjs',
  ],
};
/** Изменение любого из этих путей запускает всё. */
/** `.nvmrc` — версия Node для всех джоб: её смена перепроверяет всё. */
export const GLOBAL = ['.github/workflows/ci.yml', 'scripts/ci-changes.mjs', '.nvmrc'];
/** Джобы матрицы next-apps (их имя в матрице = ключ FILTERS). */
export const NEXT_APPS = ['admin', 'landing'];

export function decide(files) {
  const all = files === null || files.some((f) => GLOBAL.includes(f));
  const out = {};
  for (const [job, prefixes] of Object.entries(FILTERS)) {
    out[job] = all || files.some((f) => prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  }
  out.next_apps = NEXT_APPS.filter((a) => out[a]);
  return out;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function lastSuccessfulSha() {
  const { GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: branch, GH_TOKEN: token } = process.env;
  if (!repo || !branch || !token) return null;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=1`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.workflow_runs?.[0]?.head_sha ?? null;
}

async function changedFiles() {
  const event = process.env.GITHUB_EVENT_NAME;
  let base = null;
  if (event === 'pull_request') base = process.env.PR_BASE_SHA || null;
  else if (event === 'push') base = await lastSuccessfulSha().catch(() => null);
  if (!base) {
    console.error(`ci-changes: нет базы сравнения (${event}) — запускаю всё`);
    return null;
  }
  try {
    git('cat-file', '-e', `${base}^{commit}`);
    git('merge-base', '--is-ancestor', base, 'HEAD');
  } catch {
    console.error(`ci-changes: база ${base.slice(0, 7)} недоступна или не предок HEAD — запускаю всё`);
    return null;
  }
  const files = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  console.error(`ci-changes: с ${base.slice(0, 7)} изменено файлов: ${files.length}`);
  return files;
}

function selfTest() {
  let failed = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++;
      console.error(`FAIL ${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    }
  };
  const on = (files) => Object.keys(FILTERS).filter((k) => decide(files)[k]);
  eq('нет базы — всё', on(null), Object.keys(FILTERS));
  eq('ci.yml — всё', on(['.github/workflows/ci.yml']), Object.keys(FILTERS));
  eq('только документы — ничего', on(['doc/DEPLOYMENT.md', 'docs-tz/x.md', 'README.md']), []);
  eq('виджет — и лендинг (стенд виджета)', on(['widget/src/loader/index.ts']), ['widget', 'sites_landing']);
  eq('.nvmrc — всё', on(['.nvmrc']), Object.keys(FILTERS));
  eq('формы событий лендинга', on(['sites-backend/src/modules/assist-widget/landing/landing.service.ts']), ['sites_backend', 'assist', 'sites_landing']);
  eq('brand.ts бэкенда — бэк, assist, виджет, интеграции, лендинг', on(['sites-backend/src/brand.ts']), ['sites_backend', 'assist', 'widget', 'assist_integrations', 'sites_landing']);
  eq('плагин WordPress — интеграции и лендинг (сверка документации)', on(['assist-integrations/wordpress/v4c-assist/v4c-assist.php']), ['assist_integrations', 'sites_landing']);
  eq('векторы подписи — интеграции, бэк и лендинг', on(['assist-integrations/fixtures/goal-webhook-vectors.json']), ['sites_backend', 'assist_integrations', 'sites_landing']);
  eq('модуль sites-backend — бэк и assist', on(['sites-backend/src/modules/x.ts']), ['sites_backend', 'assist']);
  eq('миграция sites-backend — только бэк', on(['sites-backend/prisma/schema.prisma']), ['sites_backend']);
  eq('общий модуль backend — три джобы', on(['backend/src/common/plans.ts']), ['backend', 'sites_backend', 'frontend']);
  eq('словарь лендинга — backend и landing', on(['landing/src/dictionaries/uk.json']), ['backend', 'landing']);
  eq('кит TMA', on(['site-tma-kit/src/telegram.ts']), ['assist']);
  eq('next_apps', decide(['admin/src/a.tsx']).next_apps, ['admin']);
  eq('next_apps пусто', decide(['widget/x']).next_apps, []);
  eq('точный файл, не префикс', on(['scripts/sync-sites-shared.mjs.bak']), []);
  eq('реле — только своя джоба', on(['live-login-relay/src/session.ts']), ['live_login_relay']);
  eq('скрипт правил хоста реле', on(['doc/relay-egress-docker-user.sh']), ['live_login_relay']);
  eq('фильтр исходящего трафика — бэк, его копии, реле и воркер', on(['backend/src/common/egress-filter-proxy.ts']), ['backend', 'sites_backend', 'frontend', 'live_login_relay', 'browser_worker']);
  eq('воркер Ш3 — только своя джоба', on(['browser-worker/src/runner.ts']), ['browser_worker']);
  eq('протокол очереди воркера — бэк сайтов, assist и воркер', on(['sites-backend/src/modules/browser-jobs/protocol.ts']), ['sites_backend', 'assist', 'browser_worker']);
  eq('стоп-лист обучалки — бэк, его копии и воркер', on(['backend/src/modules/client-site-tutorial/danger-words.ts']), ['backend', 'frontend', 'browser_worker']);
  eq('скрипт копий воркера', on(['scripts/sync-worker-shared.mjs']), ['browser_worker']);

  // Каждая джоба ci.yml, кроме changes и repo, запускается по своему правилу.
  const full = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const yml = full.slice(full.indexOf('\njobs:\n'));
  const jobs = [...yml.matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
  const used = new Set();
  for (const job of jobs) {
    if (job === 'changes' || job === 'repo') continue;
    const body = yml.slice(yml.indexOf(`\n  ${job}:`) + 1).split(/\n {2}[a-z][a-z-]*:\s*\n/)[0];
    if (!/^ {4}needs: changes\s*$/m.test(body)) {
      failed++;
      console.error(`FAIL джоба ${job}: нет «needs: changes»`);
    }
    const m = /^ {4}if: .*needs\.changes\.outputs\.([a-z_]+)/m.exec(body);
    if (!m) {
      failed++;
      console.error(`FAIL джоба ${job}: нет условия по needs.changes.outputs.*`);
      continue;
    }
    if (m[1] !== 'next_apps' && !(m[1] in FILTERS)) {
      failed++;
      console.error(`FAIL джоба ${job}: правило ${m[1]} не описано в FILTERS`);
    }
    used.add(m[1] === 'next_apps' ? NEXT_APPS : [m[1]]);
  }
  const covered = new Set([...used].flat());
  for (const k of Object.keys(FILTERS)) {
    if (!covered.has(k)) {
      failed++;
      console.error(`FAIL правило ${k} есть в FILTERS, но ни одна джоба по нему не запускается`);
    }
    if (!new RegExp(`^ {6}${k}: \\$\\{\\{ steps\\.f\\.outputs\\.${k} \\}\\}`, 'm').test(yml)) {
      failed++;
      console.error(`FAIL джоба changes не отдаёт output ${k}`);
    }
  }
  if (failed) {
    console.error(`ci-changes --self-test: ${failed} ошибок`);
    process.exit(1);
  }
  console.log(`ok   ci-changes: правил ${Object.keys(FILTERS).length}, джоб с условием ${jobs.length - 2}, самотест — 24 случая`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const out = decide(await changedFiles());
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`);
}
