/**
 * Публичное семейство тем «демо обучающего лендинга» (TODO «Актуальное
 * демо трёх лендингов и TMA», пункт «отдельное демо обучающего
 * лендинга», 06.10.2026). Черновик сценариев и что решает владелец —
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`.
 *
 * ## Что это
 *
 * Ключи `site-tutorial-demo-1..N` — СЛОТЫ галереи на `/site-tutorial`, а
 * не имена сценариев: какой сценарий ляжет в какой слот, решает
 * владелец, и решение не должно требовать правки ключей на двух
 * сторонах (бэкенд и `landing/src/lib/tutorial-demo-api.ts`).
 *
 * ## Свой барьер, а не ослабленный чужой
 *
 * Ключ `client-site` (ролики по сайтам ЗАКАЗЧИКОВ) публично не
 * выдаётся никогда — `CLOSED_HELP_SUBJECT_KEYS` ниже закрывает его
 * явно, до каталога тем, а не только тем, что такой темы в каталоге
 * нет. Этот барьер здесь не трогается и не обходится: новое семейство —
 * отдельные ключи со своим, более строгим правилом.
 *
 * Ролик семейства выдаётся, только если ОДНОВРЕМЕННО:
 *
 *  1. ключ — ровно один из `SITE_TUTORIAL_DEMO_KEYS` (не префикс:
 *     `site-tutorial-demo-99` — 404, как любая неизвестная тема);
 *  2. строка вычитана (`reviewed: true`) — общее правило справки;
 *  3. у строки НЕТ `clientSiteDraftId` — в выборке И повторно в коде
 *     (ролик сайта заказчика сюда не попадает даже при сбое `where`);
 *  4. id строки есть в отдельной отметке оператора
 *     `tutorial.siteTutorialDemoAssets` (`PlatformSetting`, JSON-массив
 *     id) — второе, отдельное решение «это ролик с НАШЕГО полигона,
 *     годится в публичное демо обучалки». `reviewed` одно этого не
 *     говорит: оно ставится и роликам шагов мастера.
 *
 * Отметки нет, она пуста, не разбирается или сервис настроек недоступен —
 * роликов семейства нет вовсе (закрыто по умолчанию), запросов к таблице
 * роликов тоже. Текст темы при этом отдаётся, как у любой темы справки:
 * лендинг по нему показывает честное «скоро».
 *
 * Отметку ставит оператор галочкой «В демо обучающего лендинга» на
 * вкладке «Видео-контент» (`PATCH /admin/tutorial-video-assets/:id/
 * site-tutorial-demo`, `TutorialVideoAdminService.setSiteTutorialDemo`):
 * только строке семейства, без `clientSiteDraftId`, вычитанной и
 * собранной. Ролики семейства снимает сценарный путь раннера на
 * витрине `/qa/demo-shop` (решение владельца 06.10.2026, путь А;
 * `tutorial-runner/polygon-scenario.ts`).
 */

/** Сколько слотов демо у обучающего лендинга. Владелец выбирает 2–3
 *  сценария из черновика; третий слот — запас, а не обещание. */
export const SITE_TUTORIAL_DEMO_SLOTS = 3;

export const SITE_TUTORIAL_DEMO_KEYS: readonly string[] = Array.from(
  { length: SITE_TUTORIAL_DEMO_SLOTS },
  (_, i) => `site-tutorial-demo-${i + 1}`,
);

export function isSiteTutorialDemoKey(subjectKey: string): boolean {
  return SITE_TUTORIAL_DEMO_KEYS.includes(subjectKey);
}

/**
 * Префикс семейства — для ИСКЛЮЧЕНИЯ у чужих потребителей роликов
 * (консультант главной, набор роликов лендинга-тенанта, сводки демо).
 *
 * Выдача и съёмка работают по точному списку (`isSiteTutorialDemoKey`),
 * а исключение — по префиксу, и это разные стороны одной осторожности:
 * пускать — только известное, не пускать — всё, что похоже. Строка
 * `site-tutorial-demo-99` не выдаётся справкой и не должна всплыть у
 * консультанта.
 */
export const SITE_TUTORIAL_DEMO_PREFIX = 'site-tutorial-demo-';

export function isSiteTutorialDemoFamilyKey(subjectKey: string): boolean {
  return (
    typeof subjectKey === 'string' &&
    subjectKey.startsWith(SITE_TUTORIAL_DEMO_PREFIX)
  );
}

/** Условие Prisma «не семейство демо обучающего лендинга» — одно на
 *  всех потребителей, чтобы префикс не расходился между запросами. */
