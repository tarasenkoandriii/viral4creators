#!/usr/bin/env node
/**
 * Выпуски чанков виджета для канарейки (Э6-бис (г), ТЗ §5-бис.12): после
 * сборки кладёт чанки ЭТОЙ сборки ещё и в `dist/v1/r/<выпуск>/`, а прошлые
 * выпуски из `release.json → keep` (стабильный при канарейке) — скачивает
 * с живого origin виджета, чтобы оба выпуска жили в одном деплое Vercel.
 * Какой выпуск получает сайт, решает сервер (`widget-release` в настройках
 * платформы: стабильный + канарейка 10% по хешу siteId); загрузчик берёт
 * ленивые чанки, а кадр iframe — чат из `/v1/r/<выпуск>/`. Без выпуска
 * (умолчание) — ничего не делает: всё из `/v1/`, как раньше.
 *
 *   WIDGET_RELEASE=2026.10.05-1 npm run build
 *   WIDGET_RELEASE_ORIGIN=https://w.example.com — откуда брать `keep`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.WIDGET_DIST || path.join(ROOT, 'dist');
export const RELEASE_RE = /^[a-z0-9][a-z0-9.-]{0,23}$/;
/** Чанки, которые выбирает выпуск (загрузчик и picker — всегда /v1/). */
export const RELEASE_FILES = [
  'chat.js',
  'chat.css',
  'voice.js',
  'engage.js',
  'highlight.js',
  'act.js',
  // Э6-бис (д): «Вернуть» для полей — рядом с act.js того же выпуска.
  'undo.js',
  // Э6-тер (и): компенсации — рядом с undo.js того же выпуска.
  'comp.js',
  'check.js',
  'vt.js',
  // Э3-бис: связанный режим и поведение (грузятся из выпуска сайта).
  'ana.js',
  'bf.js',
];
/**
 * Чанки, которых в выпусках ДО Э3-бис не было: при сохранении старого
 * выпуска (`keep`) их отсутствие — не ошибка (сайт этого выпуска просто
 * без связанного режима, пока выпуск не сменится).
 */
const NEW_IN_E3B = new Set(['ana.js', 'bf.js']);
/**
 * Э6-тер (и): `comp.js` — нового чанка нет в выпусках до компенсаций; его
 * отсутствие в `keep` — не ошибка (undo.js того выпуска его и не просит).
 */
const NEW_IN_E6T_I = new Set(['comp.js']);

const cfgPath =
  process.env.WIDGET_RELEASE_CONFIG || path.join(ROOT, 'release.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const current = process.env.WIDGET_RELEASE || cfg.current || null;
const keep = Array.isArray(cfg.keep) ? cfg.keep : [];

if (!current && !keep.length) {
  console.log('release: выпусков нет — чанки только в /v1/');
  process.exit(0);
}
for (const r of [current, ...keep].filter(Boolean)) {
  if (!RELEASE_RE.test(r)) {
    console.error(`release: недопустимое имя выпуска «${r}»`);
    process.exit(1);
  }
}

if (current) {
  const dir = path.join(OUT, 'v1', 'r', current);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of RELEASE_FILES) {
    const src = path.join(OUT, 'v1', f);
    if (!fs.existsSync(src)) {
      console.error(`release: нет ${f} — сначала сборка`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(dir, f));
  }
  console.log(`release: ${current} → dist/v1/r/${current}/`);
}

const origin = process.env.WIDGET_RELEASE_ORIGIN || '';
for (const r of keep) {
  if (r === current) continue;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) {
    console.error(
      `release: выпуск ${r} нужно сохранить, но WIDGET_RELEASE_ORIGIN не задан`
    );
    process.exit(1);
  }
  const dir = path.join(OUT, 'v1', 'r', r);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of RELEASE_FILES) {
    const res = await fetch(`${origin}/v1/r/${r}/${f}`);
    if (
      !res.ok &&
      res.status === 404 &&
      (NEW_IN_E3B.has(f) || NEW_IN_E6T_I.has(f))
    ) {
      console.warn(`release: ${r}/${f} — нет в старом выпуске, пропущен`);
      continue;
    }
    if (!res.ok) {
      // Без стабильного выпуска канарейку откатывать некуда — сборка падает.
      console.error(`release: ${r}/${f} — HTTP ${res.status}`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, f), Buffer.from(await res.arrayBuffer()));
  }
  console.log(`release: ${r} (сохранён с ${origin})`);
}
