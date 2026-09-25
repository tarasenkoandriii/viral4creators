import { mp3DurationSeconds } from './mp3-duration';

/**
 * Длительность mp3 по байтам (этап 138, §5 ТЗ).
 *
 * Кадры здесь собираются руками, а не берутся файлом: во-первых, в
 * репозитории не место бинарнику ради одного теста, во-вторых —
 * собранный кадр проверяет РАЗБОР ЗАГОЛОВКА, а не то, что «на этом
 * конкретном файле сошлось». Числа в тестах посчитаны по спецификации
 * MPEG: кадр Layer III MPEG1 — 1152 сэмпла, при 44100 Гц это ровно
 * 0,0261 секунды.
 */

/** Заголовок кадра MPEG1 Layer III, стерео, 128 кбит/с, 44,1 кГц. */
function frame(
  opts: { bitrateIndex?: number; padding?: boolean } = {},
): Buffer {
  const bitrateIndex = opts.bitrateIndex ?? 9; // 128 кбит/с
  const header = Buffer.from([
    0xff,
    0xfb, // sync + MPEG1 + Layer III + без CRC
    (bitrateIndex << 4) | (0 << 2) | ((opts.padding ? 1 : 0) << 1), // 44100
    0x00, // стерео
  ]);
  const length = Math.floor((144 * 128000) / 44100) + (opts.padding ? 1 : 0);
  return Buffer.concat([header, Buffer.alloc(length - 4)]);
}

const FRAME_SECONDS = 1152 / 44100;

describe('mp3DurationSeconds', () => {
  it('CBR: считает кадры подряд — случай обоих провайдеров продукта', () => {
    // ElevenLabs отдаёт mp3_44100_128, Resemble — mp3; оба CBR.
    const audio = Buffer.concat(Array.from({ length: 40 }, () => frame()));
    expect(mp3DurationSeconds(audio)).toBeCloseTo(40 * FRAME_SECONDS, 2);
  });

  it('кадр с набивкой длиннее на байт — и следующий кадр всё равно находится', () => {
    // Ошибка на этот один байт рассыпала бы весь дальнейший разбор:
    // следующий заголовок искался бы не там, где он есть.
    const audio = Buffer.concat([
      frame({ padding: true }),
      frame(),
      frame({ padding: true }),
    ]);
    expect(mp3DurationSeconds(audio)).toBeCloseTo(3 * FRAME_SECONDS, 2);
  });

  it('ID3v2 в начале пропускается по длине из своего заголовка', () => {
    // Синхробезопасное целое: по семь значащих бит в байте. Прочитать
    // его как обычное — промахнуться мимо первого кадра.
    // В теле тега нарочно лежит то, что выглядит как заголовок кадра:
    // так и бывает в жизни — обложка альбома в ID3 это JPEG, а он полон
    // байт 0xFF. Пропусти тег не полностью — разбор начнётся с этой
    // подделки, и длительность будет выдуманной.
    const tagBody = Buffer.alloc(200);
    tagBody.set([0xff, 0xfb, 0x90, 0x00], 100);
    const id3 = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([0x04, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x01, 0x48]), // 200 = 0b1_1001000
      tagBody,
    ]);
    const audio = Buffer.concat([
      id3,
      ...Array.from({ length: 10 }, () => frame()),
    ]);
    expect(mp3DurationSeconds(audio)).toBeCloseTo(10 * FRAME_SECONDS, 2);
  });

  it('VBR: число кадров берётся из Xing, а не проходом по файлу', () => {
    // У VBR длина кадров разная, и складывать их «как у CBR» — верный
    // способ получить неправильную длительность.
    const first = frame();
    first.write('Xing', 36, 'latin1'); // 4 + 32 байта side info у стерео MPEG1
    first.writeUInt32BE(0x01, 40); // флаг «есть число кадров»
    first.writeUInt32BE(500, 44);
    const audio = Buffer.concat([first, frame(), frame()]);
    expect(mp3DurationSeconds(audio)).toBeCloseTo(500 * FRAME_SECONDS, 1);
  });

  it('не mp3 и обрывки — null, а не ноль', () => {
    // «Не смогли измерить» и «дорожка нулевой длины» — разные вещи:
    // на нуле проверка длины дорожки решила бы, что она не подходит.
    expect(mp3DurationSeconds(Buffer.alloc(0))).toBeNull();
    expect(mp3DurationSeconds(Buffer.from('это просто текст'))).toBeNull();
    expect(mp3DurationSeconds(Buffer.alloc(5000))).toBeNull();
    expect(mp3DurationSeconds(Buffer.from([0xff, 0xfb]))).toBeNull();
  });

  it('кадр, найденный далеко от начала, кадром не считается', () => {
    // Ограничение поиска синхрослова — решение, а не мелочь: без него
    // «первый кадр» найдётся в любом достаточно большом мусоре, и
    // функция вернёт правдоподобное число вместо честного «не смогли».
    // У настоящего mp3 первый кадр стоит сразу за тегом.
    const audio = Buffer.concat([
      Buffer.alloc(20_000),
      ...Array.from({ length: 10 }, () => frame()),
    ]);
    expect(mp3DurationSeconds(audio)).toBeNull();
  });

  it('запрещённые значения битрейта кадром не считаются', () => {
    // `free` (0) и `bad` (15) не дают вычислить длину кадра — по такому
    // «кадру» разбор поехал бы с произвольным шагом.
    expect(mp3DurationSeconds(frame({ bitrateIndex: 0 }))).toBeNull();
    expect(mp3DurationSeconds(frame({ bitrateIndex: 15 }))).toBeNull();
  });
});
