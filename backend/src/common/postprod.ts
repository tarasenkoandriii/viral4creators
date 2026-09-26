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
import { DEFAULT_MUSIC_VOLUME } from './greeting-music';

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
  audio: {
    mode: 'voiceover' | 'dub';
    delayMs: number;
    /**
     * Сколько фоновых стемов подмешано вместо исходной дорожки
     * (docs-tz/TZ-Voice-Replace-Keep-Background.md). Ноль — обычное
     * поведение: `voiceover` подмешивает `[0:a]`, `dub` не подмешивает
     * ничего. Больше нуля — дубляж, сохранивший фон ролика.
     *
     * Отдельное поле, а не третье значение `mode`: для всех, кто
     * читает `mode` (записи в БД, логи, тесты), это по-прежнему
     * дубляж, и переименование сломало бы их без пользы.
     */
    backgroundStems: number;
  } | null;
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
  /**
   * У исходного ролика НЕТ звуковой дорожки — так приходят ролики,
   * заказанные у Grok с `generate_audio: false`
   * (`GeneratedVideo.silentSource`).
   *
   * Тогда подмешивать нечего, и `voiceover` физически невозможен:
   * `[0:a]` в фильтре ссылается на несуществующий поток, и ffmpeg
   * падает («Stream specifier matches no streams»), а не пропускает
   * фильтр молча. Команда в этом случае собирается ровно так же, как
   * для `dub`.
   *
   * Это НЕ выдача платного дубляжа мимо тарифа: дубляж — это «заменить
   * звук модели своим», а здесь звука модели не существует, и
   * слышимый результат тот же самый при любом значении `voiceMode`.
   */
  sourceHasNoAudio?: boolean;
  /**
   * Ключи входов с ФОНОМ ролика — тем, что осталось от исходной
   * дорожки после удаления из неё голоса модели
   * (docs-tz/TZ-Voice-Replace-Keep-Background.md).
   *
   * Смысл всей затеи: пользователь в режиме «дубляж» просит заменить
   * ГОЛОС, а не звук. До этого `dub` выбрасывал дорожку целиком, и
   * вместе с голосом модели уходили шум улицы, музыка и всё остальное
   * — оставалась речь на тишине.
   *
   * Обычно ключ один (двухстемное разделение), но их может быть
   * несколько, если модель отдала стемы по отдельности — тогда они
   * складываются. Список, а не строка, именно поэтому.
   *
   * **Только вместе с `dub`.** В `voiceover` исходная дорожка и так
   * подмешивается целиком, приглушённой, и подменять её стемами там
   * незачем; сочетание отвергается, а не исправляется молча.
   */
  backgroundInputKeys?: readonly string[];
  /**
   * Ключ входного аудиофайла музыкальной подложки (фича №4). Пусто —
   * подложки нет, всё как раньше.
   */
  musicInputKey?: string | null;
  /** Громкость подложки; по умолчанию `DEFAULT_MUSIC_VOLUME`. */
  musicVolume?: number;
  /**
   * Длина ролика в секундах — подложка приводится РОВНО к ней
   * (`atrim` + `apad`).
   *
   * Зачем: трек не обязан совпадать с роликом по длине. Длинный,
   * обрезанный микшером «по самому короткому», оборвал бы звук на
   * полуслове ещё до конца картинки; короткий, наоборот, заставил бы
   * микшер тянуть общую длину за собой. Приведённая к точной длине
   * подложка делает первый вход микшера эталоном длительности — на
   * этом держится `duration=first` ниже.
   */
  totalDurationSeconds?: number;
  /**
   * Ключ входного `.ass`-файла с карточками — титульной и закрывающей
   * (фичи №38/№39). Пусто — карточек нет.
   *
   * Отдельным файлом, а не вторым набором реплик в субтитрах: у
   * карточек своя вёрстка и свой стиль, а субтитры живут по теме
   * бренда и могут быть выключены вовсе. Фильтр тот же `subtitles=`,
   * что и у субтитров, и это не совпадение — libass в этом конвейере
   * уже работает и уже умеет кириллицу, а `drawtext` потребовал бы
   * своего шрифта на стороне ffmpeg-сервиса, о котором мы ничего не
   * знаем.
   */
  cardsInputKey?: string | null;
  /**
   * Наклейка поверх кадра (фича №8): ключ входного PNG плюс уже
   * посчитанная геометрия (`common/sticker-overlay.ts`).
   *
   * Это ВТОРОЙ видеовход задачи — в отличие от субтитров и карточек,
   * которые фильтр читает файлом. Отсюда и порядок входов ниже:
   * наклейка встаёт последней, чтобы номера звуковых потоков не
   * поехали.
   */
  stickerInputKey?: string | null;
  stickerScale?: string | null;
  stickerX?: string | null;
  stickerY?: string | null;
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

