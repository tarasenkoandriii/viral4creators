/**
 * Откуда страница поздравлений (`/[locale]/greetings`) берёт картинки —
 * схемы или настоящие кадры продукта (ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5, этап H).
 *
 * Конструкция скопирована с `tutorial-frames.ts`, и по той же причине:
 * **картинки и оговорка «это схемы» переключаются одним списком, а не
 * человеком по чек-листу.** Настоящий кадр — вертикальный снимок
 * телефона, ему нужен `alt`, и он делает неправдой текст «ниже схемы,
 * а не сам интерфейс». Пока локали нет в `GREETING_REAL_FRAME_LOCALES`,
 * страница показывает схемы и оговорку про схемы; как только появилась —
 * кадры и другую оговорку. Единица переключения — локаль целиком:
 * полусконвертированная секция (два снимка и две схемы) не позволяет
 * сказать правду одним предложением.
 *
 * Список сверяется с файлами на диске швом в `scripts/check-docs.mjs`
 * («кадры поздравлений»), остальное — `scripts/greeting-frames.test.ts`.
 *
 * Тип `FrameImage` общий с обучалкой намеренно: у обеих страниц одна
 * оправа `.frame-shot` и один компонент кадра, второй тип с теми же
 * полями разошёлся бы с первым при первой же правке.
 */
import type { Locale } from './i18n';
import type { FrameImage } from './tutorial-frames';

export type { FrameImage };

/** Сколько кадров в «Как это работает»: повод и бриф → «Характер ролика»
 *  → сценарий → готовый ролик 9:16. Держится за длину пунктов секции в
 *  словарях — проверяет тест L1. */
export const GREETING_FRAME_COUNT = 4;

/**
 * Локали, для которых сняты и закоммичены ВСЕ четыре настоящих кадра
 * мастера поздравлений.
 *
 * Пусто: кадры снимаются только прогоном по живому продукту, нарисовать
 * «снимок экрана» нельзя — страница, которая обещает только то, что есть
 * в проде, не может показывать выдуманный интерфейс.
 *
 * Добавлять локаль — ПОСЛЕДНИМ шагом, когда четыре файла
 * `greet-shot-<locale>-{1..4}.avif` уже лежат в `public/illustrations/`.
 * Обратный порядок роняет `check-docs`: шов сверяет список с файлами.
 */
export const GREETING_REAL_FRAME_LOCALES: readonly Locale[] = [];

/** Холст схемы 3:2 — тот же, что у схем обучалки, чтобы оправа
 *  `.frame-shot` не зависела от страницы. */
const SCHEME = { width: 840, height: 540 } as const;

/** Значимая зона экрана 390×844 при двойной плотности, верхние 85% —
 *  то же правило обрезки, что у снимков обучалки (там оно выверено по
 *  первому настоящему кадру с прода). */
const SHOT = { width: 780, height: 1434 } as const;

export function greetingFramesAreReal(locale: Locale): boolean {
  return GREETING_REAL_FRAME_LOCALES.includes(locale);
}

/**
 * Кадр `n` (1…GREETING_FRAME_COUNT) секции «Как это работает».
 * Номер вне диапазона — ошибка вызывающего кода, а не повод молча отдать
 * несуществующий файл: страница собралась бы с битой картинкой.
 */
export function greetingFrame(locale: Locale, n: number): FrameImage {
  if (!Number.isInteger(n) || n < 1 || n > GREETING_FRAME_COUNT) {
    throw new RangeError(
      `greetingFrame: кадра ${n} нет (1…${GREETING_FRAME_COUNT})`,
    );
  }
  if (greetingFramesAreReal(locale)) {
    return {
      src: `/illustrations/greet-shot-${locale}-${n}.avif`,
      ...SHOT,
      real: true,
    };
  }
  return { src: `/illustrations/greet-frame-${n}.svg`, ...SCHEME, real: false };
}

/**
 * Схема секции «Вы в кадре» (этап J, §5.2 п.5). Всегда схема: настоящий
 * кадр этого экрана — чьё-то лицо, а лицо реального человека на
 * рекламной странице требует отдельного согласия (§5.2 п.1). Поэтому
 * силуэт и плитки образов, без текста — холст тот же 840×540, оправа та
 * же `.frame-shot`. Бюджет и «ни текста, ни ссылок» держит
 * `scripts/greeting-frames.test.ts`.
 */
export function greetingPersonaScheme(): FrameImage {
  return { src: '/illustrations/greet-persona.svg', ...SCHEME, real: false };
}
