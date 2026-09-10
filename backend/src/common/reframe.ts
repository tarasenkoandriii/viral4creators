/**
 * Обрезка кадра до целевого формата (ТЗ §16.1, этап 34).
 *
 * Veo рендерит нативно только 16:9 и 9:16. С этапа 20 пользователь мог
 * выбрать любой формат, ролик снимался в ближайшем родном «с композицией
 * под центральную обрезку», а сама обрезка оставалась обещанием: у
 * Vercel Functions нет ffmpeg, и `reframePending` честно висел флагом.
 * Этап 34 обещание выполняет — через хостед-ffmpeg (§16.1).
 *
 * ## Почему обрезка, а не поля
 *
 * Промпт с этапа 20 просит модель держать товар, персонажей и надписи в
 * безопасной зоне центра — ровно для того, чтобы края можно было срезать.
 * Добавить чёрные поля было бы проще, но это другой ролик: в ленте он
 * читается как ошибка загрузки. Тот же выбор сделан в проекте-референсе,
 * откуда взят подход (fill + crop, не fit + pad).
 *
 * ## Почему без ffprobe
 *
 * Размеры кадра, который вернул Veo, на сервере неизвестны, а второй
 * проход ради их выяснения — лишний вызов и лишние деньги. FFmpeg умеет
 * считать это сам: `crop` принимает выражения от `iw`/`ih`, поэтому
 * «наибольший прямоугольник целевого формата, вписанный в исходный кадр»
 * описывается прямо в команде и работает для любого разрешения.
 *
 * Никакого увеличения при этом не происходит: мы только срезаем лишнее,
 * пиксели остаются исходными. Апскейл до «красивых» 1080p был бы обманом
 * — резкости он не добавляет, а вес файла и время рендера растит.
 */

import { ASPECT_RATIO_PATTERN, ratioValue } from './aspect-ratio';

/** Формат, который Veo отдаёт нативно, — обрезать нечего. */
export const NATIVE = ['16:9', '9:16'] as const;

export interface ReframePlan {
  /** Целевой формат как «W:H». */
  target: string;
  /** Он же числом (ширина / высота) — в выражении crop. */
  ratio: number;
  /** Имя выходного файла в задаче. */
  outputName: string;
  /** Полная команда ffmpeg с плейсхолдером входа. */
  command: string;
}

export class ReframeError extends Error {}

/**
 * Выражение обрезки. `min` берёт ту сторону, которая упирается в кадр
 * первой, `floor(x/2)*2` приводит к чётным размерам — libx264 с
 * `yuv420p` нечётные не принимает и падает уже в задаче, где отладка
 * стоит дороже. Центрирование у `crop` по умолчанию, задавать x/y не
 * нужно.
 */
export function cropExpression(ratio: number): string {
  const r = ratio.toFixed(6);
  return (
    `crop='floor(min(iw,ih*${r})/2)*2':'floor(min(ih,iw/${r})/2)*2'` +
    `:'(iw-out_w)/2':'(ih-out_h)/2'`
  );
}

export interface BatchReframeItem {
  /** Целевой формат как «W:H». */
  target: string;
  /** Имя выходного файла ВНУТРИ пакетной задачи — сопоставляет ответ с вариантом. */
  outputName: string;
  command: string;
}

/**
 * Несколько целевых форматов ОДНОЙ задачей ffmpeg (TODO §35, автоэкспорт
 * под площадки; `doc/MULTI-FORMAT-EXPORT-SPEC.md` §2.2/§3, ярус A, этап
 * 75). `FfmpegApiService.submit()` уже принимает `outputs`/`commands`
 * массивами — здесь просто собираются несколько независимых команд
 * `planReframe` под один вызов вместо одного вызова на формат.
 *
 * Формат, совпадающий с нативным Veo-кадром (резать нечего —
 * `planReframe` сам бросает `ReframeError`), и дубликаты во входном
 * списке молча пропускаются: разбор «какие форматы вообще имеет смысл
 * просить» — дело вызывающего (`PostProductionService.startExport`,
 * который к тому же знает исходный формат и семейство), эта функция
 * только собирает команды для того, что осталось.
 */
export function planBatchReframe(targets: string[]): BatchReframeItem[] {
  const seen = new Set<string>();
  const items: BatchReframeItem[] = [];
  for (const raw of targets) {
    const target = raw?.trim() ?? '';
    if (!target || seen.has(target)) continue;
    seen.add(target);
    try {
      const plan = planReframe({
        targetAspectRatio: target,
        outputName: `export-${target.replace(/[^0-9]+/g, 'x')}.mp4`,
      });
      items.push({
        target,
        outputName: plan.outputName,
        command: plan.command,
      });
    } catch (e) {
      if (e instanceof ReframeError) continue; // родной формат — нечего резать
      throw e;
    }
  }
  return items;
}

/**
 * Тот же расчёт на JS — им пользуются тесты и админка, чтобы показать,
 * что именно получится. Держать две реализации одного правила плохо,
 * но альтернатива — не проверять правило вовсе: выражение уезжает в
 * чужой сервис и обратно приходит только видео.
 */
export function cropBox(
  sourceWidth: number,
  sourceHeight: number,
  ratio: number,
): { width: number; height: number } {
  const even = (v: number) => Math.floor(v / 2) * 2;
  return {
    width: even(Math.min(sourceWidth, sourceHeight * ratio)),
    height: even(Math.min(sourceHeight, sourceWidth / ratio)),
  };
}

/**
 * Команда для одной задачи. `inputKey` — плейсхолдер `{{...}}`, который
 * хостед-сервис заменит на скачанный файл (см. `ReframeService`).
 *
 * Пересжатие обязательно: обрезка меняет геометрию, поэтому поток всё
 * равно перекодируется. `-c:a copy` оставляет звук как есть — Veo уже
 * отдал его в AAC, и второе сжатие только ухудшило бы его. `+faststart`
 * двигает индекс в начало файла: без него ролик в браузере начинает
 * играть только после полной загрузки.
 */
export function planReframe(opts: {
  targetAspectRatio: string;
  inputKey?: string;
  outputName?: string;
  /** CRF: меньше — лучше и тяжелее. 18 — визуально без потерь. */
  crf?: number;
}): ReframePlan {
  const target = opts.targetAspectRatio?.trim() ?? '';
  if (!ASPECT_RATIO_PATTERN.test(target)) {
    throw new ReframeError(`Неверный формат кадра: «${target}», нужен W:H`);
  }
  if ((NATIVE as readonly string[]).includes(target)) {
    throw new ReframeError(
      `${target} Veo рендерит нативно — обрезать нечего, задача не нужна`,
    );
  }
  const ratio = ratioValue(target);
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    throw new ReframeError(`Не удалось прочитать формат кадра: «${target}»`);
  }

  const inputKey = opts.inputKey ?? 'source';
  const outputName = opts.outputName ?? 'reframed.mp4';
  const crf = opts.crf ?? 18;

  const command =
    `-i {{${inputKey}}} ` +
    `-vf "${cropExpression(ratio)},setsar=1" ` +
    `-c:v libx264 -preset veryfast -crf ${crf} -pix_fmt yuv420p ` +
    `-c:a copy -movflags +faststart {{${outputName}}}`;

  return { target, ratio, outputName, command };
}