/**
 * Участвует ли в миксе дорожка самого ролика.
 *
 * `dub` заменяет её целиком; немой исходник приходит сюда уже как
 * `dub` (см. `sourceHasNoAudio`). Отдельная функция, а не `mode !==
 * 'dub'` по месту: теперь этот вопрос задаётся из трёх мест.
 */
function usesSourceAudio(mode: 'voiceover' | 'dub'): boolean {
  return mode !== 'dub';
}

/**
 * Слагаемые звука одной сборки — общий рецепт (этап 138).
 *
 * Вынесено из `planPostProduction` целиком и без изменений, потому что
 * альтернативная звуковая дорожка на другом языке (ТЗ
 * TZ-Multilingual-YouTube.md §5) обязана собираться ТЕМ ЖЕ рецептом с
 * подменой ровно одного входа — файла голоса. Собери её отдельно «из
 * музыки и голоса», и зритель на немецком получил бы заметно более
 * пустой звук, чем зритель на украинском: в миксе `voiceover` есть ещё
 * и приглушённая дорожка самого ролика — атмосфера, шумы, музыка Veo.
 * Заметить это было бы некому до жалоб.
 *
 * Поэтому громкости, приведение подложки к длине ролика, `duration=first`
 * и `loudnorm` живут здесь в одном экземпляре, а не в двух местах,
 * которые однажды разойдутся.
 *
 * Возвращает строки фильтра, последняя из которых заканчивается на
 * `[a]` — готовый звук.
 */
