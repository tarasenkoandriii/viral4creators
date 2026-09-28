import {
  buildTutorialCaptionsAss,
  captionReadingSeconds,
  CAPTION_CHARS_PER_SECOND,
  captionsPathname,
  hasCaptions,
} from './tutorial-captions';
import {
  CANVAS,
  FRAME_TAIL_SECONDS,
  frameSpansSeconds,
  MIN_FRAME_SECONDS,
  narrationFrameSeconds,
  SECONDS_PER_FRAME,
} from './tutorial-video-assembly';
import { MAX_NARRATION_LENGTH } from '../tutorial-scenario/scenario-steps.types';

const frame = (seconds: number, narration: string | null = null) => ({
  seconds,
  narration,
});

/** Строки `Dialogue:` файла — то, что libass и нарисует. */
function events(ass: string): string[] {
  return ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
}

describe('hasCaptions', () => {
  it('ни одной реплики — рисовать нечего', () => {
    // Вызывающий не должен ни заливать файл, ни добавлять вход
    // задачи: лишний вход это лишний скачанный файл на стороне
    // чужого сервиса.
    expect(hasCaptions([frame(2), frame(2)])).toBe(false);
    expect(buildTutorialCaptionsAss([frame(2)], 'none')).toBe('');
  });

  it('пробелы вместо реплики — тоже нечего', () => {
    expect(hasCaptions([frame(2, '   ')])).toBe(false);
  });

  it('хотя бы одна реплика — есть', () => {
    expect(hasCaptions([frame(2), frame(2, 'Жмём.')])).toBe(true);
  });
});

