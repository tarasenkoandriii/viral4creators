/**
 * Матрица режимов выпуска Story‑Tales → что показывает страница
 * (ТЗ `doc/STORY-TALES-LANDING-SPEC.md` §5, ST-LPL-01/02/09).
 *
 * Конфиг (`release.ts`) говорит, какой режим ХОТЕЛИ включить; здесь
 * решается, какой режим страница МОЖЕТ показать честно. Режим опускается
 * до ближайшего рабочего, а не «включается частично»:
 *
 *  - `commercial` — нужен мастер (флаг + разрешённый адрес) и
 *    `checkoutEnabled`; иначе ниже;
 *  - `wizard` — нужен мастер (флаг + разрешённый адрес); иначе ниже;
 *  - `pilot` — нужно одобренное демо И готовый плеер (§9) на странице;
 *    иначе ниже;
 *  - `prep` — всегда возможен.
 *
 * Готовность того, чего нет в конфиге, — плеера и обработчика заявок —
 * передаёт страница (`readiness`): в v1 обоих нет, и ни демо, ни форма
 * не появятся от одной правки JSON.
 *
 * Основное действие `prep` (решение владельца 16.10, Р-STL-17) — открыть
 * раздел Story‑Tales в приложении (`#/stories`, метка `stories`): там уже
 * настраивается профиль рассказчика. Ссылку собирает страница (`links`):
 * Telegram (`t.me/<бот>/app?startapp=e_stories`) предпочтительнее,
 * иначе браузерный адрес TMA. Нет ни бота, ни настоящего адреса TMA —
 * безопасный откат: основным становится якорь «Как это работает», а не
 * мёртвая ссылка. Цены в конфиге нет вовсе, поэтому
 * `showPrice` не бывает `true` ни в одном режиме: до коммерческой
 * приёмки цена не публикуется (§6.9), а после неё понадобится новое
 * поле с настоящими значениями, а не флаг.
 */
import type { ReleaseMode, StoryRelease } from './release';

/**
 * `telegram`/`app` — раздел приложения (Telegram или браузер), `lead` —
 * «Узнать о запуске» (форма заявки, итерация 2), `create` — мастер.
 */
export type CtaId = 'how' | 'example' | 'lead' | 'create' | 'telegram' | 'app';

export interface CtaAction {
  id: CtaId;
  /** Якорь страницы (`#how`), раздел приложения или разрешённый адрес мастера. */
  href: string;
}

export interface StoryReadiness {
  /** Плеер §9 реализован и проверен на странице. */
  playerReady: boolean;
  /** Подключён реальный обработчик заявок (§10). */
  leadHandlerReady: boolean;
}

/** v1: ни плеера, ни обработчика заявок. */
export const V1_READINESS: Readonly<StoryReadiness> = Object.freeze({
  playerReady: false,
  leadHandlerReady: false,
});

/** Ссылки в раздел `#/stories` приложения; `null` — недоступна. */
export interface StoryAppLinks {
  telegramHref: string | null;
  browserHref: string | null;
}

export const NO_APP_LINKS: Readonly<StoryAppLinks> = Object.freeze({
  telegramHref: null,
  browserHref: null,
});

export interface StoryView {
  /** Режим, который страница действительно показывает. */
  mode: ReleaseMode;
  /** Одно основное действие — в шапке, первом экране и финале (§6.11). */
  primary: CtaAction;
  /** Вторичные действия первого экрана. */
  secondary: CtaAction[];
  /**
   * Ссылка в раздел приложения, если она есть, — для блока «Как это
   * работает», когда основным действием стала не она.
   */
  app: CtaAction | null;
  /** Кнопка воспроизведения и блок демо — только с настоящим роликом. */
  showPlay: boolean;
  /** Якорь «Пример» в шапке — только когда пример можно посмотреть. */
  showExampleNav: boolean;
  /** Форма заявки «Узнать о запуске». */
  showLeadForm: boolean;
  /** Оплата внутри мастера разрешена. */
  showCheckout: boolean;
  /** Цена на странице. Нет данных о цене — всегда `false`. */
  showPrice: false;
  /** Каталог редакций. */
  showCatalog: boolean;
}

export const ANCHORS = {
  how: '#how',
  example: '#example',
  launch: '#launch',
} as const;

const HOW: CtaAction = { id: 'how', href: ANCHORS.how };
const EXAMPLE: CtaAction = { id: 'example', href: ANCHORS.example };
const LEAD: CtaAction = { id: 'lead', href: ANCHORS.launch };

/**
 * Ссылка в раздел приложения: только та, что ведёт в `stories` (метка
 * `entry=stories` или `startapp=e_stories…`), — чужой адрес сюда попасть
 * не должен даже по ошибке вызова.
 */
export function appCta(links: StoryAppLinks): CtaAction | null {
  const tg = links.telegramHref;
  if (tg && /^https:\/\/t\.me\/[A-Za-z0-9_]+\/app\?startapp=e_stories(?:__r_[A-Z0-9]{8})?$/.test(tg)) {
    return { id: 'telegram', href: tg };
  }
  const web = links.browserHref;
  if (web && /^https?:\/\/[^?#]+\?entry=stories(?:&ref=[A-Z0-9]{8})?#\/stories$/.test(web)) {
    return { id: 'app', href: web };
  }
  return null;
}

/**
 * `wizardUrl` здесь уже проверен `parseStoryRelease` (разрешённый хост)
 * — иначе конфиг был бы отвергнут целиком. Пустой адрес при включённом
 * флаге — несогласованность, режим опускается.
 */
export function effectiveMode(config: StoryRelease, readiness: StoryReadiness): ReleaseMode {
  const wanted = config.releaseMode;
  const wizardOk = config.wizardEnabled && typeof config.wizardUrl === 'string' && config.wizardUrl.length > 0;
  const demoOk = config.demo !== null && readiness.playerReady;
  if (wanted === 'commercial' && wizardOk && config.checkoutEnabled) return 'commercial';
  if ((wanted === 'commercial' || wanted === 'wizard') && wizardOk) return 'wizard';
  if (wanted !== 'prep' && demoOk) return 'pilot';
  return 'prep';
}

export function resolveStoryView(
  config: StoryRelease,
  readiness: StoryReadiness,
  links: StoryAppLinks = NO_APP_LINKS,
): StoryView {
  const mode = effectiveMode(config, readiness);
  const demoOk = config.demo !== null && readiness.playerReady;
  const leadForm = mode !== 'prep' && config.leadFormEnabled && readiness.leadHandlerReady;
  const app = appCta(links);
  const base = {
    mode,
    app,
    showPlay: mode !== 'prep' && demoOk,
    showExampleNav: mode !== 'prep' && demoOk,
    showLeadForm: leadForm,
    showCheckout: mode === 'commercial',
    showPrice: false as const,
    showCatalog: config.catalogEnabled && mode !== 'prep',
  };
  switch (mode) {
    case 'commercial':
    case 'wizard': {
      const create: CtaAction = { id: 'create', href: config.wizardUrl as string };
      return { ...base, primary: create, secondary: [demoOk ? EXAMPLE : HOW] };
    }
    case 'pilot':
      return { ...base, primary: EXAMPLE, secondary: leadForm ? [HOW, LEAD] : [HOW] };
    case 'prep':
    default:
      // Раздел приложения — основным; без ссылки — якорь (откат).
      return app ? { ...base, primary: app, secondary: [HOW] } : { ...base, primary: HOW, secondary: [] };
  }
}
