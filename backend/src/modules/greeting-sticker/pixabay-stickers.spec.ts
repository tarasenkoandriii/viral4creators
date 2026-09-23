import {
  MAX_STICKER_RESULTS,
  parseStickerHits,
  stickerCacheKey,
  stickerSearchParams,
} from './pixabay-stickers';

const hit = (over: Record<string, unknown> = {}) => ({
  id: 101,
  previewURL: 'https://cdn.pixabay.com/x_150.png',
  webformatURL: 'https://cdn.pixabay.com/x_640.png',
  largeImageURL: 'https://cdn.pixabay.com/x_1280.png',
  pageURL: 'https://pixabay.com/illustrations/x-101/',
  tags: 'конфетти, праздник',
  ...over,
});

describe('stickerSearchParams', () => {
  it('просим прозрачные иллюстрации, а не фотографии', () => {
    // Без прозрачности накладывать не на что: наклейка закроет кадр
    // белым прямоугольником. Фотография в роли наклейки не работает.
    const p = stickerSearchParams('конфетти', 'k');
    expect(p.get('colors')).toBe('transparent');
    expect(p.get('image_type')).toBe('illustration');
    expect(p.get('safesearch')).toBe('true');
    expect(p.get('q')).toBe('конфетти');
    expect(p.get('key')).toBe('k');
  });

  it('длинный запрос обрезается — у Pixabay есть предел', () => {
    const p = stickerSearchParams('я'.repeat(200), 'k');
    expect(p.get('q')!.length).toBe(100);
  });
});

describe('parseStickerHits', () => {
  it('читает выдачу и сохраняет ссылку на страницу источника', () => {
    // Условия API: «Show your users where the images are from» —
    // без `sourceUrl` показать неоткуда.
    const [r] = parseStickerHits({ hits: [hit()] });
    expect(r.id).toBe('101');
    expect(r.downloadUrl).toBe('https://cdn.pixabay.com/x_1280.png');
    expect(r.previewUrl).toBe('https://cdn.pixabay.com/x_150.png');
    expect(r.sourceUrl).toBe('https://pixabay.com/illustrations/x-101/');
  });

  it('запись без страницы источника пропускается', () => {
    // Показать такую картинку означало бы нарушить условия API.
    expect(parseStickerHits({ hits: [hit({ pageURL: undefined })] })).toEqual(
      [],
    );
  });

  it('запись без изображения пропускается', () => {
    expect(
      parseStickerHits({
        hits: [
          hit({
            largeImageURL: undefined,
            webformatURL: undefined,
          }),
        ],
      }),
    ).toEqual([]);
  });

  it('превью подставляется из того, что есть', () => {
    const [r] = parseStickerHits({
      hits: [hit({ previewURL: undefined })],
    });
    expect(r.previewUrl).toBe('https://cdn.pixabay.com/x_640.png');
  });

  it('мусор вместо ответа не роняет разбор', () => {
    for (const payload of [null, undefined, {}, { hits: 'нет' }, []]) {
      expect(parseStickerHits(payload)).toEqual([]);
    }
  });

  it('выдача ограничена по длине', () => {
    const many = Array.from({ length: MAX_STICKER_RESULTS + 10 }, (_, i) =>
      hit({ id: i }),
    );
    expect(parseStickerHits({ hits: many })).toHaveLength(MAX_STICKER_RESULTS);
  });
});

describe('stickerCacheKey', () => {
  it('регистр и лишние пробелы — один и тот же запрос', () => {
    // Кеш обязателен по условиям Pixabay, и он не должен промахиваться
    // из-за заглавной буквы.
    expect(stickerCacheKey('  Конфетти   Праздник ')).toBe('конфетти праздник');
    expect(stickerCacheKey('конфетти праздник')).toBe(
      stickerCacheKey('КОНФЕТТИ  ПРАЗДНИК'),
    );
  });
});