describe('buildTutorialCaptionsAss', () => {
  it('подпись дословно совпадает с репликой', () => {
    // §11 п.16. Обрезать текст вторым правилом, в другом месте,
    // значит показать не то, что произнесено.
    const text = 'Открываем мастер и загружаем референс.';

    expect(buildTutorialCaptionsAss([frame(3, text)], 'none')).toContain(text);
  });

  it('кадр без реплики не получает события вовсе', () => {
    // «Реплики нет» и «пустая подпись» — разные вещи: вторая мигнула
    // бы пустой плашкой посреди ролика.
    const ass = buildTutorialCaptionsAss(
      [frame(3, 'Первая.'), frame(1.5), frame(3, 'Третья.')],
      'none',
    );

    expect(events(ass)).toHaveLength(2);
  });

  it('таймкоды берутся из той же сетки, что и длительность ролика', () => {
    // §5 ТЗ: «один источник, не два». Свой расчёт разошёлся бы с
    // кадрами не сразу, а к концу ролика — округление идёт
    // покадрово, и ошибка накапливается.
    const frames = [
      frame(narrationFrameSeconds(3.03), 'Первая.'),
      frame(narrationFrameSeconds(null)),
      frame(narrationFrameSeconds(9.04), 'Третья.'),
    ];
    const spans = frameSpansSeconds(frames, 'none');
    const ass = events(buildTutorialCaptionsAss(frames, 'none'));

    expect(ass[0]).toContain(
      `0:00:${spans[0].start.toFixed(2).padStart(5, '0')}`,
    );
    expect(ass[0]).toContain(
      `0:00:${spans[0].end.toFixed(2).padStart(5, '0')}`,
    );
    // Третья подпись начинается ровно там, где кончается ВТОРОЙ
    // кадр, а не там, где кончилась бы сумма сырых длительностей.
    expect(ass[1]).toContain(
      `0:00:${spans[2].start.toFixed(2).padStart(5, '0')}`,
    );
  });

  it('таймкод ЛОЖИТСЯ НА СЕТКУ, а не берётся из сырых секунд', () => {
    // Разница видна не всегда: 3.63 попадает в сетку почти точно, и
    // первая редакция этого теста пропустила бы сырой расчёт. Здесь
    // длительности выбраны так, чтобы округление к ближайшему кадру
    // сдвигало вторую сотую: 3.649 × 30 = 109.47 → 109 кадров →
    // 3.6333, то есть «3.63», а не «3.65». Иначе подпись к
    // десятому кадру висела бы над девятым.
    const ass = events(
      buildTutorialCaptionsAss([frame(3.649, 'A'), frame(2.681, 'B')], 'none'),
    );

    expect(ass[0]).toContain('0:00:03.63');
    expect(ass[0]).not.toContain('0:00:03.65');
    // Второй кадр: 2.681 × 30 = 80.43 → 80 кадров, значит конец
    // (109 + 80) / 30 = 6.30, а не 3.649 + 2.681 = 6.33.
    expect(ass[1]).toContain('0:00:06.30');
  });

  it('подписи не накладываются друг на друга и не оставляют дыр', () => {
    // Конец одной — начало следующей: ровно так же, как сменяются
    // кадры. Иначе подпись к десятому кадру висела бы над девятым.
    const frames = [frame(3.63, 'A'), frame(1.5, 'B'), frame(9.64, 'C')];
    const times = events(buildTutorialCaptionsAss(frames, 'none')).map((l) => {
      const [, start, end] = l.split(',');
      return { start, end };
    });

    expect(times[0].end).toBe(times[1].start);
    expect(times[1].end).toBe(times[2].start);
  });

  it('фигурные скобки экранируются — иначе libass съест текст', () => {
    // `{` открывает блок команд: незакрытый или чужой блок либо
    // проглотит реплику, либо применит к ней что попало.
    const ass = buildTutorialCaptionsAss([frame(3, 'Жмём {Готово}')], 'none');

    expect(ass).toContain('\\{Готово\\}');
  });

  it('перевод строки внутри реплики не рвёт файл', () => {
    // Валидатор такую реплику отбрасывает (§3-бис.2), но генератор
    // подписей на это не полагается: одна реплика — одна строка
    // файла. Схлопывается в пробел, а не в `\\N`: реплика это одна
    // фраза, и перенос посреди неё был бы случайной паузой в чтении.
    const ass = buildTutorialCaptionsAss([frame(3, 'Первая\nвторая')], 'none');

    expect(events(ass)).toHaveLength(1);
    expect(ass).toContain('Первая вторая');
  });

  it('реплика в 220 символов НЕ обрезается', () => {
    // §11 п.18 требует проверять максимум, а не типичный текст. Что
    // она при этом помещается в кадр шестью строками — проверено
    // отрисовкой настоящим ffmpeg; здесь фиксируется, что текст
    // доезжает целиком.
    const max = ('слово '.repeat(40) + 'конец').slice(0, MAX_NARRATION_LENGTH);
    expect(max).toHaveLength(MAX_NARRATION_LENGTH);

    expect(buildTutorialCaptionsAss([frame(12, max)], 'none')).toContain(max);
  });

  it('длинное слово без пробелов рвётся жёстким переносом', () => {
    // `WrapStyle: 0` переносит ПО ПРОБЕЛАМ и такое слово разорвать
    // не может: плашка растягивается на всю ширину кадра и текст
    // срезается по краям. Валидатор его пропускает — он смотрит на
    // длину и переводы строк, а не на пробелы (находка аудита
    // этапа E).
    const url = `https://app.example.com/x?ref=${'a'.repeat(120)}`;

    const ass = buildTutorialCaptionsAss([frame(5, `Откройте ${url}`)], 'none');

    expect(ass).toContain('\\N');
    // Ни одного куска длиннее потолка строки.
    const text = events(ass)[0].split(',,')[1];
    for (const line of text.split('\\N')) {
      for (const word of line.split(' ')) {
        expect(word.length).toBeLessThanOrEqual(26);
      }
    }
  });

  it('перенос жёсткий, а не нулевой пробел', () => {
    // U+200B libass точкой переноса не считает вовсе — проверено
    // отрисовкой: строка с ним так же уезжает за оба края кадра.
    const ass = buildTutorialCaptionsAss([frame(5, 'ы'.repeat(80))], 'none');

    expect(ass).not.toContain('\u200b');
    expect(ass).toContain('\\N');
  });

  it('обычная реплика с пробелами переносами не засоряется', () => {
    const text = 'Открываем мастер и загружаем референсный ролик.';

    expect(buildTutorialCaptionsAss([frame(5, text)], 'none')).toContain(text);
  });

  it('граница подписи округляется ВНИЗ, а не к ближайшему', () => {
    // `.ass` пишет время сотыми, кадры лежат на сетке 1/30: граница
    // 2.6667 при округлении даёт 2.67, то есть конец подписи
    // оказывается ПОЗЖЕ смены кадра, и первый кадр следующего шага
    // успевает показаться со старой подписью (находка аудита E).
    const ass = events(
      buildTutorialCaptionsAss([frame(2.6667, 'A'), frame(2, 'B')], 'none'),
    );

    expect(ass[0]).toContain('0:00:02.66');
    expect(ass[0]).not.toContain('0:00:02.67');
    // И начало следующей — в той же сотой: ни наложения, ни дыры.
    expect(ass[1]).toContain('0:00:02.66');
  });

  it('плашка рисуется: BorderStyle=3 и НЕНУЛЕВОЙ Outline', () => {
    // `BorderStyle=3` самого по себе мало — libass без ненулевой
    // обводки коробку не строит вовсе, и подпись выходит белым
    // текстом на светлом экране мастера. Отрисовано и сверено.
    const style = buildTutorialCaptionsAss([frame(3, 'x')], 'none')
      .split('\n')
      .find((l) => l.startsWith('Style:'));
    const f = (style ?? '').split(',');

    expect(f[15]).toBe('3');
    expect(Number(f[16])).toBeGreaterThan(0);
    // Цвет плашки — в OutlineColour, не в BackColour.
    expect(parseInt(f[5].slice(2, 4), 16)).toBeLessThan(0xff);
  });

  it('холст подписей повторяет пропорцию холста сборки', () => {
    // libass считает раскладку в своих единицах и растянет текст,
    // если пропорции разойдутся. Переписанное от руки число
    // расходится ровно тогда, когда холст сборки меняют и сюда не
    // заглядывают (находка аудита этапа E).
    const ass = buildTutorialCaptionsAss([frame(2, 'x')], 'none');
    const x = Number(/PlayResX: (\d+)/.exec(ass)?.[1]);
    const y = Number(/PlayResY: (\d+)/.exec(ass)?.[1]);

    expect(y / x).toBeCloseTo(CANVAS.height / CANVAS.width, 3);
  });

  it('файл подписей лежит под префиксом актива', () => {
    // Транзит: скачан внешним сервисом один раз, дальше не нужен, и
    // уборка кадров уносит его вместе с ними.
    expect(captionsPathname('tutorial-video-frames/tva-1/')).toBe(
      'tutorial-video-frames/tva-1/captions.ass',
    );
  });
});

