/**
 * Справка по теме: что отдаётся и чего НЕ отдаётся.
 *
 * Два правила здесь важнее остальных, и оба — про то, что видит
 * пользователь: текст есть всегда, ролик — только вычитанный.
 */

import { NotFoundException } from '@nestjs/common';
import { TutorialHelpService } from './tutorial-help.service';

const ASSET = {
  blobUrl: 'https://blob/tutorial.mp4',
  externalUrl: 'https://ffmpeg-api/out.mp4',
  durationMs: 31000,
};

function build(asset: unknown = null) {
  const findFirst = jest.fn().mockResolvedValue(asset);
  const prisma = { tutorialVideoAsset: { findFirst } };
  return {
    service: new TutorialHelpService(prisma as never),
    findFirst,
  };
}

describe('TutorialHelpService', () => {
  it('отдаёт заголовок и текст темы поздравления', async () => {
    const { service } = build();
    const view = await service.get('greeting-brief', 'ru');
    expect(view.title).toBe('Расскажите о поводе');
    expect(view.text).toContain('Повод');
    expect(view.subjectKey).toBe('greeting-brief');
  });

  it('шаги мастера товара — той же ручкой, по номеру', async () => {
    // Две семьи тем, одна справка: кнопка (i) появится и в мастере
    // товара, и заводить под неё второй маршрут незачем.
    const { service } = build();
    expect((await service.get('1', 'ru')).title).toBeTruthy();
  });

  /**
   * Главное правило. Реплики пишет модель, и невычитанный ролик — это
   * её текст, показанный пользователю от имени продукта.
   */
  it('невычитанный ролик не отдаётся — фильтр стоит в запросе', async () => {
    const { service, findFirst } = build(null);
    const view = await service.get('greeting-brief', 'ru');
    expect(view.videoUrl).toBeNull();
    expect(findFirst.mock.calls[0][0].where.reviewed).toBe(true);
  });

  it('текст есть и без ролика — человек просил помощи, а не отказа', async () => {
    const { service } = build(null);
    const view = await service.get('greeting-script', 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.text.length).toBeGreaterThan(10);
  });

  it('своя ссылка важнее внешней', async () => {
    // Внешняя живёт у подрядчика сборки и переживает нас не дольше
    // договора с ним.
    const { service } = build(ASSET);
    expect((await service.get('greeting-video', 'ru')).videoUrl).toBe(
      ASSET.blobUrl,
    );
  });

  it('без своей ссылки берётся внешняя, а не «ролика нет»', async () => {
    const { service } = build({ ...ASSET, blobUrl: null });
    expect((await service.get('greeting-video', 'ru')).videoUrl).toBe(
      ASSET.externalUrl,
    );
  });

  it('ролик без ссылок вовсе в выборку не попадает', async () => {
    const { service, findFirst } = build(null);
    await service.get('greeting-video', 'ru');
    expect(findFirst.mock.calls[0][0].where.OR).toEqual([
      { blobUrl: { not: null } },
      { externalUrl: { not: null } },
    ]);
  });

  it('берётся САМЫЙ СВЕЖИЙ вычитанный, а не первый попавшийся', async () => {
    const { service, findFirst } = build(ASSET);
    await service.get('greeting-brief', 'ru');
    expect(findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('неизвестный язык — язык по умолчанию, а не пустая справка', async () => {
    const { service } = build();
    const view = await service.get('greeting-brief', 'klingon');
    expect(view.locale).toBe('ru');
    expect(view.title).toBeTruthy();
  });

  it('язык темы и язык запроса — один и тот же', async () => {
    const { service, findFirst } = build();
    const view = await service.get('greeting-brief', 'en');
    expect(view.locale).toBe('en');
    expect(view.title).toBe('Describe the occasion');
    // И ролик ищется на том же языке: английский текст с русской
    // озвучкой — хуже, чем отсутствие ролика.
    expect(findFirst.mock.calls[0][0].where.locale).toBe('en');
  });

  it('несуществующая тема — 404, а не пустая справка', async () => {
    // Пустой ответ клиент покажет как «справки нет», и опечатка в ключе
    // будет выглядеть как ненаписанная справка.
    const { service } = build();
    await expect(service.get('greeting-nonsense', 'ru')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
