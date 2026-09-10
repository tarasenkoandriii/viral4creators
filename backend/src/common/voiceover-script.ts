/**
 * Текст озвучки как отдельная сущность (ТЗ §15.2, этап 35).
 *
 * До этого этапа реплики жили внутри промпта строкой «Dialogue: …» и
 * никакой самостоятельной жизни не имели: их читал Veo, и всё. Как
 * только речь синтезируем мы, у текста появляются свои требования —
 * пользователь должен его увидеть и поправить ДО синтеза (переслушать
 * дороже, чем перечитать), а синтезатору нужен чистый текст без пометок
 * о сценах и таймингах.
 *
 * ## Почему разбор терпимый, а не строгий
 *
 * Модель просят вернуть JSON с двумя ключами, и обычно она так и делает.
 * Но она же иногда оборачивает его в ```json, иногда добавляет фразу
 * перед объектом, иногда забывает второй ключ вовсе. Строгий разбор
 * означал бы «сорян, озвучки не будет» на ровном месте, поэтому здесь
 * лестница: JSON → JSON в блоке кода → ключ регуляркой → реплики,
 * вытащенные из самого промпта.
 *
 * Последняя ступень важнее, чем кажется: она даёт озвучку и для
 * промптов, сгенерированных ДО этого этапа, — их в сессиях уже есть.
 */

/**
 * Строка-заголовок, а не реплика: «Dialogue (timed to scenes):».
 *
 * `\b` после русского слова здесь не работает — граница слова в JS
 * считается по ASCII, и между «диалог» и «:» её нет. Отсюда форма без
 * `\b`; цена — «Голосование:» тоже сойдёт за заголовок, что не страшно.
 */
const HEADING =
  /^\s*(dialogue|voice-?over|диалог|озвучка|реплики)[^:]{0,40}:\s*$/i;

const BULLET = /^[-–—*•]+\s*/;
const SCENE = /^(scene|сцена|beat|бит)\s*\d+\s*[:.)–—-]*\s*/i;
const TIMECODE =
  /^\d{1,2}[:.]\d{1,2}(\s*[–—-]\s*\d{1,2}[:.]\d{1,2})?\s*[:,–—-]*\s*/;
const PAREN = /^\([^)]*\)\s*[:,–—-]*\s*/;
const SPEAKER =
  /^(female|male|woman|man|narrator|voice-?over|vo|голос|диктор|женский|мужской)[^:\n]{0,40}:\s*/i;

/**
 * Снять с одной строки всё, что не произносится. Порядок здесь не
 * декоративный: пометки вложены друг в друга («- Scene 1 (0:00–0:01.5,
 * female VO): …»), и снимать их надо снаружи внутрь. Стопка независимых
 * регулярок, применённых в произвольном порядке, откусывает от таймкода
 * половину и оставляет «.5, female VO…» в тексте для синтезатора.
 */
function stripLineNoise(input: string): string {
  let s = input.trim();
  s = s.replace(BULLET, '');
  s = s.replace(SCENE, '');
  s = s.replace(TIMECODE, '');
  while (PAREN.test(s)) s = s.replace(PAREN, '');
  s = s.replace(SPEAKER, '');
  return s.trim();
}

export interface PromptParts {
  /** Промпт для Veo — как и раньше, что вернула модель. */
  prompt: string;
  /** Реплики отдельным текстом, если их удалось выделить. */
  script: string | null;
  /** Откуда взялся текст — видно в логах, когда что-то не так. */
  source: 'field' | 'dialogue' | 'none';
}

function firstJsonObject(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // следующая попытка
    }
  }
  return null;
}

/**
 * Реплики из самого текста промпта: строки после «Dialogue:» до
 * следующего раздела. Ступень для промптов, написанных до этапа 35.
 */
export function dialogueFromPrompt(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    /^\s*dialogue\b|^\s*диалог\b|^\s*реплики\b/i.test(l),
  );
  if (start === -1) {
    // Однострочный формат «Dialogue: "…". End with: …» — берём кусок
    // между меткой и следующей меткой раздела.
    const inline = text.match(
      /\bDialogue\s*(?:\([^)]*\))?:\s*([\s\S]*?)(?:\n\s*[A-ZА-Я][^:\n]{2,30}:|\bEnd with\b|$)/,
    );
    const value = inline?.[1]?.trim();
    return value ? value : null;
  }

  const collected: string[] = [];
  const head = lines[start].replace(/^[^:]*:\s*/, '').trim();
  if (head) collected.push(head);
  for (const line of lines.slice(start + 1)) {
    // Новый раздел промпта («Visual direction by scene:», «End with:»)
    // начинается со слова с двоеточием и не выглядит как реплика.
    if (/^\s*$/.test(line)) continue;
    if (
      /^\s*(end with|visual direction|text overlay|camera|colors|audio|pacing|aesthetic)\b/i.test(
        line,
      )
    ) {
      break;
    }
    collected.push(line.trim());
  }
  const value = collected.join('\n').trim();
  return value ? value : null;
}

