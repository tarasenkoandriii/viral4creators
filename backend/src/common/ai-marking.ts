/**
 * Машиночитаемая маркировка ИИ в MP4 поздравлений (В-6 ТЗ Greeting 2.0,
 * заход 8, C11). Только метаданные файла: видимую строку в кадре решает
 * юрист, её здесь нет.
 *
 * ## Что пишется
 *
 * Два стандартных тега контейнера MP4 — их читают ffprobe, exiftool,
 * плееры и площадки, свои ключи (`-movflags use_metadata_tags`) читают
 * не все:
 *
 * - `comment` — разбираемая строка `ключ=значение;…`:
 *   `ai_generated=1` — ролик создан ИИ; `digital_source_type=
 *   trainedAlgorithmicMedia` — термин словаря IPTC Digital Source Type,
 *   которым площадки помечают синтетические медиа; `ai_persona=1` — в
 *   кадре синтетический облик или голос живого человека (режим «Я в
 *   кадре», `GreetingBriefSnapshot.usesPersona`);
 * - `description` — то же человеческими словами.
 *
 * Персональных данных нет и быть не может: в метаданные идут только
 * константы и признак. Ни имён, ни повода, ни id сессии.
 *
 * ## Чьи ролики
 *
 * Решение захода 8 (с максимальной пользой): помечается КАЖДЫЙ ролик,
 * снятый ИИ, — поздравления (Grok, Hedra) и товарные (Veo, Grok,
 * аватар Hedra): требование машиночитаемой маркировки синтетики (ст.
 * 50(2) AI Act) по смыслу касается любого такого ролика, не только
 * дипфейка. Метка едет в той задаче ffmpeg, которая запускается и так,
 * и ничего не стоит. Отдельную задачу ffmpeg ТОЛЬКО ради метки
 * запускаем лишь для поздравлений с персоной (`aiMarkingRequired`): там
 * облик реального человека, и ролик без метки — ровно тот случай, ради
 * которого В-6 написан. Товарный ролик без другой работы остаётся без
 * метки — платить за неё отдельным проходом не стали (решение
 * координатора).
 *
 * Через постобработку идут только ролики, снятые нашими моделями
 * (`postprod.start` зовут лишь завершения рендера Veo/Grok/Hedra), —
 * чужое видео пользователя этой меткой не помечается.
 *
 * Последующие проходы ffmpeg (экспорт форматов, водяной знак) метку
 * сохраняют сами: ffmpeg по умолчанию копирует глобальные метаданные
 * первого входа. Переозвучка собирает ролик из сырого файла заново —
 * поэтому получает метку той же функцией, что и первая сборка.
 */

/** Значение IPTC Digital Source Type для медиа, созданного обученной моделью. */
export const IPTC_TRAINED_ALGORITHMIC_MEDIA = 'trainedAlgorithmicMedia';

export type AiMetadata = Readonly<Record<'comment' | 'description', string>>;

/** Минимум снимка брифа, нужный маркировке (`GreetingBriefSnapshot`). */
export interface AiMarkingSource {
  usesPersona?: boolean | null;
}

/**
 * Метаданные ролика, снятого ИИ. `snapshot` — снимок брифа поздравления;
 * у товарного ролика его нет (`null`), и метка — базовая, без
 * `ai_persona`.
 */
export function aiVideoMetadata(
  snapshot: AiMarkingSource | null | undefined,
): AiMetadata {
  const persona = snapshot?.usesPersona === true;
  const comment = [
    'ai_generated=1',
    `digital_source_type=${IPTC_TRAINED_ALGORITHMIC_MEDIA}`,
    ...(persona ? ['ai_persona=1'] : []),
  ].join(';');
  return {
    comment,
    description: persona
      ? 'AI-generated video with a synthetic likeness or voice of a real person'
      : 'AI-generated video',
  };
}

/** Нужна ли метка настолько, что ради неё одной стоит запускать ffmpeg. */
export function aiMarkingRequired(
  snapshot: AiMarkingSource | null | undefined,
): boolean {
  return snapshot?.usesPersona === true;
}

/**
 * Значение тега — только из безопасного набора: команда уходит строкой в
 * хостед-ffmpeg, и кавычка или `{{` в значении сломали бы разбор или
 * подстановку входов. Значения — наши константы, так что отказ здесь —
 * ошибка программиста, а не пользовательский ввод.
 */
const SAFE_VALUE = /^[A-Za-z0-9 _=;:.,()/-]{1,200}$/;
const SAFE_KEY = /^[a-z_]{1,32}$/;

/** Аргументы ffmpeg: `-metadata "ключ=значение"` по одному на тег. */
export function metadataArgs(
  meta: Readonly<Record<string, string>> | null | undefined,
): string[] {
  if (!meta) return [];
  return Object.entries(meta).map(([key, value]) => {
    if (!SAFE_KEY.test(key) || !SAFE_VALUE.test(value)) {
      throw new Error(`недопустимый тег метаданных: ${key}`);
    }
    return `-metadata "${key}=${value}"`;
  });
}
