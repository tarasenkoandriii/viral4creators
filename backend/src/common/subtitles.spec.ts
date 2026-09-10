/**
 * Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67).
 *
 * Проверяем три вещи, каждая из которых ломает ролик по-своему:
 * нормализацию (в БД лежит TEXT, туда может попасть что угодно), формат
 * таймкодов `.srt` (секунды → `HH:MM:SS,mmm`) и санитизацию текста —
 * `{`, `}` и `\` это синтаксис ASS-оверрайдов, который libass распознаёт
 * ДАЖЕ внутри `.srt`, а реплики пишет GPT-5, не человек.
 */
import {
  buildSrt,
  DEFAULT_SUBTITLE_THEME,
  DEFAULT_SUBTITLES_MODE,
  isSubtitlesMode,
  isSubtitleTheme,
  normalizeSubtitlesMode,
  normalizeSubtitleTheme,
  SUBTITLE_THEME_FORCE_STYLE,
  SUBTITLE_THEMES,
  SUBTITLES_MODES,
  SubtitleCue,
} from './subtitles';

describe('normalizeSubtitlesMode', () => {
  it('принимает известные значения', () => {
    for (const mode of SUBTITLES_MODES) {
      expect(normalizeSubtitlesMode(mode)).toBe(mode);
    }
  });

  it.each<unknown>(['ON', '', null, undefined, 42, { mode: 'on' }])(
    'на мусор отдаёт значение по умолчанию (%s)',
    (input) => {
      // Колонка в БД — TEXT без CHECK: значение может прийти из старой
      // записи или из ручной правки, и постобработка не должна тихо
      // включиться там, где никто её не заказывал.
      expect(normalizeSubtitlesMode(input)).toBe(DEFAULT_SUBTITLES_MODE);
    },
  );

  it('по умолчанию субтитры выключены', () => {
    // Новое поле манифеста не должно тихо включить лишнюю обработку и
    // расход существующим брендам после миграции.
    expect(DEFAULT_SUBTITLES_MODE).toBe('off');
  });

  it('isSubtitlesMode отличает known от мусора', () => {
    expect(isSubtitlesMode('on')).toBe(true);
    expect(isSubtitlesMode('maybe')).toBe(false);
  });
});

describe('normalizeSubtitleTheme', () => {
  it('принимает известные значения', () => {
    for (const theme of SUBTITLE_THEMES) {
      expect(normalizeSubtitleTheme(theme)).toBe(theme);
    }
  });

  it.each<unknown>(['CLASSIC', '', null, undefined, 1])(
    'на мусор отдаёт тему по умолчанию (%s)',
    (input) => {
      expect(normalizeSubtitleTheme(input)).toBe(DEFAULT_SUBTITLE_THEME);
    },
  );

  it('по умолчанию — classic', () => {
    expect(DEFAULT_SUBTITLE_THEME).toBe('classic');
  });

  it('isSubtitleTheme отличает known от мусора', () => {
    expect(isSubtitleTheme('bold')).toBe(true);
    expect(isSubtitleTheme('neon')).toBe(false);
  });

  it('у каждой темы есть готовая строка force_style', () => {
    // Стиль передаётся ЦЕЛИКОМ через `force_style` — без неё фильтр
    // `subtitles=` в постобработке останется без темы.
    for (const theme of SUBTITLE_THEMES) {
      expect(SUBTITLE_THEME_FORCE_STYLE[theme]).toContain('FontName=');
      expect(SUBTITLE_THEME_FORCE_STYLE[theme]).not.toContain("'");
    }
  });
});

describe('buildSrt', () => {
  it('одна реплика — таймкоды и текст в формате .srt', () => {
    const cues: SubtitleCue[] = [
      { startSeconds: 0, endSeconds: 1.5, text: 'Это работает.' },
    ];
    expect(buildSrt(cues)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nЭто работает.\n',
    );
  });

  it('блоки нумеруются подряд и разделены пустой строкой', () => {
    const cues: SubtitleCue[] = [
      { startSeconds: 0, endSeconds: 1, text: 'Первая.' },
      { startSeconds: 1, endSeconds: 2, text: 'Вторая.' },
    ];
    const srt = buildSrt(cues);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nПервая.\n' +
        '\n2\n00:00:01,000 --> 00:00:02,000\nВторая.\n',
    );
  });

  it('часы и минуты считаются верно на длинных роликах', () => {
    const cues: SubtitleCue[] = [
      { startSeconds: 3725.25, endSeconds: 3726, text: 'Поздно.' },
    ];
    expect(buildSrt(cues)).toContain('01:02:05,250 --> 01:02:06,000');
  });

  it('фигурные скобки и бэкслеш вырезаются — риск инъекции ASS-оверрайдов', () => {
    // libass распознаёт {\an5} и подобное ДАЖЕ внутри .srt; символ, а не
    // экранирование, потому что у .srt экранирования нет вовсе.
    const cues: SubtitleCue[] = [
      { startSeconds: 0, endSeconds: 1, text: 'Всё {\\an5}по центру\\.' },
    ];
    const srt = buildSrt(cues);
    expect(srt).not.toContain('{');
    expect(srt).not.toContain('}');
    expect(srt).not.toContain('\\');
    expect(srt).toContain('Всё an5по центру.');
  });

  it('пустая после санитизации реплика выбрасывается целиком', () => {
    const cues: SubtitleCue[] = [
      // Реплика целиком состоит из вырезаемых символов — после
      // санитизации от неё ничего не остаётся.
      { startSeconds: 0, endSeconds: 1, text: '{}\\' },
      { startSeconds: 1, endSeconds: 2, text: 'Осталась только эта.' },
    ];
    const srt = buildSrt(cues);
    // Номер блока начинается с 1, а не с 2 — выброшенная реплика не
    // оставляет дыру в нумерации.
    expect(srt).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\nОсталась только эта.\n',
    );
  });

  it('нулевая или отрицательная длительность не даёт мигающий субтитр', () => {
    const cues: SubtitleCue[] = [
      { startSeconds: 2, endSeconds: 2, text: 'Сбой тайминга.' },
    ];
    // Минимум 100 мс показа.
    expect(buildSrt(cues)).toContain('00:00:02,000 --> 00:00:02,100');
  });

  it('пустой список реплик — пустая строка, не мусор', () => {
    expect(buildSrt([])).toBe('');
  });
});