describe('подписи и движение (этап G)', () => {
  it('с переходами подпись следующего кадра начинается вместе с въездом, а не после', () => {
    // 3 с + 2 с + 4 с: кадры начинаются на 0, 81, 132 кадре (2.70 и
    // 4.40 с), ролик кончается на 252-м (8.40 с). Без переходов было
    // бы 3.00 / 5.00 / 9.00 — и к третьему кадру подпись отставала бы
    // от картинки на 0.6 с.
    const frames = [frame(3, 'Раз.'), frame(2, 'Два.'), frame(4, 'Три.')];
    const lines = events(buildTutorialCaptionsAss(frames, 'fade'));
    expect(lines[0]).toContain('0:00:00.00,0:00:02.70');
    expect(lines[1]).toContain('0:00:02.70,0:00:04.40');
    expect(lines[2]).toContain('0:00:04.40,0:00:08.40');
  });

  it('зум таймкодов не меняет — только переходы', () => {
    const frames = [frame(3, 'Раз.'), frame(2, 'Два.')];
    expect(buildTutorialCaptionsAss(frames, 'fade+zoom')).toBe(
      buildTutorialCaptionsAss(frames, 'fade'),
    );
  });
});

describe('captionReadingSeconds (сквозной аудит A–G)', () => {
  it('немой кадр с подписью держится, сколько подпись читается', () => {
    // Реплика средней длины (§7.1 — ≈120 символов). Прежние две
    // секунды — это шестьдесят символов в секунду.
    const text = 'а'.repeat(120);
    const seconds = captionReadingSeconds(text)!;
    expect(seconds).toBeCloseTo(
      120 / CAPTION_CHARS_PER_SECOND + FRAME_TAIL_SECONDS,
    );
    expect(seconds).toBeGreaterThan(4 * SECONDS_PER_FRAME);
    // Темп тот же, по которому §7.1 прикидывает речь: без звука
    // ролик идёт так же, как со звуком.
    expect(CAPTION_CHARS_PER_SECOND).toBe(15);
  });

  it('правило то же, что у кадра с речью: хвост и нижняя граница', () => {
    expect(captionReadingSeconds('Готово.')).toBe(MIN_FRAME_SECONDS);
    expect(captionReadingSeconds('x'.repeat(45))).toBe(
      narrationFrameSeconds(3),
    );
  });

  it('считается ПОКАЗАННЫЙ текст: пробелы схлопнуты, края обрезаны', () => {
    const shown = 'x'.repeat(60);
    expect(
      captionReadingSeconds(`   ${'x'.repeat(30)}\n\n   ${'x'.repeat(29)}  `),
    ).toBe(captionReadingSeconds(shown));
  });

  it('символ вне BMP — один символ, а не два', () => {
    expect(captionReadingSeconds('😀'.repeat(45))).toBe(
      captionReadingSeconds('x'.repeat(45)),
    );
  });

  it('подписи нет — решать вызывающему', () => {
    expect(captionReadingSeconds(null)).toBeNull();
    expect(captionReadingSeconds('   ')).toBeNull();
  });
});
