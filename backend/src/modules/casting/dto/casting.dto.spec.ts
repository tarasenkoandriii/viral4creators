import { ValidationPipe, BadRequestException } from '@nestjs/common';
import {
  CastPhotoConfirmRequestDto,
  PutCastingRequestDto,
} from './casting.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (m: any, v: unknown) =>
  pipe.transform(v, { type: 'body', metatype: m, data: '' });
const ok = (m: unknown, v: unknown) => expect(run(m, v)).resolves.toBeDefined();
const bad = (m: unknown, v: unknown) =>
  expect(run(m, v)).rejects.toBeInstanceOf(BadRequestException);

describe('casting DTOs', () => {
  it('PUT casting: nested casts with typed replacement', async () => {
    await ok(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: { kind: 'none' },
        },
        {
          characterId: 'c2',
          active: true,
          order: 2,
          replacement: { kind: 'text', description: 'рыжая' },
        },
        {
          characterId: 'c3',
          active: false,
          order: 0,
          replacement: {
            kind: 'brand',
            photoUrl:
              'https://store.public.blob.vercel-storage.com/brand-manifests/bm1/characters/c1/photo.png',
            brandCharacterId: 'b1',
            label: 'Аня',
          },
        },
      ],
    });
    await ok(PutCastingRequestDto, { casts: [] });
    // А-2.11: фото замены тоже скачивает сервер — адрес обязан вести в
    // наше хранилище, иначе клиент диктует, куда серверу сходить.
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: {
            kind: 'brand',
            photoUrl: 'https://internal.service/brand-manifests/bm1/photo.jpg',
            brandCharacterId: 'b1',
            label: 'Аня',
          },
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'x1',
          active: true,
          order: 1,
          replacement: { kind: 'none' },
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: 'yes',
          order: 1,
          replacement: { kind: 'none' },
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: -1,
          replacement: { kind: 'none' },
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: { kind: 'skin' },
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: { kind: 'brand', photoUrl: 'http://x.test/a.png' },
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: [
        {
          characterId: 'c1',
          active: true,
          order: 1,
          replacement: { kind: 'none' },
          extra: 1,
        },
      ],
    });
    await bad(PutCastingRequestDto, {
      casts: Array.from({ length: 11 }, (_, i) => ({
        characterId: `c${i}`,
        active: true,
        order: i,
        replacement: { kind: 'none' },
      })),
    });
  });

  it('photo confirm: session-scoped pathname only', async () => {
    await ok(CastPhotoConfirmRequestDto, {
      pathname: 'sessions/abc/characters/c1/photo.jpg',
    });
    await ok(CastPhotoConfirmRequestDto, {
      pathname: 'sessions/abc/characters/c10/photo.png',
      description: 'd',
    });
    await bad(CastPhotoConfirmRequestDto, {
      pathname: 'brand-manifests/x/characters/y/photo.png',
    });
    await bad(CastPhotoConfirmRequestDto, {
      pathname: 'sessions/abc/characters/c1/photo.webp',
    });
    await bad(CastPhotoConfirmRequestDto, {
      pathname: 'sessions/abc/characters/c1/photo.jpg',
      extra: true,
    });
  });
});
