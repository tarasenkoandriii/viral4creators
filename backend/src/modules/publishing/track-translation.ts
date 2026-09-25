/**
 * Перевод реплики ПОД ХРОНОМЕТРАЖ (§5 ТЗ TZ-Multilingual-YouTube.md,
 * этап 138) — промпт и разбор ответа, чистые функции.
 *
 * ## Чем это отличается от обычного перевода
 *
 * Обычный перевод оптимизирует точность. Здесь точность вторична:
 * реплика обязана уложиться в тот же хронометраж, потому что картинка
 * уже снята и длится ровно восемь секунд. Немецкий длиннее английского
 * процентов на пятнадцать — значит немецкую фразу надо не перевести, а
 * пересказать короче, сохранив смысл и тон.
 *
 * Поэтому требование «столько же по длине» стоит в промпте ПЕРВЫМ, до
 * всего остального, и выражено в слогах, а не в символах: слоги — это
 * то, чем меряется произносимая длина, а символы у кириллицы и
 * латиницы считаются по-разному.
 *
 * ## Почему реплика переводится ПОСТРОЧНО (этап 141)
 *
 * Прежняя редакция просила «одну строку простой речи» и брала из
 * ответа первую строку — то есть склеивала реплику из двух-трёх битов
 * в одну фразу. Для звука это уже было заметно: пауза между битами
 * пропадала, и немецкий голос выговаривал всё к середине ролика, пока
 * картинка шла дальше. А для субтитров это было смертельно: строки
 * оригинала разложены по секундам (`heuristicCueTimings`), и без них
 * перевод не к чему привязать — субтитр получился бы одной простынёй
 * на весь ролик.
 *
 * Строки нумеруются, и ответ разбирается по номерам, а не по порядку
 * строк: пояснения («24 syllables») модель дописывает снизу, и без
 * номеров они попали бы в реплику. Не сошлось число строк — откат к
 * прежнему поведению: одна строка, а вызывающий это увидит по числу
 * строк в ответе.
 *
 * ## Повторная попытка
 *
 * Второй заход отличается от первого одной строкой: «предыдущий вариант
 * оказался на N процентов длиннее, сделай короче». Без явного числа
 * модель обычно возвращает ту же фразу другими словами — это проверено
 * на переводах блога и записано в ТЗ как отдельное требование.
 */

import { SupportedLocale, languageNameForLocale } from '../../common/locale';

/** Грубая, но честная оценка числа слогов — по гласным. */
export function syllableCount(text: string): number {
  const vowels = text
    .toLowerCase()
    .match(/[aeiouyаеёиоуыэюяєіїäöüáéíóúàèìòùâêîôû]/g);
  return vowels ? vowels.length : 0;
}

export interface TrackTranslationInput {
  /** Реплика оригинала — то, что звучит в ролике. */
  speech: string;
  target: SupportedLocale;
  source: SupportedLocale;
  /**
   * На сколько процентов короче нужно по сравнению с ПРЕДЫДУЩИМ
   * вариантом. Пусто — первая попытка.
   */
  shorterByPercent?: number;
  /** Предыдущий, слишком длинный вариант — модели нужно его видеть. */
  previous?: string;
}

