import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { UpdateBrandSnapshotRequestDto } from './update-brand-snapshot.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (v: unknown) =>
  pipe.transform(v, {
    type: 'body',
    metatype: UpdateBrandSnapshotRequestDto,
    data: '',
  });
const ok = (v: unknown) => expect(run(v)).resolves.toBeDefined();
const bad = (v: unknown) =>
  expect(run(v)).rejects.toBeInstanceOf(BadRequestException);

describe('UpdateBrandSnapshotRequestDto under the real ValidationPipe settings', () => {
  it('accepts partial edits, nulls as "clear", and an empty body', async () => {
    await ok({});
    await ok({ styleNotes: 'новый стиль' });
    await ok({ styleNotes: null, filters: null, effects: null });
    await ok({ filters: { preset: 'cool' }, effects: { fade: true } });
  });

  it('validates nested characters (label required, https photo, source id nullable)', async () => {
    await ok({
      characters: [
        {
          label: 'Аня',
          photoUrl:
            'https://store.public.blob.vercel-storage.com/brand-manifests/bm1/characters/c1/photo.png',
          sourceCharacterId: 'c1',
        },
        {
          label: 'Лис',
          description: 'плюшевый',
          sourceCharacterId: null,
          photoUrl: null,
        },
      ],
    });
    await ok({ characters: [] });
    await bad({ characters: [{ description: 'без имени' }] });
    await bad({ characters: [{ label: '' }] });
    await bad({
      characters: [{ label: 'x', photoUrl: 'http://insecure.test/a.png' }],
    });
    await bad({ characters: [{ label: 'x', photoUrl: 'not a url' }] });
    // А-2.11: адрес обязан вести в НАШЕ хранилище. Снимок манифеста
    // перезаписывается клиентом, а сервер потом скачивает эти картинки —
    // внешний адрес превращал его в чужого агента, да ещё и возвращал
    // HTTP-статус в тексте ошибки, то есть работал оракулом.
    await bad({
      characters: [
        {
          label: 'x',
          photoUrl: 'https://internal.service/brand-manifests/bm1/photo.jpg',
        },
      ],
    });
    await bad({
      characters: [
        { label: 'x', photoUrl: 'https://169.254.169.254/sessions/x.jpg' },
      ],
    });
    await bad({ characters: [{ label: 'x', extra: 1 }] });
    await bad({ characters: 'Аня' });
  });

  it('rejects unknown fields, non-object JSON and oversized notes', async () => {
    await bad({ title: 'нельзя менять название снимка' });
    await bad({ brandManifestId: 'bm2' });
    await bad({ filters: [1, 2] });
    await bad({ effects: 'str' });
    await bad({ styleNotes: 'x'.repeat(4001) });
    await bad({ styleNotes: '' });
  });

  it('caps the character list', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ label: `p${i}` }));
    await bad({ characters: many });
    await ok({ characters: many.slice(0, 20) });
  });
});