export const NOT_SITE_TUTORIAL_DEMO_WHERE = {
  NOT: { subjectKey: { startsWith: SITE_TUTORIAL_DEMO_PREFIX } },
} as const;

/**
 * Ключи, которые публичная справка не выдаёт НИКОГДА — ни текстом, ни
 * роликом, даже если тема с таким именем однажды появится в каталоге.
 * `client-site` — ролики обучалки по сайтам заказчиков (§6.2
 * `doc/CLIENT-SITE-TUTORIAL-SPEC.md`): у них своя витрина владельцу
 * проекта и своё одобрение, посетителю лендинга они не показываются.
 */
export const CLOSED_HELP_SUBJECT_KEYS: readonly string[] = ['client-site'];

export function isClosedHelpSubjectKey(subjectKey: string): boolean {
  return CLOSED_HELP_SUBJECT_KEYS.includes(subjectKey);
}

/** Отметка оператора: какие ролики допущены в публичное демо обучалки. */
export const SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY =
  'tutorial.siteTutorialDemoAssets';

/** Потолок отметки: больше — это уже не «2–3 сценария × 2 темы × 5
 *  языков», а ошибка ввода; закрываемся, а не берём первые N. */
export const SITE_TUTORIAL_DEMO_MAX_MARKED = 100;

/** Форма id строки (`cuid()`), без пробелов и спецсимволов. */
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Значение настройки → список id. Закрыто по умолчанию: не JSON, не
 * массив, слишком длинный массив, хотя бы один элемент не похож на id —
 * пустой список, то есть ни одного ролика. Брать «годные элементы из
 * негодного значения» здесь нельзя: значение, записанное с ошибкой,
 * не должно публиковать часть того, что в нём перечислено.
 */
export function parseSiteTutorialDemoAssetIds(
  raw: string | null | undefined,
): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  if (value.length > SITE_TUTORIAL_DEMO_MAX_MARKED) return [];
  if (!value.every((id) => typeof id === 'string' && ASSET_ID.test(id))) {
    return [];
  }
  return [...new Set(value as string[])];
}

export interface SiteTutorialDemoTopic {
  title: string;
  text: string;
}

/**
 * Тексты слотов — НЕЙТРАЛЬНЫЕ до решения владельца: сценарии ещё не
 * согласованы, и называть слот «Как оформить заказ» значило бы
 * пообещать ролик, которого может не быть. Когда владелец выберет
 * сценарии, заголовки станут их названиями (черновик, раздел «Тексты»).
 * Обещание в тексте одно и проверяемое: ролик снят на нашем
 * полигоне, данные вымышленные, сайтов заказчиков здесь нет.
 */
const TOPIC_TEXTS: Record<
  string,
  { title: (n: number) => string; text: string }
> = {
  ru: {
    title: (n) => `Пример обучалки ${n}`,
    text: 'Пример ролика, собранного на нашем тестовом сайте-полигоне. Данные в нём вымышленные; ролики по сайтам заказчиков здесь не публикуются.',
  },
  uk: {
    title: (n) => `Приклад навчального відео ${n}`,
    text: 'Приклад відео, зібраного на нашому тестовому сайті-полігоні. Дані в ньому вигадані; відео за сайтами замовників тут не публікуються.',
  },
  en: {
    title: (n) => `Tutorial example ${n}`,
    text: 'An example video made on our own test site. All data in it is made up; videos of customer sites are never published here.',
  },
  de: {
    title: (n) => `Beispiel-Erklärvideo ${n}`,
    text: 'Ein Beispielvideo, erstellt auf unserer eigenen Testseite. Alle Daten darin sind erfunden; Videos von Kundenseiten werden hier nicht veröffentlicht.',
  },
  es: {
    title: (n) => `Ejemplo de tutorial ${n}`,
    text: 'Un vídeo de ejemplo creado en nuestro propio sitio de pruebas. Todos los datos son ficticios; aquí nunca se publican vídeos de sitios de clientes.',
  },
};

/** Тема слота на языке запроса; `null` — ключ не из семейства. */
export function siteTutorialDemoTopicFor(
  subjectKey: string,
  locale: string,
): SiteTutorialDemoTopic | null {
  if (!isSiteTutorialDemoKey(subjectKey)) return null;
  const texts = TOPIC_TEXTS[locale] ?? TOPIC_TEXTS.ru;
  const n = SITE_TUTORIAL_DEMO_KEYS.indexOf(subjectKey) + 1;
  return { title: texts.title(n), text: texts.text };
}
