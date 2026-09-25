/**
 * Шаблоны сцен без референса (этап 149, TODO §III п.11) — последний
 * незакрытый пункт «Уровня 1».
 *
 * ## Что это решает
 *
 * Сегодня путь один: найти чужой удачный ролик → разобрать его →
 * получить промпт. Барьер входа — первый шаг: чтобы НАЧАТЬ, нужен
 * чужой ролик, которого у человека нет. Шаблон заменяет именно его:
 * готовый приём («распаковка», «до и после»), по которому промпт
 * собирается так же, как по разбору.
 *
 * ## Чего здесь сознательно НЕТ: поддельного разбора
 *
 * Соблазнительный путь — собрать из шаблона `VideoAnalysis` со
 * `status: 'complete'` и пустить дальше нетронутый конвейер: ни одной
 * правки в промпте, готовности и экране. Отвергнут. `VideoAnalysis`
 * значит «что Gemini увидел в референсе», и поддельная запись сделала
 * бы ложью всё, что её читает: `previewUrl` кадров несуществующего
 * ролика, `originalDialogueSample`, `referenceDurationSeconds`,
 * `fromLibrary`, экран оператора с «разбором» видео, которого нет.
 * Поле, которое никогда не может честно принять своё значение, —
 * находка, которую аудиты этого проекта ловят раз за разом; заводить
 * такое нарочно значит подписаться под ней заранее.
 *
 * Шаблон — свой маленький снимок в `Session.data`, и подменяет он
 * разбор ровно в трёх местах, где тот доходит до промпта: текст
 * описания, раскадровка и естественная ориентация кадра.
 *
 * ## Почему приёмов четыре и почему именно эти
 *
 * Список из TODO п.11 дословно. Он не выдуман: это четыре формата,
 * которые в UGC-рекламе работают без сценариста, и у каждого своё
 * ремесло, которое человек без опыта нарушит. «До и после» бесполезно
 * при смене ракурса; сравнение с конкурентом опасно, если чужой товар
 * узнаваем; отзыв — это говорящая голова, а её нельзя снимать под нашу
 * озвучку. Ровно это шаблон и знает за человека.
 *
 * ## Кадры, а не сюжет
 *
 * Формулировки про КАМЕРУ и ДЕЙСТВИЕ — тот же приём и та же причина,
 * что у `greeting-scenes.ts`: сюжет пишет промпт по данным товара, и
 * повторять его здесь значило бы с ним спорить. Оттуда же взят и сам
 * механизм: несколько кадров описываются ОДНИМ промптом, склейки в
 * конвейере нет и не заводится.
 */

/** Ролик товарки — восемь секунд (клип Veo). */
export const PRODUCT_CLIP_SECONDS = 8;

/**
 * Больше трёх кадров в восьми секундах не бывает: при четырёх на кадр
 * остаётся две секунды, и это уже нарезка, а не реклама. У
 * поздравлений потолок четыре — там пятнадцать секунд.
 */
export const MAX_TEMPLATE_BEATS = 3;

export const SCENE_TEMPLATE_IDS = [
  'unboxing',
  'before-after',
  'testimonial',
  'vs-competitor',
] as const;

export type SceneTemplateId = (typeof SCENE_TEMPLATE_IDS)[number];

/**
 * Кто в кадре. Не украшение: по этому экран решает, предупреждать ли,
 * что в режиме нашей озвучки человек в кадре говорить не будет (см.
 * `speaksOnCamera`).
 */
export type TemplatePresenter = 'none' | 'hands' | 'face';

export interface SceneTemplateSpec {
  id: SceneTemplateId;
  /** Естественная ориентация приёма. */
  frame: '9:16' | '16:9';
  presenter: TemplatePresenter;
  /** Чем приём торгует — одна строка, задаёт тон всему промпту. */
  intent: string;
  /** Кадры по порядку: камера и действие. */
  beats: readonly string[];
  /**
   * Ремесло приёма — то, что человек без опыта нарушит, а модель без
   * указания не соблюдёт. Уходит в промпт отдельным правилом.
   */
  craft: readonly string[];
}