/**
 * Разобрать ответ модели: промпт и текст озвучки. Никогда не бросает —
 * худший исход это `script: null`, и тогда озвучка просто не предлагается.
 */
export function parsePromptResponse(raw: string): PromptParts {
  const text = raw?.trim() ?? '';
  const obj = firstJsonObject(text);

  const promptFromObj =
    obj && typeof obj.prompt === 'string' ? obj.prompt.trim() : null;
  const scriptFromObj =
    obj && typeof obj.voiceoverScript === 'string'
      ? obj.voiceoverScript.trim()
      : null;

  // Промпт оставляем ровно тем, чем он был до этого этапа: если модель
  // отдала объект — его строкой, иначе — сырым ответом. Менять то, что
  // уходит в Veo, ради новой функции было бы подменой предмета.
  const prompt = promptFromObj ?? text;

  if (scriptFromObj) {
    return { prompt, script: scriptFromObj, source: 'field' };
  }

  const fallback = dialogueFromPrompt(prompt);
  return fallback
    ? { prompt, script: fallback, source: 'dialogue' }
    : { prompt, script: null, source: 'none' };
}

/**
 * Реплики построчно, каждая — без номеров сцен, таймкодов, пометок о том,
 * кто говорит, и кавычек. Вынесена из `speakableText` на этапе 67: для
 * синтеза нужен единый текст, а для субтитров — построчные единицы (одна
 * строка = один субтитровый блок), и дублировать очистку под них было бы
 * ошибкой — расхождение в правилах чистки дало бы для одного и того же
 * ролика разный текст в озвучке и в субтитрах.
 */