/** Реплики оригинала — по одной на бит ролика. */
export function speechLines(speech: string): string[] {
  return (speech ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function buildTrackTranslationPrompt(
  input: TrackTranslationInput,
): string {
  const syllables = syllableCount(input.speech);
  const budget = input.shorterByPercent
    ? Math.max(1, Math.round(syllables * (1 - input.shorterByPercent / 100)))
    : syllables;
  const source = speechLines(input.speech);
  const numbered = source.length > 1;

  const lines = [
    `Rewrite this ad voiceover in ${languageNameForLocale(input.target)} ` +
      `(the original is in ${languageNameForLocale(input.source)}).`,
    '',
    'The single hardest requirement, before anything else:',
    `- It must take about the same time to say out loud: aim for ${budget} syllables or fewer in total.`,
    '- Meaning and tone matter more than literal wording. Shorten, drop filler, rephrase.',
    '- Keep product names and brand names as they are.',
  ];

  if (numbered) {
    // Строки — это биты ролика, и каждая звучит поверх своего куска
    // картинки: их число и порядок менять нельзя, иначе и звук, и
    // субтитр разъедутся с тем, что на экране.
    lines.push(
      `- The original has ${source.length} numbered lines, each spoken over its own part of the video.`,
      `- Answer with exactly ${source.length} lines, numbered the same way ("1.", "2.", ...), same order.`,
      // На повторном заходе «каждая строка примерно как своя
      // оригинальная» противоречит требованию сократить (находка
      // аудита этапа 141): просим сохранить не длину, а соотношение.
      input.shorterByPercent
        ? '- Shorten every line by about the same share: their proportions must stay, they are not interchangeable.'
        : '- Keep each line about as long as its own original: they are not interchangeable.',
      '- Plain speech only. No quotes, no notes, no explanations.',
    );
  } else {
    lines.push(
      '- One line of plain speech. No quotes, no notes, no explanations.',
    );
  }

  if (input.shorterByPercent && input.previous) {
    lines.push(
      '',
      `Your previous version was too long and had to be cut off mid-sentence. ` +
        `Make it about ${input.shorterByPercent}% shorter than this:`,
      // Прошлый вариант показывается в ТОЙ ЖЕ форме, в какой ждём
      // ответ: неразмеченный образец рядом с требованием «ответь
      // нумерованными строками» — приглашение ответить как образец.
      numbered
        ? speechLines(input.previous)
            .map((l, i) => `${i + 1}. ${l}`)
            .join('\n')
        : input.previous,
    );
  }

  lines.push(
    '',
    numbered ? 'Original lines:' : 'Original line:',
    numbered ? source.map((l, i) => `${i + 1}. ${l}`).join('\n') : input.speech,
  );
  return lines.join('\n');
}

/**
 * Разбор ответа. Модель отвечает строкой, а не JSON: у реплики нет
 * структуры, и просить её оборачивать значит добавить место, где
 * можно ошибиться. Убираем кавычки, которыми модель любит обрамлять
 * реплику, и служебные префиксы вида «Translation:».
 */
export function parseTrackTranslation(
  raw: string,
  expectedLines = 1,
): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  if (expectedLines > 1) {
    const numbered = collectNumbered(text, expectedLines);
    // Не сошлось — откат к однострочному разбору: склеенная реплика
    // хуже разложенной, но лучше перевранного порядка битов.
    if (numbered) return numbered.join('\n');
  }

  // Первая непустая строка: пояснения модель дописывает снизу.
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  // Нумерацию снимаем только там, где сами её и просили: в обычной
  // реплике «5. часов работы» цифра — часть речи, а не разметка.
  const bare =
    expectedLines > 1 ? first.replace(/^\s*\d{1,2}\s*[.)\]]\s+/, '') : first;
  return cleanLine(bare);
}

/**
 * Строки ответа по их номерам. Нумерация, а не порядок: модель
 * дописывает снизу пояснения («24 syllables»), и они встали бы на место
 * реплики. Неполный набор — null: половина битов хуже, чем склейка.
 */
function collectNumbered(text: string, expected: number): string[] | null {
  const found = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,2})\s*[.)\]]\s*(.+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    // Номер вне набора — это не реплика, а приписка снизу («3. итого:
    // 24 слога»): пропускаем, иначе из-за неё потерялась бы вся
    // разбивка.
    if (n < 1 || n > expected) continue;
    // Номер повторился — модель переписала сама себя, и какой из двух
    // вариантов она считает ответом, знать неоткуда. Молча взять любой
    // значит выбрать монеткой; честнее откатиться к склейке.
    if (found.has(n)) return null;
    const cleaned = cleanLine(m[2]);
    if (cleaned) found.set(n, cleaned);
  }
  if (found.size !== expected) return null;
  return Array.from({ length: expected }, (_, i) => found.get(i + 1)!);
}

function cleanLine(raw: string): string | null {
  const text = raw
    .replace(/^\s*(translation|перевод|варіант|вариант)\s*:\s*/i, '')
    .trim()
    .replace(/^["'«“]|["'»”]$/g, '')
    .trim();
  return text || null;
}
