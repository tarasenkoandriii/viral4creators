/**
 * Текст водяного знака не может содержать `{{`/`}}`: это плейсхолдер
 * протокола FFmpeg API (подставил бы hosted, отверг бы свой сервер).
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreatePortfolioItemDto,
  UpdatePortfolioItemDto,
  WATERMARK_PLACEHOLDER_MESSAGE,
} from './portfolio.dto';

const errorsOf = (cls: new () => object, body: object) =>
  validateSync(plainToInstance(cls, body)).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );

describe('watermarkText — без двойных фигурных скобок', () => {
  const create = { videoUrl: 'https://cdn.example.com/v.mp4', title: 'Ролик' };

  it.each(['{{input}}', 'Студия {{x', 'a}}', 'x {{ y }} z'])(
    'отклоняется: %j',
    (watermarkText) => {
      expect(
        errorsOf(CreatePortfolioItemDto, { ...create, watermarkText }),
      ).toContain(WATERMARK_PLACEHOLDER_MESSAGE);
      expect(errorsOf(UpdatePortfolioItemDto, { watermarkText })).toContain(
        WATERMARK_PLACEHOLDER_MESSAGE,
      );
    },
  );

  it.each([
    'Студія «Ґанок»',
    "O'Brien: 100% $5 `now`",
    '{one} {two}',
    '{ {x} }',
  ])('пропускается: %j', (watermarkText) => {
    expect(
      errorsOf(CreatePortfolioItemDto, { ...create, watermarkText }),
    ).toEqual([]);
    expect(errorsOf(UpdatePortfolioItemDto, { watermarkText })).toEqual([]);
  });

  it('null у PATCH (очистка) по-прежнему допустим', () => {
    expect(errorsOf(UpdatePortfolioItemDto, { watermarkText: null })).toEqual(
      [],
    );
  });
});
