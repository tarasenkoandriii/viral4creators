/**
 * Постобработка ролика одной командой ffmpeg (ТЗ §15.4/§16.1, этап 35).
 *
 * ## Почему один проход, а не два
 *
 * С этапа 34 обрезка кадра уже уходит в хостед-ffmpeg. Озвучка — вторая
 * операция над тем же файлом, и напрашивается сделать её второй задачей.
 * Это было бы ошибкой сразу по трём причинам:
 *
 *  - **два счёта вместо одного**: каждая задача это скачивание, рендер и
 *    выгрузка, оплачиваемые отдельно;
 *  - **два перекодирования вместо одного**: видео сжимается дважды, и
 *    второй проход честно теряет качество;
 *  - **гонка за порядок**: две независимые задачи над одним файлом
 *    финишируют когда придётся, и «озвучка легла на необрезанный ролик»
 *    — это не редкий сбой, а обычный исход при неудачном таймингe.
 *
 * Поэтому здесь собирается ОДНА команда, которая делает всё, что нужно
 * этому конкретному ролику: только обрезку, только звук, или и то и
 * другое. Что именно — решает вызывающий, передав или не передав
 * параметры.
 *
 * ## Что делает фильтр со звуком
 *
 * `adelay` сдвигает голос к нужной секунде (реплики почти никогда не
 * начинаются с нулевого кадра), `volume` приглушает исходную дорожку до
 * фона — не выключает: атмосфера и музыка Veo это половина достоверности
 * ролика, и убрать их значит получить говорящую картинку. `amix`
 * складывает дорожки с `duration=first`, чтобы длина ролика осталась
 * прежней даже если голос длиннее, а `normalize=0` не даёт amix'у самому
 * поделить громкость пополам (его умолчание — именно это, и без флага
 * микс звучит вдвое тише исходника). `loudnorm` в конце приводит результат
 * к вещательной громкости: без него ролик в ленте тише соседних.
 *
 * ## Чего здесь сознательно нет
 *
 * Подгонки длины речи под длину ролика (`atempo`). Ускорить речь на
 * 20 %, чтобы она «влезла», технически просто, но звучит как испорченная
 * запись. Правильное место для этой проблемы — текст: он пишется под
 * восемь секунд и правится пользователем до синтеза.
 *
 * ## Субтитры (этап 67) — третий ингредиент того же прохода
 *
 * Жёстко вшитые субтитры добавлены сюда же, третьей необязательной
 * операцией, по тем же трём причинам, что объединили кроп и голос:
 * отдельная задача — это второй счёт, второе перекодирование и риск
 * лечь на необрезанный кадр. Фильтр `subtitles={{ключ}}:force_style=...`
 * читает `.srt`-файл, скачанный хостед-сервисом ПО ТОМУ ЖЕ протоколу
 * подстановки `{{ключ}}`, что источник и голос, — но это не поток:
 * отдельный `-i {{ключ}}` для него не нужен, только запись внутри
 * фильтра. Стиль передаётся целиком строкой `force_style`
 * (`common/subtitles.ts`), поэтому `.ass` со своей секцией стилей не
 * нужен — обычный `.srt` плюс эта строка дают тот же результат.
 *
 * Субтитры, как и кроп, требуют перекодирования видео — `subtitles` это
 * фильтр, а не пробрасываемый поток, и `-c:v copy` для него не работает.
 */

import { cropExpression } from './reframe';
import { ASPECT_RATIO_PATTERN, ratioValue } from './aspect-ratio';
import { NATIVE } from './reframe';

export class PostProdError extends Error {}

export interface PostProdPlan {
  /** Имя выходного файла в задаче. */
  outputName: string;
  /** Команда ffmpeg с плейсхолдерами `{{ключ}}`. */
  command: string;
  /** Ключи входных файлов в том порядке, в каком они идут в команде. */
  inputKeys: string[];
  /** Обрезка: целевой формат и его число, либо null — кадр не трогаем. */
  crop: { target: string; ratio: number } | null;
  /** Звук: как именно легла дорожка, либо null — звук не трогаем. */
  audio: { mode: 'voiceover' | 'dub'; delayMs: number } | null;
  /** Субтитры вшиты в эту задачу или нет — для лога вызывающего. */
  subtitles: boolean;
}

export interface PostProdOptions {
  /** Целевой формат кадра; пусто или родной — обрезка не нужна. */
  targetAspectRatio?: string | null;
  /**
   * Ключ входного аудиофайла. Пусто — звук ролика остаётся как есть и
   * даже не пересжимается.
   */
  voiceInputKey?: string | null;
  /**
   * `voiceover` — голос поверх приглушённого звука Veo;
   * `dub` — голос вместо звука Veo.
   */
  voiceMode?: 'voiceover' | 'dub';
  /** Сдвиг голоса от начала ролика, мс. */
  voiceDelayMs?: number;
  /** Во сколько раз приглушить исходную дорожку в режиме `voiceover`. */
  duck?: number;
  /** CRF: меньше — лучше и тяжелее. 18 — визуально без потерь. */
  crf?: number;
  /**
   * Ключ `.srt`-файла субтитров (этап 67). Пусто — субтитры не
   * накладываются. Не поток: файл читается фильтром `subtitles=`
   * напрямую, отдельного `-i` для него нет.
   */
  subtitlesInputKey?: string | null;
  /** Строка `force_style` темы субтитров (`common/subtitles.ts`). Значима только вместе с `subtitlesInputKey`. */
  subtitleForceStyle?: string | null;
  inputKey?: string;
  outputName?: string;
}