export function audioMixFilters(input: {
  /**
   * Фон ролика и во сколько его приглушить.
   *
   * Без `stemIndexes` — дорожка самого ролика, `[0:a]`, как было
   * всегда. С ними — отдельные входы со стемами: из исходной дорожки
   * убран голос модели, и подмешивается только то, что осталось
   * (docs-tz/TZ-Voice-Replace-Keep-Background.md).
   */
  source: { duck: number; stemIndexes?: readonly number[] } | null;
  /** Голос: номер входа, сдвиг и, для дорожек, подгонка темпа. */
  voice: { index: number; delayMs: number; tempoRate?: number | null } | null;
  music: { index: number; volume: number } | null;
  totalSeconds?: number;
  /**
   * Дотянуть готовый звук тишиной до этой длины (этап 138). Нужно
   * только альтернативным дорожкам: YouTube ждёт файл примерно той же
   * длины, что ролик, а у немого исходника без подложки эталона длины
   * в миксе нет вовсе — им становится сам голос. Обычная сборка это не
   * передаёт: там длину держит видеопоток.
   */
  padToSeconds?: number;
}): string[] {
  const filters: string[] = [];
  // Слагаемые звука в порядке, в котором они уйдут в `amix`. Первым
  // обязан стоять вход ТОЧНО той же длины, что ролик: на нём держится
  // `duration=first`, то есть обещание «длина ролика не изменится».
  const mixed: string[] = [];
  const totalSeconds = input.totalSeconds;

  if (input.music) {
    // `atrim` режет длинный трек, `apad` дотягивает короткий тишиной
    // — вместе они дают подложку ровно в длину ролика. Без известной
    // длины (старый вызывающий) оставляем трек как есть: тогда
    // эталоном длины будет исходная дорожка или голос, как и раньше.
    const fit = totalSeconds
      ? `atrim=0:${totalSeconds},apad=whole_dur=${totalSeconds},`
      : '';
    filters.push(
      `[${input.music.index}:a]${fit}volume=${input.music.volume}[mus]`,
    );
  }

  if (!input.source) {
    // Дубляж или немой исходник: дорожки ролика в миксе нет вовсе.
    // Тогда эталон длины — приведённая подложка, если она есть.
    if (input.music && totalSeconds) mixed.push('[mus]');
  } else {
    const stems = input.source.stemIndexes ?? [];
    if (stems.length > 0) {
      // Фон собран из стемов: голоса модели в нём уже нет, поэтому
      // приглушать его нечем и незачем — `duck` сюда приходит равным
      // единице (см. `planPostProduction`). Проверено прототипом на
      // настоящем ролике: фон вернулся на полной громкости, остатков
      // речи не слышно; приглушать его значило бы маскировать то,
      // чего нет, и заодно терять смысл всей работы.
      //
      // Найдено аудитом этапа C: стем приезжает от стороннего
      // провайдера перекодированным, и его длина НЕ обязана совпадать
      // с длиной ролика до миллисекунды — у mp3 одно только
      // выравнивание кадров добавляет десятки миллисекунд. А `[bg]`
      // стоит в `amix` первым, то есть по нему считается `duration=
      // first`: чуть более длинный стем удлинил бы весь ролик. Раньше
      // этой опасности не было — фоном была `[0:a]`, дорожка самого
      // файла. Поэтому стем приводится к длине ролика тем же приёмом,
      // что и музыкальная подложка выше: `atrim` режет длинный,
      // `apad` дотягивает короткий.
      const fit = totalSeconds
        ? `atrim=0:${totalSeconds},apad=whole_dur=${totalSeconds},`
        : '';
      const gain = `volume=${input.source.duck}[bg]`;
      if (stems.length === 1) {
        filters.push(`[${stems[0]}:a]${fit}${gain}`);
      } else {
        // Несколько стемов: каждый приводим к длине отдельно, иначе
        // самый длинный из них задал бы длину их собственного микса.
        const labels = stems.map((i, n) => {
          // `fit` заканчивается запятой — она нужна перед следующим
          // фильтром, а здесь следующего нет; без приведения длины
          // ставим `anull`, потому что метку потоку дать надо.
          filters.push(`[${i}:a]${fit ? fit.slice(0, -1) : 'anull'}[st${n}]`);
          return `[st${n}]`;
        });
        filters.push(
          `${labels.join('')}amix=inputs=${stems.length}:duration=first:` +
            `dropout_transition=0:normalize=0,${gain}`,
        );
      }
    } else {
      // Приглушаем исходную дорожку только под НАШ голос: это и есть
      // смысл `duck`. Под одной лишь подложкой глушить нечего — там
      // тише становится сама подложка, а не ролик, иначе музыка
      // «съедала» бы звук, ради которого её и добавляют.
      filters.push(`[0:a]volume=${input.source.duck}[bg]`);
    }
    mixed.push('[bg]');
  }

  if (input.voice) {
    // `all=1` обязателен: без него adelay сдвигает только первый канал, и
    // стереоголос разъезжается по времени между левым и правым.
    //
    // `atempo` (этап 138) стоит ДО сдвига: ускоряется сама речь, а не
    // момент её начала — иначе реплика уехала бы ещё и по времени.
    // В обычной сборке его не бывает: там длина текста правится до
    // синтеза, и это записано отдельным решением в шапке файла.
    const tempo = input.voice.tempoRate;
    const steps = [
      ...(tempo && tempo !== 1 ? [`atempo=${tempo}`] : []),
      ...(input.voice.delayMs > 0
        ? [`adelay=${input.voice.delayMs}:all=1`]
        : []),
    ];
    filters.push(
      `[${input.voice.index}:a]${steps.length ? steps.join(',') : 'anull'}[vo]`,
    );
    mixed.push('[vo]');
  }

  // Подложка, если она ещё не встала первой.
  if (input.music && !mixed.includes('[mus]')) mixed.push('[mus]');

  const pad = input.padToSeconds ? `,apad=whole_dur=${input.padToSeconds}` : '';
  const normalize = `loudnorm=I=-16:TP=-1.5:LRA=11${pad}[a]`;
  if (mixed.length === 1) {
    // Микшировать нечего — один источник просто выравнивается по
    // громкости. Тот же случай, что дубляж без подложки до этой фичи.
    filters.push(`${mixed[0]}${normalize}`);
  } else {
    filters.push(
      `${mixed.join('')}amix=inputs=${mixed.length}:duration=first:` +
        `dropout_transition=0:normalize=0,${normalize}`,
    );
  }
  return filters;
}

