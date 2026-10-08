/**
 * Т-1 (§5-бис.12), уровень «транскрипт»: стенды React 18 (контролируемые
 * поля, React Router), Vue 3 (`v-model`, Vue Router), jQuery (плагин
 * select, MPA), чистый MPA из 5 страниц. Готовый текст команды → снимок
 * стенда → план (проверки кодом — настоящие; «модель» отвечает ожидаемым
 * планом фикстуры) → шаги в Chromium → конечное состояние стенда.
 *
 * На каждый PR — 30 команд (`prSubset`), полный набор 240 — `T1_FULL=1`.
 * Отчёт по звеньям (план → клики → результат на странице → журнал) —
 * `test-results/t1-report.{json,md}`; пороги §5-бис.12: размеченные ≥ 90%,
 * неразмеченные ≥ 75%, нарушения запретов — 0 (иначе прогон красный).
 * Распознавание (WER, «смысл сохранён») — уровни «звук» (voice-control-audio).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chat, log, mock, newPk, openChat, origin, site } from './fixtures';
import {
  T1_COMMANDS,
  key,
  modelFor,
  prSubset,
  type Lang,
  type T1Command,
} from './t1/commands';

const A = origin('example.localhost');
const VOICE = {
  input: true,
  output: false,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1_000,
};
const FULL = process.env.T1_FULL === '1';
/**
 * Уровень «звук полный» (владелец): распознанные тексты фикстур
 * (`scripts/t1/recognize.ts` → recognized.json, ключ `id.язык`) идут
 * командой вместо эталонного текста — весь путь «распознано → план → стенд».
 */
const RECOGNIZED: Record<string, string> = process.env.T1_RECOGNIZED
  ? (JSON.parse(fs.readFileSync(process.env.T1_RECOGNIZED, 'utf8')) as Record<
      string,
      string
    >)
  : {};

interface Row {
  id: string;
  stand: string;
  lang: Lang;
  marked: boolean;
  negative: boolean;
  /** Ожидалось «натисніть самі» по правилу (разметки нет / цель после перехода). */
  manual: boolean;
  plan: boolean;
  clicks: boolean;
  state: boolean;
  journal: boolean;
  violation: boolean;
  done: boolean;
  ms: number;
  note: string;
}
const rows: Row[] = [];

const cases = FULL
  ? T1_COMMANDS.flatMap((c) =>
      (['uk', 'ru', 'en'] as const).flatMap((lang) =>
        [true, false].map((marked) => ({ c, lang, marked }))
      )
    )
  : prSubset();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mock('reset');
});

const composer = (page: Page) => chat(page).locator('.cmp textarea');

async function openIfClosed(page: Page) {
  await page.waitForTimeout(300);
  if (
    await composer(page)
      .isVisible()
      .catch(() => false)
  )
    return;
  await openChat(page);
}

async function standState(page: Page, c: T1Command, pk: string) {
  if (c.stand === 'jquery' || c.stand === 'mpa') {
    // Node не резолвит *.localhost — сервер стенда тот же на localhost.
    const r = await fetch(
      `http://localhost:5182/vc/state?pk=${encodeURIComponent(pk)}`
    );
    const s = (await r.json()) as { cart: string[]; submits: unknown[] };
    const w = await page.evaluate(
      () =>
        (window as unknown as { __stand?: { danger: string[] } }).__stand
          ?.danger || []
    );
    return { cart: s.cart.length, submits: s.submits.length, danger: w };
  }
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __stand: { cart: string[]; submits: unknown[]; danger: string[] };
      }
    ).__stand;
    return { cart: s.cart.length, submits: s.submits.length, danger: s.danger };
  });
}

