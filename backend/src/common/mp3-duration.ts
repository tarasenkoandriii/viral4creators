/**
 * Длительность mp3 по самим байтам (§5 ТЗ TZ-Multilingual-YouTube.md,
 * первый кирпич этапа 138).
 *
 * ## Зачем
 *
 * Интерфейс TTS обещает в своей же шапке «текст → mp3 плюс
 * длительность» (`modules/tts/tts.types.ts`), а `SynthesisResult`
 * длительности не содержит: ни ElevenLabs, ни Resemble её не отдают.
 * Пока это никому не мешало — расход считается по символам, а не по
 * секундам. Мешать начинает на дорожках: YouTube требует, чтобы
 * альтернативная дорожка была ПРИМЕРНО той же длины, что ролик, а
 * перевод почти никогда не совпадает по длине с оригиналом (§5). Проверить
 * это нечем, если длительность неизвестна.
 *
 * ## Почему разбор байт, а не ffmpeg
 *
 * ffmpeg у продукта хостед (`FfmpegApiService`): это платная задача с
 * опросом готовности. Платить job'ом и секундами ожидания за число,
 * которое лежит в заголовках первого же кадра, — плохой размен. Здесь
 * чистая функция без сети: те же байты, что уже в руках после синтеза.
 *
 * ## Что разбирается
 *
 * - ID3v2 в начале файла (ElevenLabs его не шлёт, Resemble — как
 *   придётся) пропускается по длине из его же заголовка;
 * - Xing/Info в первом кадре (VBR) — берётся число кадров оттуда, это
 *   и точнее, и на порядок быстрее прохода по файлу;
 * - иначе кадры считаются подряд по их заголовкам (CBR — случай обоих
 *   провайдеров: `mp3_44100_128` у ElevenLabs).
 *
 * Непонятные байты — `null`, а не ноль и не исключение: «не смогли
 * измерить» и «дорожка нулевой длины» — разные вещи, и вызывающий
 * обязан их различать.
 */

/** Битрейты Layer III, кбит/с. Индекс 0 — «free», 15 — запрещённый. */
const BITRATES_V1 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATES_V2 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/** Сколько кадров пройти, прежде чем признать файл безнадёжным. */
const MAX_FRAMES = 200_000;

interface FrameHeader {
  frameLength: number;
  samplesPerFrame: number;
  sampleRate: number;
  /** Смещение Xing/Info относительно начала кадра. */
  sideInfoOffset: number;
}

/** Разбор четырёхбайтового заголовка кадра; null — это не кадр. */
function parseFrameHeader(buf: Buffer, at: number): FrameHeader | null {
  if (at + 4 > buf.length) return null;
  if (buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (buf[at + 1] >> 3) & 0x03;
  const layerBits = (buf[at + 1] >> 1) & 0x03;
  // 0x01 — зарезервированная версия; Layer III — это 0x01 в битах слоя.
  if (versionBits === 1 || layerBits !== 1) return null;

  const rates = SAMPLE_RATES[versionBits];
  if (!rates) return null;
  const sampleRateIndex = (buf[at + 2] >> 2) & 0x03;
  if (sampleRateIndex === 3) return null;
  const sampleRate = rates[sampleRateIndex];

  const bitrateIndex = (buf[at + 2] >> 4) & 0x0f;
  const table = versionBits === 3 ? BITRATES_V1 : BITRATES_V2;
  const bitrate = table[bitrateIndex] * 1000;
  const padding = (buf[at + 2] >> 1) & 0x01;
  const mpeg1 = versionBits === 3;
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const frameLength =
    Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  // Заодно отсекает «free» (0) и «bad» (15) битрейты: у них в таблице
  // ноль, и длина кадра получается меньше собственного заголовка.
  // Отдельной проверки на них нет намеренно — она была бы веткой,
  // которую нечем отличить от этой (мутация в ней выживает).
  if (frameLength <= 4) return null;

  const mono = ((buf[at + 3] >> 6) & 0x03) === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return {
    frameLength,
    samplesPerFrame,
    sampleRate,
    sideInfoOffset: 4 + sideInfo,
  };
}

/** Длина тега ID3v2 в начале файла (0 — тега нет). */
function id3Size(buf: Buffer): number {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // "ID3"
  // Размер — синхробезопасное целое: по семь значащих бит в байте.
  const size =
    (buf[6] & 0x7f) * 0x200000 +
    (buf[7] & 0x7f) * 0x4000 +
    (buf[8] & 0x7f) * 0x80 +
    (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** Число кадров из Xing/Info, если он есть в этом кадре. */
function xingFrames(buf: Buffer, frameAt: number, header: FrameHeader): number {
  const at = frameAt + header.sideInfoOffset;
  if (at + 12 > buf.length) return 0;
  const tag = buf.subarray(at, at + 4).toString('latin1');
  if (tag !== 'Xing' && tag !== 'Info') return 0;
  const flags = buf.readUInt32BE(at + 4);
  // Бит 0 — присутствует поле «число кадров».
  if ((flags & 0x01) === 0) return 0;
  return buf.readUInt32BE(at + 8);
}

/**
 * Длительность в секундах или `null`, если это не разбираемый mp3.
 * Результат округляется до сотых: миллисекунды здесь — шум, а сравнение
 * с длиной ролика идёт с допуском в проценты (§5).
 */
export function mp3DurationSeconds(audio: Buffer): number | null {
  if (!audio || audio.length < 4) return null;

  let at = id3Size(audio);
  // Первый кадр может начаться не сразу за тегом: ищем синхрослово,
  // но недалеко — иначе «поиск кадра» найдёт его в любом мусоре.
  let first: FrameHeader | null = null;
  const searchLimit = Math.min(audio.length - 4, at + 8192);
  for (; at <= searchLimit; at += 1) {
    first = parseFrameHeader(audio, at);
    if (first) break;
  }
  if (!first) return null;

  const fromXing = xingFrames(audio, at, first);
  if (fromXing > 0) {
    // Кадр с Xing/Info — служебный и сам звука не несёт, поэтому в
    // счётчике он уже учтён провайдером; вычитать его не надо.
    return round(fromXing * (first.samplesPerFrame / first.sampleRate));
  }

  // Первый кадр уже разобран, то есть цикл гарантированно сделает хотя
  // бы один проход: отдельной проверки «а был ли хоть один кадр» здесь
  // быть не должно — она недостижима, а выглядела бы как защита.
  let samples = 0;
  let frames = 0;
  let header: FrameHeader | null = first;
  while (header && frames < MAX_FRAMES) {
    samples += header.samplesPerFrame / header.sampleRate;
    frames += 1;
    at += header.frameLength;
    header = parseFrameHeader(audio, at);
  }
  return round(samples);
}

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}
