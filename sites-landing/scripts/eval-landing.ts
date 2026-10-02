/**
 * Живой прогон eval-набора лендинга (§14 Л2) против НАШЕГО опубликованного
 * виджета. Запускает владелец (ключа и живого бэкенда в песочнице нет):
 *
 *   cd sites-landing
 *   SITE_URL=https://assist.viral4creators.app \
 *   ASSIST_WIDGET_ORIGIN=https://assist-w.viral4creators.app \
 *   ASSIST_WIDGET_PK=pk_live_… npx tsx scripts/eval-landing.ts [--only id1,id2] [--json out.json]
 *
 * Как браузер: `POST /widget/v1/session` с Origin виджета и parentOrigin =
 * SITE_URL (хост лендинга должен быть подтверждён и включён в виде), затем
 * каждый вопрос — новым диалогом `POST /widget/v1/chat` с
 * `Accept: application/json` (запасной путь без SSE, тот же конвейер).
 * Пауза между вопросами — лимит 10/мин на посетителя. Вопросы тратят
 * бюджет сайта (≈ 30 диалогов) — это настоящие ответы модели.
 *
 * Итог — таблица и код выхода 1, если хоть один ответ не прошёл оценку
 * (`scripts/lib/eval-grade.ts`: со ссылкой на страницу лендинга, без чисел,
 * которых нет на сайте, честное «не знаю» вне знаний).
 */
import fs from 'node:fs';
import data from '../eval/landing-eval.json';
import { readAssistEnv } from '../src/lib/assist-env';
import { grade, siteNumbers, type EvalAnswer, type EvalItem, type Grade } from './lib/eval-grade';

const site = (process.env.SITE_URL ?? '').replace(/\/$/, '');
const env = readAssistEnv(process.env);
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 7000);
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

async function call(path: string, body: unknown, token?: string) {
  const res = await fetch(`${env.widgetOrigin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: env.widgetOrigin,
      ...(token ? { 'X-Assist-Visitor': token } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: Record<string, unknown>; error?: { code?: string } } | null;
  if (!json?.success || !json.data) throw new Error(`${path}: ${res.status} ${json?.error?.code ?? 'нет конверта'}`);
  return json.data;
}

async function main() {
  if (!site || !env.widgetPk) {
    console.error('Нужны SITE_URL (адрес лендинга, подтверждённый хост) и ASSIST_WIDGET_PK (ключ нашего виджета).');
    process.exit(2);
  }
  const items = (data.items as EvalItem[]).filter((i) => !only || only.includes(i.id));
  const allowed = siteNumbers();
  const session = await call('/widget/v1/session', { pk: env.widgetPk, parentOrigin: site });
  const token = String(session.visitorToken);
  const grades: Array<Grade & { q: string; answer: EvalAnswer }> = [];
  for (const [n, item] of items.entries()) {
    if (n) await new Promise((r) => setTimeout(r, PAUSE_MS));
    let answer: EvalAnswer;
    try {
      const r = await call(
        '/widget/v1/chat',
        {
          conversationId: null,
          clientRequestId: `eval-${item.id}-${Date.now()}`,
          question: item.q,
          page: { url: `${site}/${item.lang}/assistant`, title: null },
          context: null,
          uiLang: item.lang,
        },
        token,
      );
      answer = { text: String(r.text ?? ''), sources: (r.sources as EvalAnswer['sources']) ?? [], refused: r.refused === true };
    } catch (e) {
      answer = { text: `ОШИБКА: ${(e as Error).message}`, sources: [], refused: false };
    }
    const g = grade(item, answer, { siteOrigin: site, allowed });
    grades.push({ ...g, q: item.q, answer });
    console.log(`${g.ok ? 'ok  ' : 'FAIL'} ${item.id.padEnd(28)} ${g.problems.join('; ')}`);
  }
  const passed = grades.filter((g) => g.ok).length;
  console.log(`\nитог: ${passed}/${grades.length} ответов прошли (со ссылкой, без выдуманных чисел, «не знаю» вне знаний)`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(grades, null, 2));
  if (passed !== grades.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
