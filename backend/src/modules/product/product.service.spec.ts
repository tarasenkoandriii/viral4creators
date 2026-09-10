import { ProductService } from './product.service';
import type { Session } from '../../common/types/session.types';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
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