export function planPostProduction(opts: PostProdOptions): PostProdPlan {
  const crop = resolveCrop(opts.targetAspectRatio);
  const voiceKey = opts.voiceInputKey?.trim() || null;
  const musicKey = opts.musicInputKey?.trim() || null;
  const mode = opts.sourceHasNoAudio ? 'dub' : (opts.voiceMode ?? 'voiceover');
  const delayMs = Math.max(0, Math.round(opts.voiceDelayMs ?? 0));
  const duck = opts.duck ?? DEFAULT_DUCK;
  const crf = opts.crf ?? 18;
  const inputKey = opts.inputKey ?? 'source';
  const outputName = opts.outputName ?? 'final.mp4';
  const subtitlesKey = opts.subtitlesInputKey?.trim() || null;
  const subtitleForceStyle = opts.subtitleForceStyle?.trim() || '';
  const cardsKey = opts.cardsInputKey?.trim() || null;
  const stickerKey = opts.stickerInputKey?.trim() || null;
  const backgroundKeys = (opts.backgroundInputKeys ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (backgroundKeys.length > 0 && !voiceKey) {
    // Найдено аудитом этапа C. Без своего голоса звуковой фильтр не
    // строится вовсе (см. `if (voiceKey || musicKey)` ниже), стемы
    // скачались бы впустую, а `-map 0:a?` скопировал бы ИСХОДНУЮ
    // дорожку — ту самую, с голосом модели. То есть заказ «замени
    // голос» дал бы ролик с нетронутым голосом и лишним счётом.
    throw new PostProdError(
      'фоновые стемы бессмысленны без своего голоса: заменять нечем',
    );
  }
  if (backgroundKeys.length > 0 && mode !== 'dub') {
    // Молча проигнорировать было бы хуже всего: вызывающий думал бы,
    // что фон сохранён, а на деле получил бы прежний приглушённый
    // `[0:a]` с голосом модели внутри.
    throw new PostProdError(
      'фоновые стемы допустимы только в режиме dub: в voiceover исходная дорожка подмешивается целиком',
    );
  }

  if (
    !crop &&
    !voiceKey &&
    !subtitlesKey &&
    !musicKey &&
    !cardsKey &&
    !stickerKey
  ) {
    // Отправлять такую задачу значит заплатить за перекодирование ради
    // того же файла.
    throw new PostProdError(
      'ни обрезка, ни озвучка, ни субтитры не нужны — задача не создаётся',
    );
  }

  // Порядок входов задаёт номера потоков в фильтре, поэтому считаем
  // их здесь один раз, а не пишем `[1:a]`/`[2:a]` руками: с
  // появлением подложки «второй вход» перестал означать «голос».
  const inputKeys = [
    inputKey,
    ...(voiceKey ? [voiceKey] : []),
    ...(musicKey ? [musicKey] : []),
    // Стемы после музыки и перед наклейкой: так номера голоса и
    // подложки не сдвигаются, а наклейка по-прежнему считается от
    // конца списка.
    ...backgroundKeys,
    ...(stickerKey ? [stickerKey] : []),
  ];
  const voiceIndex = voiceKey ? 1 : -1;
  const musicIndex = musicKey ? (voiceKey ? 2 : 1) : -1;
  const firstBackgroundIndex = 1 + (voiceKey ? 1 : 0) + (musicKey ? 1 : 0);
  const backgroundIndexes = backgroundKeys.map(
    (_, i) => firstBackgroundIndex + i,
  );
  // Наклейка последняя намеренно: её появление не должно сдвигать
  // номера звуковых потоков, иначе голос внезапно окажется музыкой.
  const stickerIndex = stickerKey ? inputKeys.length - 1 : -1;
  const musicVolume = opts.musicVolume ?? DEFAULT_MUSIC_VOLUME;
  const totalSeconds = opts.totalDurationSeconds;
  const parts: string[] = inputKeys.map((k) => `-i {{${k}}}`);

  // Субтитры — фильтр над видеопотоком, не отдельный `-i`: хостед-сервис
  // подставляет `{{ключ}}` ВЕЗДЕ в строке команды, а не только после
  // `-i` (`ffmpeg-api.service.ts`), и `subtitles=` читает файл по пути,
  // а не по номеру потока.
  //
  // Шаги накладываются по порядку: сначала кадр, потом субтитры, потом
  // карточки. Карточки последними намеренно — они рисуются поверх
  // всего, в том числе поверх субтитров, если те попали в те же
  // секунды: карточка это отдельный кадр повествования, а не подпись.
  const videoSteps: string[] = [];
  if (crop) videoSteps.push(`${cropExpression(crop.ratio)},setsar=1`);
  if (subtitlesKey) {
    videoSteps.push(
      `subtitles={{${subtitlesKey}}}:force_style='${subtitleForceStyle}'`,
    );
  }
  // Свой `force_style` карточкам не нужен: стили лежат внутри
  // `.ass`-файла, там же, где и текст (см. `common/greeting-cards.ts`).
  if (cardsKey) videoSteps.push(`subtitles={{${cardsKey}}}`);
  const needsVideoFilter = videoSteps.length > 0 || !!stickerKey;

  const filters: string[] = [];
  if (stickerKey) {
    // Наклейка — отдельный поток, а не шаг цепочки: `overlay` берёт два
    // входа. Поэтому сначала доводим кадр до `[vbase]`, потом кладём
    // поверх.
    const base = videoSteps.length ? '[vbase]' : '[0:v]';
    if (videoSteps.length) {
      filters.push(`[0:v]${videoSteps.join(',')}[vbase]`);
    }
    filters.push(
      `[${stickerIndex}:v]${opts.stickerScale?.trim() || 'null'}[stk]`,
    );
    filters.push(
      `${base}[stk]overlay=${opts.stickerX?.trim() || '0'}:${
        opts.stickerY?.trim() || '0'
      }[v]`,
    );
  } else if (videoSteps.length) {
    filters.push(`[0:v]${videoSteps.join(',')}[v]`);
  }
  if (voiceKey || musicKey) {
    filters.push(
      ...audioMixFilters({
        source: backgroundIndexes.length
          ? // Фон из стемов: голоса модели в нём нет, приглушать
            // нечего — отсюда единица, а не `duck`.
            { duck: 1, stemIndexes: backgroundIndexes }
          : usesSourceAudio(mode)
            ? { duck: voiceKey ? duck : 1 }
            : null,
        voice: voiceKey ? { index: voiceIndex, delayMs } : null,
        music: musicKey ? { index: musicIndex, volume: musicVolume } : null,
        totalSeconds,
      }),
    );
  }

  if (filters.length) {
    parts.push(`-filter_complex "${filters.join(';')}"`);
  }

  // Маппинг явный: с filter_complex ffmpeg перестаёт выбирать потоки сам,
  // и молчаливо потерянная дорожка — самый частый способ получить ролик
  // без звука.
  parts.push(needsVideoFilter ? '-map "[v]"' : `-map 0:v`);
  parts.push(voiceKey || musicKey ? '-map "[a]"' : `-map 0:a?`);

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
  // Звук перекодируется, как только к нему применён фильтр — и голос,
  // и подложка одинаково это делают. `-c:a copy` рядом с
  // `filter_complex`, который строит `[a]`, — не оптимизация, а
  // противоречие: ffmpeg такую команду не выполнит.
  parts.push(voiceKey || musicKey ? '-c:a aac -b:a 192k' : '-c:a copy');
  parts.push(`-movflags +faststart {{${outputName}}}`);

  return {
    outputName,
    command: parts.join(' '),
    inputKeys,
    crop,
    audio: voiceKey
      ? { mode, delayMs, backgroundStems: backgroundIndexes.length }
      : null,
    subtitles: !!subtitlesKey,
  };
}

/**
 * Задача ffmpeg на АЛЬТЕРНАТИВНУЮ ЗВУКОВУЮ ДОРОЖКУ (этап 138, ТЗ
 * TZ-Multilingual-YouTube.md §5) — тот же рецепт звука, что у
 * оригинальной сборки (`audioMixFilters`), с подменой ровно одного
 * входа: файла голоса.
 *
 * Отличий от обычной сборки ровно три, и все три вынужденные:
 *
 * 1. **На выходе только звук** (`-vn`): YouTube принимает дорожку
 *    отдельным аудиофайлом, а не вторым видео. Значит и видеопоток
 *    перекодировать не надо — это самая дорогая часть обычной задачи,
 *    и здесь её нет вовсе.
 * 2. **`atempo`**, если без него речь не влезает
 *    (`common/audio-track-fit.ts`). Применяется ЗДЕСЬ, а не отдельным
 *    проходом: сборка и так задача ffmpeg, и ускорение в ней — ещё один
 *    фильтр в том же вызове, а не второй счёт.
 * 3. **Длина гарантируется явно** — `apad` дотягивает короткий микс и
 *    `-t` режет длинный. У обычной сборки длину держит видеопоток,
 *    здесь его нет.
 *
 * Вход `{{source}}` — ИСХОДНЫЙ рендер, тот же, что уходит в обычную
 * сборку, а не готовый ролик: в готовом уже звучит оригинальный голос,
 * и новая дорожка легла бы поверх него.
 */
export interface AudioTrackJobOptions {
  /** Ключ исходного рендера; по умолчанию `source`. */
  inputKey?: string;
  /** Ключ файла с переведённой речью. */
  voiceInputKey: string;
  /** Ключ музыкальной подложки, если она была у оригинала. */
  musicInputKey?: string | null;
  mode: 'voiceover' | 'dub';
  /** У исходника нет звуковой дорожки вовсе (`silentSource`). */
  sourceHasNoAudio?: boolean;
  duck?: number;
  musicVolume?: number;
  voiceDelayMs?: number;
  /** Ускорение речи, если без него не влезает. */
  tempoRate?: number | null;
  /** Длина ролика — дорожка приводится ровно к ней. */
  totalDurationSeconds: number;
  outputName?: string;
}

export function planAudioTrackJob(opts: AudioTrackJobOptions): PostProdPlan {
  const inputKey = opts.inputKey ?? 'source';
  const voiceKey = opts.voiceInputKey?.trim();
  if (!voiceKey) {
    throw new PostProdError('дорожка без файла голоса не собирается');
  }
  const total = opts.totalDurationSeconds;
  if (!(total > 0)) {
    throw new PostProdError('длина ролика неизвестна — дорожку не собрать');
  }
  const musicKey = opts.musicInputKey?.trim() || null;
  const outputName = opts.outputName ?? 'track.m4a';
  const delayMs = Math.max(0, Math.round(opts.voiceDelayMs ?? 0));
  const usesSource = opts.mode === 'voiceover' && !opts.sourceHasNoAudio;

  const inputKeys = [inputKey, voiceKey, ...(musicKey ? [musicKey] : [])];
  const filters = audioMixFilters({
    source: usesSource ? { duck: opts.duck ?? DEFAULT_DUCK } : null,
    voice: { index: 1, delayMs, tempoRate: opts.tempoRate ?? null },
    music: musicKey
      ? { index: 2, volume: opts.musicVolume ?? DEFAULT_MUSIC_VOLUME }
      : null,
    totalSeconds: total,
    padToSeconds: total,
  });

  const command = [
    ...inputKeys.map((k) => `-i {{${k}}}`),
    `-filter_complex "${filters.join(';')}"`,
    '-map "[a]"',
    '-vn',
    '-c:a aac -b:a 192k',
    `-t ${total}`,
    `{{${outputName}}}`,
  ].join(' ');

  return {
    outputName,
    command,
    inputKeys,
    crop: null,
    audio: { mode: opts.mode, delayMs },
    subtitles: false,
  };
}
