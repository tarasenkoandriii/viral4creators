/**
 * Вплавление водяного знака в превью видео (ТЗ на маркетплейс §9/§22,
 * защита от пиратства) — тот же хостед-ffmpeg (`postprod/ffmpeg-
 * api.service.ts`), что уже используется для обрезки кадра
 * (`reframe.ts`). Оверлей в плеере здесь не годится намеренно: цель —
 * защита от скачивания превью без контакта с исполнителем, а значит
 * знак обязан быть в самих пикселях, не поверх них.
 *
 * ## Экономно и легковесно, по прямой просьбе
 *
 * - `-preset veryfast`, тот же выбор, что уже сделан в reframe.ts.
 * - `crf 26`, не 18 — это ПРЕВЬЮ на витрине, не финальная поставка
 *   (та остаётся оригиналом `videoUrl`, отдаётся победителю аукциона
 *   после оплаты) — более сильное сжатие здесь уместно и держит и
 *   время рендера, и вес файла меньше.
 * - `-c:a copy` — звук не трогаем, перекодируется только видеодорожка,
 *   куда накладывается фильтр.
 * - Режим NONE вообще не доходит до ffmpeg-сервиса — при выключенном
 *   знаке команда не строится и не отправляется, значит платный вызов
 *   просто не происходит (см. PortfolioWatermarkService.runTick).
 */

export type WatermarkIntensityValue = 'SLIGHT' | 'STANDARD' | 'STRONG';

export interface WatermarkPlan {
  outputName: string;
  command: string;
}

/**
 * Экранирование для значения параметра `text` в фильтре `drawtext` —
 * своя грамматика (`:` разделяет параметры фильтра, `'` обрамляет
 * значение, `\`, `%` тоже спецсимволы) — не то же самое, что shell- или
 * URL-экранирование.
 *
 * Найдено при аудите (защита от пиратства — ровно то, ради чего это
 * ТЗ и существует — не должна сама быть дырой): весь `command` ниже —
 * ОДНА строка вида `-i {{input}} -vf "..." ... {{output}}`, отправляемая
 * внешнему хостед-ffmpeg (`FfmpegApiService`/`verygoodffmpeg`) как
 * готовая командная строка, а не как массив изолированных argv —
 * форма самого кода (`-vf "${drawtextFilters}"`, двойные кавычки как
 * граница аргумента) прямо предполагает, что принимающая сторона
 * разбирает эту строку тем же способом, что и shell. До этой правки
 * функция экранировала `\`, `:`, `'`, `%` — всё, что нужно самому
 * `drawtext`, — но НЕ двойную кавычку `"`, которой заканчивается
 * внешняя граница `-vf "…"`. `watermarkText` — текст исполнителя
 * (`WatermarkMode.CUSTOM`), провалидированный DTO только длиной
 * (`@Length(1, 60)`, portfolio.dto.ts), без ограничений по символам:
 * значение вида `foo" ; …` дошло бы сюда без единой проверки и разорвало
 * бы кавычку `-vf "…"` в передаваемой команде — в лучшем случае сломав
 * рендер (и тем самым триггернув находку про FAILED ниже), в худшем —
 * если сторонний сервис действительно выполняет строку через shell —
 * дав внедрение произвольных флагов/команд на СТОРОННЕМ сервере.
 * Экранирование `"` не вредит ни при каком другом сценарии исполнения
 * (если сторона не парсит как shell, лишняя пара `\"` просто часть
 * текста) — это чистое усиление защиты без даунсайда.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/"/g, '\\"');
}

interface IntensityParams {
  /** Через `,` — несколько инстансов текста на кадр (STRONG — три вместо одного, сложнее обрезать). */
  positions: { x: string; y: string }[];
  fontsizeExpr: string;
  opacity: number;
}

const INTENSITY_PARAMS: Record<WatermarkIntensityValue, IntensityParams> = {
  SLIGHT: {
    positions: [{ x: 'w-tw-20', y: 'h-th-20' }],
    fontsizeExpr: 'h/22',
    opacity: 0.32,
  },
  STANDARD: {
    positions: [{ x: '(w-tw)/2', y: 'h-th-h*0.06' }],
    fontsizeExpr: 'h/14',
    opacity: 0.5,
  },
  STRONG: {
    positions: [
      { x: 'w*0.04', y: 'h*0.08' },
      { x: '(w-tw)/2', y: '(h-th)/2' },
      { x: 'w-tw-w*0.04', y: 'h-th-h*0.08' },
    ],
    fontsizeExpr: 'h/11',
    opacity: 0.65,
  },
};

