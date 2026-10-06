/**
 * Сид ручных сценариев семейства демо обучающего лендинга
 * (`seeds/site-tutorial-demo.json`, формат — приложение A черновика
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`; поле `title`
 * добавлено к формату — им подписывается собранный ролик).
 *
 * Слоты (решение владельца 06.10.2026): `site-tutorial-demo-1` — С3
 * «Условия доставки», `-2` — С2 «Оформить заказ», `-3` — С4 «Запись на
 * консультацию»; пять локалей.
 *
 * Файл вшивается в сборку импортом (`resolveJsonModule`), а не читается
 * с диска: путь, открытый `readFileSync`, трассировщик Vercel может не
 * положить в бандл функции — тот же довод, что у `cron-schedule.ts`.
 *
 * Разбор ЗАКРЫТ: любое несоответствие формата — исключение, а не
 * «годные элементы». Сид пишет строки, которые ночью исполняются в
 * браузере, и половина сида хуже, чем отказ целиком.
 */

import * as seedFile from './seeds/site-tutorial-demo.json';
import { isSiteTutorialDemoKey } from '../tutorial-help/site-tutorial-demo';

export const SITE_TUTORIAL_DEMO_SEED_VERSION = 1;
export const SITE_TUTORIAL_DEMO_SEED_FAMILY = 'site-tutorial-demo';

export interface SiteTutorialDemoSeedEntry {
  subjectKey: string;
  /** Имя сценария из черновика (`C3-delivery`…) — для журнала. */
  scenario: string;
  locale: string;
  /** Заголовок ролика на языке локали. */
  title: string;
  /** Шаги как есть — проверяет их `validateScenarioSteps` (он же у
   *  ручной правки), здесь только форма сида. */
  steps: unknown;
}

const LOCALE_SHAPE = /^[a-z]{2}$/;

/** Разбор содержимого сида. Бросает с причиной на первом несоответствии. */
export function parseSiteTutorialDemoSeed(
  raw: unknown,
): SiteTutorialDemoSeedEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('сид не объект');
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== SITE_TUTORIAL_DEMO_SEED_VERSION) {
    throw new Error(`версия сида не ${SITE_TUTORIAL_DEMO_SEED_VERSION}`);
  }
  if (doc.family !== SITE_TUTORIAL_DEMO_SEED_FAMILY) {
    throw new Error(`семейство сида не «${SITE_TUTORIAL_DEMO_SEED_FAMILY}»`);
  }
  if (!Array.isArray(doc.scenarios) || doc.scenarios.length === 0) {
    throw new Error('в сиде нет сценариев');
  }
  const seen = new Set<string>();
  return doc.scenarios.map((item: unknown, i: number) => {
    const where = `сценарий ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where}: не объект`);
    }
    const e = item as Record<string, unknown>;
    if (
      typeof e.subjectKey !== 'string' ||
      !isSiteTutorialDemoKey(e.subjectKey)
    ) {
      throw new Error(
        `${where}: subjectKey «${String(e.subjectKey)}» не из слотов демо обучающего лендинга`,
      );
    }
    if (typeof e.locale !== 'string' || !LOCALE_SHAPE.test(e.locale)) {
      throw new Error(`${where}: локаль «${String(e.locale)}» не годится`);
    }
    if (
      typeof e.title !== 'string' ||
      !e.title.trim() ||
      e.title.length > 200
    ) {
      throw new Error(`${where}: нет заголовка`);
    }
    if (typeof e.scenario !== 'string' || !e.scenario.trim()) {
      throw new Error(`${where}: нет имени сценария`);
    }
    const pair = `${e.subjectKey}/${e.locale}`;
    if (seen.has(pair)) throw new Error(`${where}: пара ${pair} повторяется`);
    seen.add(pair);
    return {
      subjectKey: e.subjectKey,
      scenario: e.scenario,
      locale: e.locale,
      title: e.title.trim(),
      steps: e.steps,
    };
  });
}

/** Содержимое JSON-модуля: у `import * as` верхний уровень — сам документ
 *  (плюс `default` при `esModuleInterop`). */
function seedDocument(): unknown {
  const mod = seedFile as unknown as { default?: unknown };
  return mod.default && typeof mod.default === 'object' ? mod.default : mod;
}

let cached: SiteTutorialDemoSeedEntry[] | null = null;

/** Сценарии вшитого сида (разобраны один раз на процесс). */
export function siteTutorialDemoSeed(): SiteTutorialDemoSeedEntry[] {
  if (!cached) cached = parseSiteTutorialDemoSeed(seedDocument());
  return cached;
}

/**
 * Заголовок ролика семейства на языке локали — из сида. Нет пары в сиде
 * (локаль вне пяти) — русский заголовок слота, нет и его — сам ключ, как
 * у свободного ключа воркфлоу.
 */
export function siteTutorialDemoTitle(
  subjectKey: string,
  locale: string,
): string {
  let entries: SiteTutorialDemoSeedEntry[];
  try {
    entries = siteTutorialDemoSeed();
  } catch {
    return subjectKey;
  }
  const exact = entries.find(
    (e) => e.subjectKey === subjectKey && e.locale === locale,
  );
  const ru = entries.find(
    (e) => e.subjectKey === subjectKey && e.locale === 'ru',
  );
  return exact?.title ?? ru?.title ?? subjectKey;
}
