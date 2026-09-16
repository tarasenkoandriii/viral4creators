/**
 * tutorial-video-assembly.ts — собирает кадры сценария (`scenario-
 * runner.ts`'s `captureFrames`, этап 98) в один ролик-слайд-шоу через
 * уже существующий внешний ffmpeg-api (`postprod/ffmpeg-api.service.ts`,
 * этап 34) — тот же провайдер, что уже кроит кадр и переозвучивает
 * готовые рекламные ролики, не вторая инфраструктура (доккомментарий
 * `scenario-runner.ts` объясняет, почему локальный ffmpeg на Vercel не
 * вариант).
 *
 * Чистая функция: собирает `{inputs, outputs, commands}` — тот же
 * контракт, что уже принимает `FfmpegApiService.submit()`
 * (`common/reframe.ts`'s `planBatchReframe` — тот же приём для другой
 * задачи). Сеть/Blob/БД — на совести вызывающего кода
 * (`tutorial-scenario-runner.service.ts`), здесь только строится команда.
 *
 * ## Почему слайд-шоу, а не что-то умнее
 *
 * `-loop 1 -t N -i {{key}}` держит каждый кадр статичным N секунд, затем
 * `concat`-фильтр склеивает все кадры в один поток — простейший вид
 * видео, какой вообще можно собрать из отдельных JPEG без реального
 * скринкаста. Никакой плавности/курсора/переходов — честно объявлено как
 * ограничение (см. `scenario-runner.ts`), не скрыто за словом «видео».
 *
 * `scale=trunc(iw/2)*2:trunc(ih/2)*2` на каждом кадре — та же защита от
 * нечётных размеров, что уже применяет `cropExpression()` в
 * `common/reframe.ts`: `libx264`/`yuv420p` не принимают нечётную сторону
 * кадра, а скриншоты puppeteer из viewport произвольного размера вполне
 * могут её дать.
 */

/** Сколько секунд держим один кадр в кадре — достаточно, чтобы успеть
 * прочитать экран, не настолько долго, чтобы 10-шаговый сценарий
 * превращался в получасовой ролик. */
export const SECONDS_PER_FRAME = 2;

/** Потолок числа кадров одного сценария — совпадает с `MAX_SCENARIO_
 * STEPS` (`scenario-steps.ts`, этап 94: до 30 шагов) плюс небольшой
 * запас; чисто оборонительная защита ffmpeg-команды от неограниченного
 * роста `-filter_complex`, не ожидается достигаться на практике. */
export const MAX_SLIDESHOW_FRAMES = 40;

export interface SlideshowPlan {
  inputs: Record<string, string>;
  outputs: string[];
  commands: string[];
  /** Имя единственного выходного файла — то же значение, что
   * `outputs[0]`, отдельным полем ради читаемости на стороне вызывающего
   * кода (не нужно доставать из массива по индексу). */
  outputName: string;
}

/**
 * `frameUrls` — публичные Blob-ссылки на уже загруженные JPEG-кадры, по
 * порядку съёмки. `null`, если собирать нечего (0 кадров) или кадров
 * больше потолка (`MAX_SLIDESHOW_FRAMES`) — оба случая вызывающий код
 * обязан обработать сам, не вызывая `submit()` с бессмысленной/опасно
 * большой командой.
 */
export function planSlideshow(
  frameUrls: string[],
  outputName = 'tutorial.mp4',
): SlideshowPlan | null {
  if (frameUrls.length === 0 || frameUrls.length > MAX_SLIDESHOW_FRAMES) {
    return null;
  }

  const inputs: Record<string, string> = {};
  const inputArgs: string[] = [];
  const scaleFilters: string[] = [];

  frameUrls.forEach((url, i) => {
    const key = `frame${i}`;
    inputs[key] = url;
    inputArgs.push(`-loop 1 -t ${SECONDS_PER_FRAME} -i {{${key}}}`);
    scaleFilters.push(
      `[${i}:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[v${i}]`,
    );
  });

  const concatInputs = frameUrls.map((_, i) => `[v${i}]`).join('');
  const filter = `${scaleFilters.join(';')};${concatInputs}concat=n=${
    frameUrls.length
  }:v=1:a=0[outv]`;

  const command =
    `${inputArgs.join(' ')} -filter_complex "${filter}" -map "[outv]" ` +
    `-r 30 -pix_fmt yuv420p ${outputName}`;

  return { inputs, outputs: [outputName], commands: [command], outputName };
}