/**
 * @param text Уже выбранный сервисом текст — имя площадки (дефолт) или
 * то, что попросил исполнитель (WatermarkMode.CUSTOM). Пустая строка
 * или NONE сюда не должны доходить вовсе — вызывающий обязан сам не
 * строить план в этих случаях (см. доккомментарий выше).
 */
export function buildWatermarkPlan(
  text: string,
  intensity: WatermarkIntensityValue,
): WatermarkPlan {
  const params = INTENSITY_PARAMS[intensity];
  const escaped = escapeDrawtext(text);
  const outputName = 'watermarked.mp4';

  const drawtextFilters = params.positions
    .map(
      (pos) =>
        `drawtext=text='${escaped}':fontsize=${params.fontsizeExpr}:fontcolor=white@${params.opacity}:` +
        `bordercolor=black@${Math.min(params.opacity + 0.15, 1)}:borderw=2:x=${pos.x}:y=${pos.y}`,
    )
    .join(',');

  const command =
    `-i {{input}} -vf "${drawtextFilters}" ` +
    `-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p ` +
    `-c:a copy -movflags +faststart {{${outputName}}}`;

  return { outputName, command };
}

/**
 * Единственное место, где решается, какой URL видео показывать НА
 * ПУБЛИЧНОЙ странице (portfolio.service.ts и auction.service.ts —
 * AuctionListing ссылается на тот же PortfolioItem, отдельного резолвера
 * под аукцион не заводим). Приватные/операторские вызовы (владелец,
 * admin-модерация) НЕ проходят через эту функцию — им нужен настоящий
 * оригинал для проверки и редактирования, не защищённая копия.
 *
 * READY — watermarkedVideoUrl. Во всех остальных статусах (PENDING,
 * PROCESSING, FAILED, SKIPPED) — раньше здесь безусловно отдавался
 * оригинал: «лучше показать неотмеченное видео, чем оставить лот без
 * превью вовсе, пока обработка не завершена». Верно для СОВСЕМ нового
 * элемента (`watermarkedVideoUrl` ещё никогда не выставлялся), но
 * найдено при аудите: `PortfolioService.updateOwn()` при правке
 * настроек знака (например, просто сменить интенсивность) переводит
 * `watermarkStatus` обратно в `PENDING` — и до этой правки заодно
 * обнулял уже существующий `watermarkedVideoUrl`, из-за чего уже
 * ОПУБЛИКОВАННЫЙ, уже защищённый ролик мгновенно становился публично
 * доступен БЕЗ знака на всё время, пока `PortfolioWatermarkService`
 * (крон раз в 2 минуты, `portfolio-watermark`) не перегенерирует копию
 * заново — самопричинённая брешь в единственной функции, ради которой
 * весь этот пайплайн и существует (§9/§22, защита от пиратства).
 *
 * Исправлено здесь и в `PortfolioService.updateOwn()` (см. её
 * доккомментарий) — вместе: `updateOwn()` больше не обнуляет
 * `watermarkedVideoUrl` при смене настроек, а эта функция теперь
 * предпочитает ЛЮБОЙ существующий `watermarkedVideoUrl`, даже
 * «протухший» (снятый по старым настройкам, пока свежий ещё не готов),
 * настоящему оригиналу — протухшая, но защищённая копия строго лучше
 * незащищённой в контексте «защита от пиратства», даже если знак на
 * ней не совпадает с последними настройками исполнителя. К оригиналу
 * откатываемся ТОЛЬКО когда защищённой копии не было вообще ни разу
 * (первая обработка нового элемента ещё не завершилась/не удалась) —
 * этот более узкий случай остаётся открытым вопросом ниже.
 */
export function publicVideoUrl(item: {
  videoUrl: string;
  watermarkedVideoUrl: string | null;
  watermarkStatus: string;
}): string {
  if (item.watermarkStatus === 'READY' && item.watermarkedVideoUrl) {
    return item.watermarkedVideoUrl;
  }
  // Протухшая, но защищённая копия — лучше, чем ничем не защищённый
  // оригинал, пока идёт перегенерация после правки настроек знака.
  if (item.watermarkedVideoUrl) {
    return item.watermarkedVideoUrl;
  }
  return item.videoUrl;
}
