/**
 * Жёстко вшитые субтитры (ТЗ, TODO §Уровень 2.7, этап 67).
 *
 * Большинство просмотров в ленте — без звука; ролик без субтитров теряет
 * эту половину аудитории целиком. Текст озвучки уже есть (§15), тайминг
 * считается (`voiceover-script.ts`'s `cueTimings`/`heuristicCueTimings`),
 * наложение — третья операция ТОГО ЖЕ прохода ffmpeg, что кроп и голос
 * (`common/postprod.ts`) — причины те же, что у объединения кропа и
 * голоса в одну задачу: двойной счёт, двойное перекодирование, гонка за
 * порядок.
 *
 * Решено с владельцем продукта (AskUserQuestion, этап 67): несколько
 * пресетных тем на бренд, не одна универсальная и не полная кастомная
 * типографика — отсюда закрытый список `SUBTITLE_THEMES` вместо
 * свободных настроек шрифта/цвета. У `BrandManifest` нет отдельных полей
 * цвета (только `filters`/`effects`/`styleNotes` — свободный текст и
 * JSON), поэтому темы самодостаточны: цвет и шрифт зашиты в саму тему,
 * а не выводятся из «цвета бренда».
 */

/** Включены ли субтитры у бренда. Умолчание — `off`, тот же принцип, что
 * у `voiceMode: 'veo'`/`cameraMove: 'none'`: новое поле манифеста не
 * должно тихо включить лишнюю обработку и расход существующим брендам
 * после миграции. */
export const SUBTITLES_MODES = ['off', 'on'] as const;
export type SubtitlesMode = (typeof SUBTITLES_MODES)[number];
export const DEFAULT_SUBTITLES_MODE: SubtitlesMode = 'off';

export function isSubtitlesMode(value: unknown): value is SubtitlesMode {
  return (
    typeof value === 'string' &&
    (SUBTITLES_MODES as readonly string[]).includes(value)
  );
}

export function normalizeSubtitlesMode(value: unknown): SubtitlesMode {
  return isSubtitlesMode(value) ? value : DEFAULT_SUBTITLES_MODE;
}

/** Пресетные темы оформления субтитров. */
export const SUBTITLE_THEMES = ['classic', 'bold', 'minimal'] as const;
export type SubtitleTheme = (typeof SUBTITLE_THEMES)[number];
export const DEFAULT_SUBTITLE_THEME: SubtitleTheme = 'classic';

export function isSubtitleTheme(value: unknown): value is SubtitleTheme {
  return (
    typeof value === 'string' &&
    (SUBTITLE_THEMES as readonly string[]).includes(value)
  );
}

export function normalizeSubtitleTheme(value: unknown): SubtitleTheme {
  return isSubtitleTheme(value) ? value : DEFAULT_SUBTITLE_THEME;
}

export const SUBTITLE_THEME_LABEL: Record<SubtitleTheme, string> = {
  classic: 'Классика',
  bold: 'Крупно и ярко',
  minimal: 'Минимальная подложка',
};

export const SUBTITLE_THEME_HINT: Record<SubtitleTheme, string> = {
  classic:
    'Белый текст с чёрной обводкой снизу кадра — читается на любом фоне, не бросается в глаза.',
  bold: 'Крупный жирный золотой текст с обводкой — стиль коротких вертикальных роликов.',
  minimal:
    'Белый текст на полупрозрачной чёрной подложке — сдержанно, не перекрывает кадр целиком.',
};

/**
 * Готовые строки `force_style` для фильтра ffmpeg `subtitles=` (синтаксис
 * ASS-полей: `FontName`, `PrimaryColour` — `&HAABBGGRR`, и т.д.). Стиль
 * задаётся целиком через `force_style`, поэтому `.ass` со своей секцией
 * `[V4+ Styles]` не нужен — обычный `.srt` плюс эта строка на проходе
 * ffmpeg дают тот же результат при меньшей сложности сборки.
 */
export const SUBTITLE_THEME_FORCE_STYLE: Record<SubtitleTheme, string> = {
  classic:
    'FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60',
  bold: 'FontName=Arial,Bold=1,FontSize=28,PrimaryColour=&H0000D7FF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=70',
  minimal:
    'FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,BackColour=&H80000000,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=50',
};

/** Одна субтитровая реплика с таймингом в секундах от начала ролика. */
export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Пословное выравнивание речи, как его отдаёт ElevenLabs
 * (`/with-timestamps`, поле `normalized_alignment` — синхронизировано с
 * реально произнесённым текстом ПОСЛЕ нормализации провайдера, в отличие
 * от `alignment`, синхронизированного с исходным текстом запроса).
 * `characters[i]` длится от `starts[i]` до `ends[i]` секунд.
 */
export interface SubtitleAlignment {
  characters: string[];
  starts: number[];
  ends: number[];
}

function pad(n: number, len = 2): string {
  return String(Math.max(0, Math.trunc(n))).padStart(len, '0');
}

/** `00:00:02,500` — формат таймкода `.srt`. */
function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hh = Math.floor(totalMs / 3_600_000);
  const mm = Math.floor((totalMs % 3_600_000) / 60_000);
  const ss = Math.floor((totalMs % 60_000) / 1000);
  const mmm = totalMs % 1000;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}

/**
 * `{`, `}` и `\` — синтаксис ASS-оверрайдов, который libass распознаёт
 * ДАЖЕ внутри `.srt`. Реплика с фигурной скобкой (маловероятно, но текст
 * пишет GPT-5, не человек) способна сломать рендер или незаметно
 * поменять стиль посреди строки — вырезаем эти символы, а не экранируем:
 * экранирования у `.srt` нет, а для читаемых субтитров пропавший символ
 * незаметнее сломанного рендера.
 */
function sanitizeCueText(text: string): string {
  return text.replace(/[{}\\]/g, '').trim();
}

/**
 * Собрать `.srt` из реплик. Пустые после санитизации реплики
 * выбрасываются целиком (пустой субтитровый блок — не ошибка формата,
 * но и не то, что стоит показывать зрителю), номера блоков идут подряд
 * без пропусков.
 */
export function buildSrt(cues: SubtitleCue[]): string {
  const blocks = cues
    .map((cue) => ({ ...cue, text: sanitizeCueText(cue.text) }))
    .filter((cue) => cue.text.length > 0);

  return blocks
    .map((cue, index) => {
      const start = formatSrtTimestamp(cue.startSeconds);
      // Минимум 100 мс показа — нулевая или отрицательная длительность
      // (сбой тайминга) даст мигающий "невидимый" субтитр.
      const end = formatSrtTimestamp(
        Math.max(cue.endSeconds, cue.startSeconds + 0.1),
      );
      return `${index + 1}\n${start} --> ${end}\n${cue.text}\n`;
    })
    .join('\n');
}