export function speakableLines(script: string | null | undefined): string[] {
  const raw = (script ?? '').trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (HEADING.test(line)) continue;
    let s = stripLineNoise(line);
    if (!s) continue;
    // Кавычки вокруг реплики модель ставит почти всегда — вслух они не
    // читаются, но некоторые синтезаторы делают на них паузу.
    s = s
      .replace(/^["'«“”„]+/, '')
      .replace(/["'»“”„]+$/, '')
      .trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Текст, который уйдёт в синтез: без номеров сцен, таймкодов, пометок о
 * том, кто говорит, и кавычек вокруг реплик. Синтезатор прочитает всё,
 * что ему дадут, — включая «Scene 2 (0:01.5–0:03.5, female VO)».
 */
export function speakableText(script: string | null | undefined): string {
  return speakableLines(script).join('\n');
}

/**
 * Секунда, на которой начинается первая реплика (ТЗ §15.4, этап 36).
 *
 * Половина открытого вопроса 15.2, которую можно закрыть бесплатно.
 * Разложить реплики по битам — значит синтезировать по фразе и платить
 * за каждую; а вот СДВИНУТЬ дорожку к моменту, когда в ролике начинают
 * говорить, можно из того, что модель уже написала: она размечает
 * реплики таймкодами, и до этого этапа `speakableText` просто выбрасывал
 * их в мусор.
 *
 * Берётся начало ПЕРВОЙ строки, которая после снятия разметки осталась
 * произносимой: заголовок «Dialogue (timed to scenes):» тоже содержит
 * скобки, и считать его за реплику значило бы сдвинуть голос в никуда.
 *
 * Нет таймкодов — ноль, и это правильный ответ: пользователь, который
 * переписал текст своими словами, ничего про тайминг не сказал, и
 * выдумывать за него сдвиг не нужно.
 */
const MAX_CUE_SECONDS = 30;

export function firstCueSeconds(script: string | null | undefined): number {
  const raw = (script ?? '').trim();
  if (!raw) return 0;
  for (const line of raw.split(/\r?\n/)) {
    if (HEADING.test(line)) continue;
    if (!stripLineNoise(line)) continue;
    const m = line.match(/(\d{1,2})[:.](\d{1,2}(?:\.\d+)?)/);
    if (!m) return 0;
    const seconds = Number(m[1]) * 60 + Number(m[2]);
    // Ролик длится восемь секунд. Реплика, начинающаяся заметно позже
    // его конца, — это не тайминг, а мусор в разметке («1:05» вместо
    // «0:01.05»), и сдвигать по нему значит получить немую дорожку.
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_CUE_SECONDS)
      return 0;
    return Math.round(seconds * 10) / 10;
  }
  return 0;
}

/** Оценка длительности речи по числу символов — для сдвига и предупреждений. */
export function estimateSpeechSeconds(text: string): number {
  const chars = speakableText(text).replace(/\s+/g, ' ').trim().length;
  if (!chars) return 0;
  // ~14 символов в секунду — темп спокойной рекламной начитки; для
  // предупреждения «текст длиннее ролика» точности хватает с запасом.
  return Math.round((chars / 14) * 10) / 10;
}

/**
 * Тайминг субтитров для `voiceover`/`dub` (ТЗ, TODO §Уровень 2.7, этап
 * 67) — по РЕАЛЬНОМУ пословному выравниванию, которое ElevenLabs отдаёт
 * вместе с озвучкой (`/with-timestamps`).
 *
 * Не побайтовое выравнивание, а подстрочный поиск с интерполяцией:
 * нормализация ElevenLabs (числа → слова, сокращения) иногда меняет
 * текст настолько, что реплика не находится в `alignment.characters`
 * дословно. Для читаемых субтитров точный алгоритм диф-выравнивания
 * избыточен — интерполяция между соседними найденными репликами даёт
 * достаточную точность, а не найденная НИ ОДНА реплика (редкий случай)
 * даёт равномерное распределение по всей длительности, а не пустой
 * список.
 */
export function cueTimings(
  script: string | null | undefined,
  alignment: {
    characters: string[];
    starts: number[];
    ends: number[];
  },
): Array<{ startSeconds: number; endSeconds: number; text: string }> {
  const lines = speakableLines(script);
  const total = alignment.characters.length;
  if (!lines.length || !total) return [];

  const haystack = alignment.characters.join('').toLowerCase();
  const totalEndSeconds = alignment.ends[total - 1] ?? 0;

  // Якоря: индекс первого символа реплики в `haystack`, либо null, если
  // подстрока не нашлась. Поиск идёт от конца предыдущего найденного
  // якоря — иначе повторяющееся слово в начале двух реплик подряд нашло
  // бы обе в одном и том же (первом) месте.
  const anchors: Array<number | null> = [];
  let searchFrom = 0;
  for (const line of lines) {
    const needle = line.toLowerCase().trim();
    if (!needle) {
      anchors.push(null);
      continue;
    }
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) {
      anchors.push(null);
    } else {
      anchors.push(idx);
      searchFrom = idx + needle.length;
    }
  }

  const resolved = fillGaps(anchors, total);

  const clamp = (i: number) => Math.min(Math.max(i, 0), total - 1);
  const cues: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    const startIdx = clamp(resolved[i]);
    const startSeconds = alignment.starts[startIdx] ?? 0;
    const rawEnd =
      i + 1 < lines.length
        ? (alignment.starts[clamp(resolved[i + 1])] ?? totalEndSeconds)
        : totalEndSeconds;
    const endSeconds = Math.max(rawEnd, startSeconds + 0.3);
    cues.push({ startSeconds, endSeconds, text: lines[i] });
  }
  return cues;
}

/**
 * Заполнить пропуски (`null`) в списке найденных позиций линейной
 * интерполяцией между соседними известными значениями. Позиции до
 * первого известного якоря — 0 (реплика точно не позже начала ролика);
 * якорей нет вовсе — равномерная сетка по всей длине.
 */
function fillGaps(anchors: Array<number | null>, total: number): number[] {
  const firstKnown = anchors.findIndex((v) => v !== null);
  if (firstKnown === -1) {
    return anchors.map((_, i) =>
      Math.round((i / Math.max(anchors.length, 1)) * total),
    );
  }
  const result: number[] = [...anchors] as number[];
  for (let i = 0; i < firstKnown; i++) result[i] = 0;

  let lastKnown = firstKnown;
  for (let i = firstKnown + 1; i < result.length; i++) {
    if (anchors[i] !== null) {
      lastKnown = i;
      continue;
    }
    let next = i;
    while (next < result.length && anchors[next] === null) next++;
    const nextValue = next < result.length ? (anchors[next] as number) : total;
    const span = next - lastKnown;
    const lastValue = result[lastKnown];
    result[i] = Math.round(
      lastValue + ((nextValue - lastValue) * (i - lastKnown)) / span,
    );
  }
  return result;
}

/**
 * Тайминг субтитров для `veo` — best-effort (решение владельца продукта,
 * AskUserQuestion, этап 67): Veo сам озвучивает по репликам из промпта,
 * отдельного вызова синтеза нет, значит РЕАЛЬНОГО тайминга взять
 * неоткуда. Реплики распределяются по диапазону `[startSeconds,
 * totalSeconds]` пропорционально длине в символах — та же идея, что у
 * `estimateSpeechSeconds`, только не абсолютная скорость речи, а доля от
 * заранее известного фиксированного отрезка (Veo всегда рендерит ролик
 * ровно `VIDEO_DURATION_SECONDS`, см. `common/veo-duration.ts`).
 * Осознанный риск дрейфа субтитров от факта — не считается браком.
 */
export function heuristicCueTimings(
  script: string | null | undefined,
  startSeconds: number,
  totalSeconds: number,
): Array<{ startSeconds: number; endSeconds: number; text: string }> {
  const lines = speakableLines(script);
  if (!lines.length) return [];

  const lengths = lines.map((l) => Math.max(l.length, 1));
  const totalChars = lengths.reduce((a, b) => a + b, 0);
  const span = Math.max(totalSeconds - startSeconds, 0.5);

  const cues: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }> = [];
  let cursor = Math.max(startSeconds, 0);
  for (let i = 0; i < lines.length; i++) {
    const share = lengths[i] / totalChars;
    const isLast = i === lines.length - 1;
    const end = isLast
      ? totalSeconds
      : Math.min(cursor + span * share, totalSeconds);
    cues.push({
      startSeconds: cursor,
      endSeconds: Math.max(end, cursor + 0.3),
      text: lines[i],
    });
    cursor = end;
  }
  return cues;
}