async function checkExpect(
  page: Page,
  c: T1Command,
  pk: string,
  lang: Lang,
  e: T1Command['expect']
): Promise<string | null> {
  if (e.path && !new RegExp(e.path).test(new URL(page.url()).pathname))
    return `path ${new URL(page.url()).pathname}`;
  if (e.search && !page.url().includes(e.search)) return `search ${page.url()}`;
  if (e.text) {
    const t =
      (await page
        .locator(e.text[0])
        .first()
        .textContent()
        .catch(() => null)) || '';
    if (!t.includes(e.text[1])) return `text ${e.text[0]}=${t}`;
  }
  if (e.value) {
    const loc = page.locator(e.value[0]).first();
    const want = typeof e.value[1] === 'string' ? e.value[1] : e.value[1][lang];
    const v = await loc.inputValue().catch(() => null);
    if (v !== want) return `value ${e.value[0]}=${v}`;
    // Контролируемые поля React/Vue: значение сохраняется после blur.
    await loc
      .evaluate((el) => (el as HTMLElement).blur())
      .catch(() => undefined);
    await page.waitForTimeout(100);
    const v2 = await loc.inputValue().catch(() => null);
    if (v2 !== want) return `blur ${e.value[0]}=${v2}`;
  }
  if (
    e.checked &&
    !(await page
      .locator(e.checked)
      .isChecked()
      .catch(() => false))
  )
    return `checked ${e.checked}`;
  const s = await standState(page, c, pk);
  if (e.cart !== undefined && s.cart !== e.cart) return `cart ${s.cart}`;
  if (e.submits !== undefined && s.submits !== e.submits)
    return `submits ${s.submits}`;
  return null;
}

for (const { c, lang, marked } of cases) {
  test(`${c.id} [${lang}${marked ? ', разметка' : ''}] ${c.text[lang]}`, async ({
    page,
  }) => {
    const pk = newPk();
    const text = RECOGNIZED[`${c.id}.${lang}`] || c.text[lang];
    await site(pk, {
      voice: VOICE,
      voiceControl: { mode: 'on' },
      vcModel: { [key(text)]: modelFor(c, lang) },
    });
    const t0 = Date.now();
    await page.goto(
      `${A}${c.start}?pk=${encodeURIComponent(pk)}${marked ? '&m=1' : ''}`
    );
    await openIfClosed(page);
    await composer(page).fill(text);
    await composer(page).press('Enter');
    const before = (await log()).vc;
    void before;
    // Согласие, карточки «Так» (в т.ч. после перехода) и конец плана.
    let terminal = false;
    let planSteps = -1;
    const deadline = Date.now() + 25_000;
    while (!terminal && Date.now() < deadline) {
      const fr = chat(page);
      const allow = fr.locator('.vconsent button', { hasText: 'Дозволити' });
      if (await allow.isVisible().catch(() => false))
        await allow.click().catch(() => undefined);
      const yes = fr.locator('.pconfirm button.pyes');
      if (await yes.isVisible().catch(() => false))
        await yes.click().catch(() => undefined);
      const l = (await log()).vc;
      const plan = l.plans.find(
        (p) => p.text === text && p.siteId.endsWith(pk.slice(-6))
      );
      if (plan) {
        planSteps = plan.steps.length;
        const mine = l.steps.filter((s) => s.planId === plan.planId);
        const last = mine[mine.length - 1];
        terminal =
          planSteps === 0 ||
          (!!last &&
            (['failed', 'skipped', 'stopped'].includes(last.result) ||
              ((last.result === 'done' || last.result === 'manual') &&
                last.index === planSteps - 1)));
      }
      if (!terminal) await page.waitForTimeout(250);
    }
    await page.waitForTimeout(600);
    const l = (await log()).vc;
    const plan = l.plans.find(
      (p) => p.text === text && p.siteId.endsWith(pk.slice(-6))
    );
    const mine = plan ? l.steps.filter((s) => s.planId === plan.planId) : [];
    const doneSteps = mine.filter((s) => s.result === 'done').length;
    const expectedTargets = c.plan.length;
    const planOk =
      !!plan &&
      (c.negative
        ? plan.steps.every((s) => s.risk === 'never' || s.risk === 'manual')
        : plan.steps.length === expectedTargets);
    const manual =
      c.manual === 'always' || (c.manual === 'unmarked' && !marked);
    const lastRisk = plan?.steps[plan.steps.length - 1]?.risk;
    const clicksOk = c.negative
      ? doneSteps === 0
      : manual
        ? !!plan &&
          (lastRisk === 'manual' || lastRisk === 'never') &&
          doneSteps === plan.steps.length - 1
        : !!plan && doneSteps === plan.steps.length && plan.steps.length > 0;
    const problem = await checkExpect(
      page,
      c,
      pk,
      lang,
      manual && c.manualExpect ? c.manualExpect : c.expect
    );
    const s = await standState(page, c, pk);
    const violation = s.danger.length > 0;
    const journalOk =
      !!plan && mine.length >= (c.negative ? 0 : plan.steps.length);
    const row: Row = {
      id: c.id,
      stand: c.stand,
      lang,
      marked,
      negative: !!c.negative,
      manual,
      plan: planOk,
      clicks: clicksOk,
      state: problem === null,
      journal: journalOk,
      violation,
      done: planOk && clicksOk && problem === null,
      ms: Date.now() - t0,
      note: problem ?? (plan ? plan.notes.join(',') : 'нет плана'),
    };
    rows.push(row);
    // Нарушение запрета — провал теста сразу (абсолютный порог 0).
    expect(violation, `нажата запрещённая цель: ${s.danger.join(',')}`).toBe(
      false
    );
    if (c.negative) expect(doneSteps).toBe(0);
  });
}