/** Приглушение исходной дорожки по умолчанию: слышно, но не мешает речи.
 *
 * Найдено при аудите озвучки (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §8.5
 * п.4, этап 3 плана §14): решение понизить это значение до 0.12–0.15
 * было явно принято в ТЗ («дешёвая правка одной константы» — вариант
 * (i) против двоения голоса в режиме `voiceover`), но код так и
 * оставался на прежних 0.25 — сама правка не была применена. Влияет
 * только на `voiceover` (см. `planPostProduction` ниже — `duck`
 * используется только там: `dub` не подмешивает исходную дорожку
 * вовсе, `veo` не вызывает этот путь, потому что для него нет
 * отдельного `voiceInputKey`). Более точный (ii) — фильтр подавления
 * голосовых частот перед `amix` — остаётся нерешённым отдельным
 * заходом, как и было решено в ТЗ.
 */
export const DEFAULT_DUCK = 0.15;

/**
 * Разбор целевого формата: null означает «обрезать нечего», а не ошибку —
 * родной формат это нормальный, самый частый случай.
 */
function resolveCrop(
  target: string | null | undefined,
): { target: string; ratio: number } | null {
  const value = target?.trim() ?? '';
  if (!value) return null;
  if ((NATIVE as readonly string[]).includes(value)) return null;
  if (!ASPECT_RATIO_PATTERN.test(value)) {
    throw new PostProdError(`Неверный формат кадра: «${value}», нужен W:H`);
  }
  const ratio = ratioValue(value);
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    throw new PostProdError(`Не удалось прочитать формат кадра: «${value}»`);
  }
  return { target: value, ratio };
}

export function planPostProduction(opts: PostProdOptions): PostProdPlan {
  const crop = resolveCrop(opts.targetAspectRatio);
  const voiceKey = opts.voiceInputKey?.trim() || null;
  const mode = opts.voiceMode ?? 'voiceover';
  const delayMs = Math.max(0, Math.round(opts.voiceDelayMs ?? 0));
  const duck = opts.duck ?? DEFAULT_DUCK;
  const crf = opts.crf ?? 18;
  const inputKey = opts.inputKey ?? 'source';
  const outputName = opts.outputName ?? 'final.mp4';
  const subtitlesKey = opts.subtitlesInputKey?.trim() || null;
  const subtitleForceStyle = opts.subtitleForceStyle?.trim() || '';

  if (!crop && !voiceKey && !subtitlesKey) {
    // Отправлять такую задачу значит заплатить за перекодирование ради
    // того же файла.
    throw new PostProdError(
      'ни обрезка, ни озвучка, ни субтитры не нужны — задача не создаётся',
    );
  }

  const inputKeys = voiceKey ? [inputKey, voiceKey] : [inputKey];
  const parts: string[] = inputKeys.map((k) => `-i {{${k}}}`);

  // Субтитры — фильтр над видеопотоком, не отдельный `-i`: хостед-сервис
  // подставляет `{{ключ}}` ВЕЗДЕ в строке команды, а не только после
  // `-i` (`ffmpeg-api.service.ts`), и `subtitles=` читает файл по пути,
  // а не по номеру потока.
  const subtitlesFilterSuffix = subtitlesKey
    ? `,subtitles={{${subtitlesKey}}}:force_style='${subtitleForceStyle}'`
    : '';
  const needsVideoFilter = !!crop || !!subtitlesKey;

  const filters: string[] = [];
  if (crop) {
    filters.push(
      `[0:v]${cropExpression(crop.ratio)},setsar=1${subtitlesFilterSuffix}[v]`,
    );
  } else if (subtitlesKey) {
    // Кадр не трогаем, но субтитры всё равно требуют перекодирования —
    // фильтр применяется прямо к исходному потоку.
    filters.push(
      `[0:v]subtitles={{${subtitlesKey}}}:force_style='${subtitleForceStyle}'[v]`,
    );
  }
  if (voiceKey) {
    // `all=1` обязателен: без него adelay сдвигает только первый канал, и
    // стереоголос разъезжается по времени между левым и правым.
    const voice =
      delayMs > 0 ? `[1:a]adelay=${delayMs}:all=1[vo]` : `[1:a]anull[vo]`;
    filters.push(voice);
    if (mode === 'dub') {
      // Дубляж: звук Veo не участвует вовсе — исходная дорожка не
      // приглушается, а заменяется.
      filters.push(`[vo]loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
    } else {
      filters.push(`[0:a]volume=${duck}[bg]`);
      filters.push(
        `[bg][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
          `loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
      );
    }
  }

  if (filters.length) {
    parts.push(`-filter_complex "${filters.join(';')}"`);
  }

  // Маппинг явный: с filter_complex ffmpeg перестаёт выбирать потоки сам,
  // и молчаливо потерянная дорожка — самый частый способ получить ролик
  // без звука.
  parts.push(needsVideoFilter ? '-map "[v]"' : `-map 0:v`);
  parts.push(voiceKey ? '-map "[a]"' : `-map 0:a?`);

  if (needsVideoFilter) {
    // Кроп ИЛИ субтитры — оба требуют перекодирования: субтитры такой
    // же фильтр над потоком, как и кроп, `-c:v copy` для них не работает.
    parts.push(`-c:v libx264 -preset veryfast -crf ${crf} -pix_fmt yuv420p`);
  } else {
    // Ни кропа, ни субтитров — видео копируется потоком. Это не
    // микрооптимизация: перекодировать ради одной звуковой дорожки
    // значит потерять качество на ровном месте и заплатить за рендер.
    parts.push('-c:v copy');
  }
  parts.push(voiceKey ? '-c:a aac -b:a 192k' : '-c:a copy');
  parts.push(`-movflags +faststart {{${outputName}}}`);

  return {
    outputName,
    command: parts.join(' '),
    inputKeys,
    crop,
    audio: voiceKey ? { mode, delayMs } : null,
    subtitles: !!subtitlesKey,
  };
}
