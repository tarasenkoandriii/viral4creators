import { ProductService } from './product.service';
import type { Session } from '../../common/types/session.types';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `SessionService` тянет сгенерированный клиент Prisma, которого в
// песочнице нет (doc/CI.md) — тот же мок, что в соседних наборах.
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
  WorkflowKind: { SESSION: 'SESSION' },
}));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

describe('ProductService.submitProductInfo', () => {
  it('merges into the seeded snapshot instead of replacing it (Stage 10 fields survive), lower-cases the language', async () => {
    const seeded = {
      productName: 'Размер 42',
      productDescription: 'старое',
      productImagePathname: 'projects/p/items/i/photo.jpg',
      productImageMimeType: 'image/jpeg',
      category: 'кроссовки',
      currency: 'UAH',
      countryCode: 'UA',
      languageCode: 'uk',
      sourceProductItemId: 'i1',
      addedAt: new Date('2026-09-05T10:00:00Z'),
    };
    const sessions = {
      getSession: jest.fn().mockResolvedValue({
        sessionId: 's1',
        productInformation: seeded,
      } as unknown as Session),
      updateSession: jest
        .fn()
        .mockImplementation(async (_id: string, u: Partial<Session>) => ({
          status: u.status,
          ...u,
        })),
    };
    const service = new ProductService(sessions as never, {} as never);
    await service.submitProductInfo('s1', {
      productName: 'Pegasus 40, размер 42',
      productDescription: 'новое описание',
      dialogueLanguage: 'UK',
    });
    const update = sessions.updateSession.mock.calls[0][1];
    expect(update.productInformation).toMatchObject({
      productName: 'Pegasus 40, размер 42',
      productDescription: 'новое описание',
      dialogueLanguage: 'uk',
      productImagePathname: 'projects/p/items/i/photo.jpg',
      category: 'кроссовки',
      currency: 'UAH',
      languageCode: 'uk',
      sourceProductItemId: 'i1',
    });
    expect(update.productInformation!.addedAt.getTime()).toBeGreaterThan(
      seeded.addedAt.getTime(),
    );
  });

  it('works without any prior product info (anonymous flow) and leaves dialogueLanguage unset', async () => {
    const sessions = {
      getSession: jest
        .fn()
        .mockResolvedValue({ sessionId: 's1' } as unknown as Session),
      updateSession: jest
        .fn()
        .mockImplementation(async (_id: string, u: Partial<Session>) => ({
          status: u.status,
          ...u,
        })),
    };
    const service = new ProductService(sessions as never, {} as never);
    await service.submitProductInfo('s1', {
      productName: 'Кружка',
      productDescription: 'стальная',
    });
    const info = sessions.updateSession.mock.calls[0][1].productInformation!;
    expect(info).toMatchObject({
      productName: 'Кружка',
      productDescription: 'стальная',
    });
    expect(info).not.toHaveProperty('dialogueLanguage');
  });
});

/**
 * Фото товара считается загруженным только после подтверждения (В-1.8
 * третьего аудита, этап 123).
 *
 * До этого путь писался в сессию в момент ВЫДАЧИ ссылки. Сорвавшийся
 * PUT оставлял сессию с путём, по которому ничего нет: мастер при
 * восстановлении показывал фото загруженным на 100 %, а платная
 * генерация упиралась в техническую ошибку скачивания — и человеку было
 * непонятно, что делать.
 */
describe('ProductService — фото товара (В-1.8)', () => {
  const session = {
    sessionId: 's1',
    productInformation: { productName: 'Кофемолка' },
  } as unknown as Session;

  const build = (blob: Record<string, unknown>) => {
    const sessions = {
      getSession: jest.fn().mockResolvedValue(session),
      updateSession: jest.fn().mockResolvedValue(session),
    };
    return {
      sessions,
      service: new ProductService(sessions as never, blob as never),
    };
  };

  it('выдача ссылки НЕ записывает путь в сессию', async () => {
    const { service, sessions } = build({
      createUploadUrl: jest
        .fn()
        .mockResolvedValue({ uploadUrl: 'https://blob/put' }),
    });
    const res = await service.generateProductImageUploadUrl('s1', {
      fileName: 'p.jpg',
      fileSize: 1000,
      mimeType: 'image/jpeg',
    } as never);
    expect(res.data.pathname).toBe('sessions/s1/product-image.jpeg');
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('подтверждение проверяет, что файл реально лежит в хранилище', async () => {
    const { service, sessions } = build({
      getPublicUrl: jest.fn().mockResolvedValue('https://blob/p.jpg'),
    });
    await service.confirmProductImage('s1', {
      pathname: 'sessions/s1/product-image.jpeg',
    });
    expect(
      sessions.updateSession.mock.calls[0][1].productInformation,
    ).toMatchObject({
      productImagePathname: 'sessions/s1/product-image.jpeg',
      productImageMimeType: 'image/jpeg',
      productName: 'Кофемолка',
    });
  });

  it('файла нет — отказ СЕЙЧАС, и путь в сессию не попадает', async () => {
    const { service, sessions } = build({
      getPublicUrl: jest.fn().mockRejectedValue(new Error('blob not found')),
    });
    await expect(
      service.confirmProductImage('s1', {
        pathname: 'sessions/s1/product-image.jpeg',
      }),
    ).rejects.toThrow(/не найдено/);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('чужой путь не подтверждается', async () => {
    // Путь приходит от клиента: без этой проверки подтверждением чужого
    // пути можно было бы подставить в свою сессию чужой файл.
    const { service, sessions } = build({
      getPublicUrl: jest.fn().mockResolvedValue('https://blob/p.jpg'),
    });
    await expect(
      service.confirmProductImage('s1', {
        pathname: 'sessions/ДРУГАЯ/product-image.jpeg',
      }),
    ).rejects.toThrow(/sessions\/s1\/product-image\./);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('путь с выходом наверх не подтверждается (`..` внутри своего префикса)', async () => {
    // `startsWith` такой путь пропускает, а хранилище его нормализует:
    // записав его себе, можно было бы заставить уборку своей сессии
    // удалить чужое фото, а генерацию — подставить его первым кадром.
    const { service, sessions } = build({
      getPublicUrl: jest.fn().mockResolvedValue('https://blob/p.jpg'),
    });
    await expect(
      service.confirmProductImage('s1', {
        pathname: 'sessions/s1/product-image.png/../../ЧУЖАЯ/product-image.png',
      }),
    ).rejects.toThrow(/png\|jpeg\|webp/);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('тип файла берётся из расширения подтверждённого пути', async () => {
    // Он же лежит в имени: на подтверждении MIME от клиента не приходит,
    // а записанный тип читает генерация, когда отдаёт фото модели.
    const { service, sessions } = build({
      getPublicUrl: jest.fn().mockResolvedValue('https://blob/p.png'),
    });
    await service.confirmProductImage('s1', {
      pathname: 'sessions/s1/product-image.png',
    });
    expect(
      sessions.updateSession.mock.calls[0][1].productInformation
        .productImageMimeType,
    ).toBe('image/png');
  });
});