/**
 * Каталог. Английский — как и весь остальной текст, уходящий в модель.
 * Подписи для человека живут в словарях фронтенда: здесь только то,
 * что читает модель, иначе перевод каталога стал бы правкой промпта.
 */
export const SCENE_TEMPLATES: Readonly<
  Record<SceneTemplateId, SceneTemplateSpec>
> = {
  unboxing: {
    id: 'unboxing',
    frame: '9:16',
    presenter: 'hands',
    intent:
      'an unboxing: the viewer sees the product for the first time exactly as they would receive it',
    beats: [
      'hands bring the sealed package into frame; close on the seal giving way',
      'the product comes out of the box — an unhurried reveal, turned once in the light',
      'the product doing its job, one honest beat of it in use',
    ],
    craft: [
      'Keep the packaging intact and readable in the first shot — the parcel is the promise, and a torn box breaks it.',
      'Hands only: no face, no talking. The product is the subject.',
    ],
  },
  'before-after': {
    id: 'before-after',
    frame: '9:16',
    presenter: 'none',
    intent:
      'a before-and-after: one honest state, then the changed one, and nothing else asking for attention',
    beats: [
      'the "before" state, plainly shown, no styling and no exaggeration',
      'a hard cut to the "after" state',
    ],
    craft: [
      'IDENTICAL framing, camera distance, angle, lighting and white balance in both shots — the comparison is the entire point, and any change of angle or light makes it worthless and reads as a trick.',
      'No transition effect between the two shots: a hard cut, so nothing can be suspected of hiding in it.',
    ],
  },
  testimonial: {
    id: 'testimonial',
    frame: '9:16',
    presenter: 'face',
    intent:
      'a first-person testimonial filmed on a phone: one real person, face to camera, vouching for the product',
    beats: [
      'a single handheld shot, phone held at arm’s length, natural daylight; the person faces the lens, open and unrehearsed',
      'the product held up beside the face for a moment, then lowered — a small nod, a look back to the lens',
    ],
    craft: [
      'Handheld and imperfect: slight motion, ordinary background, no studio light. A polished frame reads as an ad and loses the format its only advantage.',
      'The person looks into the lens, not past it — the format is one human vouching for something, and eye contact is what carries it.',
    ],
  },
  'vs-competitor': {
    id: 'vs-competitor',
    frame: '9:16',
    presenter: 'hands',
    intent:
      'a side-by-side comparison: the same action performed with two items, so the difference is shown rather than claimed',
    beats: [
      'two items side by side on a plain surface, equal light and equal framing',
      'a hand performs the SAME action with each in turn',
      'the chosen item stays in frame alone',
    ],
    craft: [
      'The other item is GENERIC and UNBRANDED: no logos, no wordmarks, no recognisable packaging or shape. It stands for "the usual one", not for a named competitor.',
      'The same hand, the same action, the same number of seconds for each — an uneven comparison is not a comparison.',
    ],
  },
};

/** Выбор человека — то, что лежит в сессии. */
export interface SceneTemplateChoice {
  templateId: SceneTemplateId;
  chosenAt: string;
}

export function isSceneTemplateId(value: unknown): value is SceneTemplateId {
  return (
    typeof value === 'string' &&
    (SCENE_TEMPLATE_IDS as readonly string[]).includes(value)
  );
}

export function sceneTemplate(id: SceneTemplateId): SceneTemplateSpec {
  return SCENE_TEMPLATES[id];
}

/**
 * Заговорит ли человек в кадре — при данном режиме озвучки.
 *
 * Первая версия этапа 149 объявляла здесь запрет: отзыв считался
 * несовместимым с нашей озвучкой, и выбор отклонялся `409`. Аудит снял
 * это целиком, по двум причинам.
 *
 * Во-первых, конфликт был создан своими руками: в кадрах приёма стояло
 * «talks directly to the lens», хотя держится приём на другом — на
 * съёмке с рук телефоном и на живом человеке, смотрящем в объектив.
 * Бриф §15.1 запрещает не человека в кадре, а РЕЧЬ на камеру («no
 * characters addressing the camera with WORDS»), и переписанным кадрам
 * он не противоречит.
 *
 * Во-вторых, запрет попадал не туда: `DEFAULT_VOICE_MODE` —
 * `voiceover`, и сессия без бренд-манифеста (анонимный быстрый путь, то
 * есть ровно тот новичок, ради которого шаблоны и делались) читается
 * как «озвучиваем мы». Отзыв оказывался закрыт почти для всех: четыре
 * приёма в ТЗ, три работающих на деле.
 *
 * Осталась информация, а не запрет: экран честно скажет, что в этом
 * режиме человек в кадре говорить не будет — слова несёт наша дорожка.
 */
