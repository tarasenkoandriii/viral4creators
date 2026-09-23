/**
 * §5.2/§11 ТЗ: полнота базы знаний, отсутствие похожих на секреты строк,
 * размер, и что закоммиченный `generated.ts` совпадает с результатом
 * скрипта (тот же приём, что у сверки Prisma-клиента, doc/CI.md) — если
 * кто-то поправил словарь и забыл пересобрать базу знаний, эта проверка
 * красная, а не молчаливо устаревшая база в проде.
 */
import {
  buildAll,
  LOCALES,
  navLabelsFor,
  PROACTIVE_TIPS,
  stepsFor,
} from '../../../../scripts/build-assistant-knowledge';
import { PLANS, PLAN_IDS } from '../../../common/plans';
import { ASSISTANT_KNOWLEDGE, ASSISTANT_STEPS } from './generated';

/**
 * Шапка базы знаний несёт дату сборки и коммит — величины, которые
 * меняются САМИ, без единой правки исходников. Из-за даты сверка
 * «закоммиченное совпадает с пересобранным» была красной каждый день,
 * следующий за регенерацией: 22-го файл собрали, 23-го тест уже падал,
 * хотя не изменилось ничего. Проверка задумана про другое — «словарь
 * поправили, а базу пересобрать забыли», — поэтому штамп приводится к
 * постоянному виду С ОБЕИХ сторон.
 *
 * Заменяются ровно два значения, и только первое вхождение даты (это
 * шапка): формулировка самой строки по-прежнему сверяется, так что
 * изменение шапки без пересборки остаётся красным.
 */
function normalizeStamp(md: string): string {
  return md
    .replace(/\d{4}-\d{2}-\d{2}/, '<дата сборки>')
    .replace(/(коммит — )[^.]*\./, '$1<коммит>.');
}

const SECRET_LIKE = [
  /sk-[A-Za-z0-9]{10,}/,
  /AIza[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{10,}/,
];

describe('assistant knowledge base', () => {
  it.each(LOCALES)(
    '%s.md is non-empty, under 40KB and has no secret-like strings',
    (locale) => {
      const md = buildAll()[locale];
      expect(md.length).toBeGreaterThan(500);
      expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(40 * 1024);
      for (const pattern of SECRET_LIKE) {
        expect(md).not.toMatch(pattern);
      }
    },
  );

  it.each(LOCALES)(
    '%s.md lists all four mini-app nav sections (this catches a silent drift after the tab count changes again)',
    (locale) => {
      const md = buildAll()[locale];
      for (const label of navLabelsFor(locale)) {
        expect(md).toContain(label);
      }
    },
  );

  it.each(LOCALES)('%s.md contains all ten tutorial steps', (locale) => {
    const md = buildAll()[locale];
    for (let n = 1; n <= 10; n++) {
      expect(md).toMatch(new RegExp(`###\\s*${n}\\.`));
    }
  });

  it.each(LOCALES)('%s.md mentions every plan title', (locale) => {
    const md = buildAll()[locale];
    for (const planId of PLAN_IDS) {
      expect(md).toContain(PLANS[planId].title);
    }
  });

  it('generated.ts committed alongside the source matches the build script output (CI parity check)', () => {
    const fresh = buildAll();
    for (const locale of LOCALES) {
      expect(normalizeStamp(ASSISTANT_KNOWLEDGE[locale])).toBe(
        normalizeStamp(fresh[locale]),
      );
    }
  });

  it.each(LOCALES)(
    '%s: ASSISTANT_STEPS in generated.ts matches stepsFor() (10 steps, CI parity)',
    (locale) => {
      const fresh = stepsFor(locale);
      expect(fresh).toHaveLength(10);
      expect(ASSISTANT_STEPS[locale]).toEqual(fresh);
    },
  );

  it.each(LOCALES)(
    '%s has proactive tips for every referenced step, plans and exitIntent',
    (locale) => {
      const tips = PROACTIVE_TIPS[locale];
      expect(tips.plans.length).toBeGreaterThan(0);
      expect(tips.exitIntent.length).toBeGreaterThan(0);
      for (const stepId of ['2', '4', '5', '7', '9', '10']) {
        expect(tips.step[stepId]?.length ?? 0).toBeGreaterThan(0);
      }
    },
  );
});