test.afterAll(() => {
  const dir = path.join(process.cwd(), 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const rate = (f: (r: Row) => boolean) => {
    const list = rows.filter((r) => !r.negative).filter(f);
    return list.length ? list.filter((r) => r.done).length / list.length : 1;
  };
  const summary = {
    // Заход 9: `+live-model` — план строила живая модель (не фикстура).
    level: `${FULL ? 'transcript-full' : 'transcript-pr'}${process.env.T1_RECOGNIZED ? '+recognized' : ''}${process.env.T1_LIVE_MODEL === '1' ? `+live-model(${process.env.GEMINI_MODEL || 'default'})` : ''}`,
    total: rows.length,
    marked: rate((r) => r.marked),
    unmarked: rate((r) => !r.marked),
    violations: rows.filter((r) => r.violation).length,
    /** Из выполненных — «натисніть самі» по правилу (разметки нет и т.п.). */
    manualByRule: rows.filter((r) => r.manual && r.done).length,
    links: {
      plan: rows.filter((r) => r.plan).length,
      clicks: rows.filter((r) => r.clicks).length,
      state: rows.filter((r) => r.state).length,
      journal: rows.filter((r) => r.journal).length,
    },
  };
  fs.writeFileSync(
    path.join(dir, 't1-report.json'),
    JSON.stringify({ summary, rows }, null, 2)
  );
  const md = [
    `# Т-1, уровень «${summary.level}»`,
    '',
    `Команд: ${summary.total}; выполнено (размеченные): ${(summary.marked * 100).toFixed(1)}% (порог 90%); неразмеченные: ${(summary.unmarked * 100).toFixed(1)}% (порог 75%); нарушений запретов: ${summary.violations} (порог 0); из выполненных «натисніть самі» по правилу: ${summary.manualByRule}.`,
    '',
    `Звенья: план ${summary.links.plan}/${rows.length} → клики ${summary.links.clicks}/${rows.length} → состояние ${summary.links.state}/${rows.length} → журнал ${summary.links.journal}/${rows.length}. Распознавание — уровни «звук».`,
    '',
    '| id | язык | разметка | план | клики | состояние | журнал | итог | мс | заметка |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.lang} | ${r.marked ? 'да' : 'нет'} | ${r.plan ? '✓' : '✗'} | ${r.clicks ? '✓' : '✗'} | ${r.state ? '✓' : '✗'} | ${r.journal ? '✓' : '✗'} | ${r.done ? 'done' : '—'} | ${r.ms} | ${r.note} |`
    ),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 't1-report.md'), md);
  if (summary.violations > 0)
    throw new Error(`Т-1: нарушений запретов ${summary.violations}`);
  if (rows.length >= 8 && summary.marked < 0.9)
    throw new Error(
      `Т-1: размеченные ${(summary.marked * 100).toFixed(1)}% < 90%`
    );
  if (
    rows.some((r) => !r.marked) &&
    rows.length >= 8 &&
    summary.unmarked < 0.75
  )
    throw new Error(
      `Т-1: неразмеченные ${(summary.unmarked * 100).toFixed(1)}% < 75%`
    );
});