export function speaksOnCamera(
  spec: SceneTemplateSpec,
  ownVoice: boolean,
): boolean {
  return spec.presenter === 'face' && !ownVoice;
}

/**
 * Разбор ли решает, как выглядит ролик, или приём.
 *
 * Ключ — ЗАВЕРШЁННЫЙ разбор, а не наличие записи (аудит этапа 149,
 * А-5). Первая версия смотрела на `!session.videoAnalysis`, и у сессии
 * с ПРОВАЛИВШИМСЯ разбором плюс выбранным приёмом выходило худшее из
 * возможного: готовность считала пункт закрытым (приём выбран), запись
 * разбора перебивала приём, и промпт уходил в модель с ПУСТЫМ описанием
 * сцены, а следом шёл платный рендер. Не срабатывала ни одна проверка.
 */
export function usesTemplate(
  analysisStatus: string | null | undefined,
  templateId: unknown,
): templateId is SceneTemplateId {
  return analysisStatus !== 'complete' && isSceneTemplateId(templateId);
}

/**
 * Как поделить восемь секунд между кадрами. Остаток — ПЕРВЫМ кадрам:
 * последний кадр это развязка, и лишняя секунда там заметнее как
 * пауза (то же правило и по той же причине, что в `greeting-scenes`).
 */
export function splitBeatDurations(
  totalSeconds: number,
  beatCount: number,
): number[] {
  const n = Math.min(MAX_TEMPLATE_BEATS, Math.max(1, Math.round(beatCount)));
  const total = Math.max(n, Math.round(totalSeconds));
  const base = Math.floor(total / n);
  let rest = total - base * n;
  return Array.from({ length: n }, () => {
    const extra = rest > 0 ? 1 : 0;
    rest -= extra;
    return base + extra;
  });
}

/**
 * Текст, который в товарной ветке занимает место разбора референса.
 *
 * Читается как ОПИСАНИЕ ролика, а не как указания модели, — потому что
 * дальше по промпту стоит «recreate the 8-second video»: инструкция,
 * поставленная на место описания, была бы пересказана в кадр.
 */
export function templateBreakdown(
  spec: SceneTemplateSpec,
  totalSeconds: number = PRODUCT_CLIP_SECONDS,
): string {
  const beats = spec.beats.slice(0, MAX_TEMPLATE_BEATS);
  const durations = splitBeatDurations(totalSeconds, beats.length);
  const shots =
    beats.length > 1
      ? [
          `The video is ${beats.length} consecutive shots with hard cuts between them, in this order:`,
          ...beats.map(
            (beat, i) => `- Shot ${i + 1} (~${durations[i]}s): ${beat}.`,
          ),
        ]
      : [`The video is a single continuous shot: ${beats[0]}.`];
  return [
    `This is ${spec.intent}.`,
    '',
    ...shots,
    '',
    'RULES OF THE FORMAT — these are what make it work, keep every one of them:',
    ...spec.craft.map((rule) => `- ${rule}`),
  ].join('\n');
}

/**
 * Строка, которой промпт представляет вход.
 *
 * У разбора она говорит «ниже описание существующего вирусного ролика»
 * — с шаблоном это была бы неправда, сказанная модели, и неправда
 * рабочая: рядом стоят «recreate» и «following the reference's
 * rhythm», то есть модель стала бы искать ритм несуществующего
 * оригинала.
 */
export function templateFraming(): string {
  return 'Below is the shape of the UGC video to make: a proven ad format, its shot structure and the rules that format lives by. There is no reference video — follow the format itself.';
}
