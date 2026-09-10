import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { BrandManifestRequestDto } from './brand-manifest-request.dto';
import { BrandCharacterRequestDto } from './brand-character-request.dto';
import {
  CharacterPhotoConfirmRequestDto,
  CharacterPhotoUploadUrlRequestDto,
} from './character-photo.dto';

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

describe('brand-manifest DTOs under the real ValidationPipe settings', () => {
  it('manifest: title/styleNotes/filters/effects; Json must be a plain object ≤16KB; nulls clear', async () => {
    await ok(BrandManifestRequestDto, {
      title: 'Бренд',
      styleNotes: 'тёплые тона',
      filters: { preset: 'warm', grain: 0.2 },
      effects: { transitions: ['cut'] },
    });
    await ok(BrandManifestRequestDto, {
      filters: null,
      effects: null,
      styleNotes: null,
    });
    await ok(BrandManifestRequestDto, {});
    await bad(BrandManifestRequestDto, { filters: ['not', 'an', 'object'] });
    await bad(BrandManifestRequestDto, { filters: 'warm' });
    await bad(BrandManifestRequestDto, {
      effects: { blob: 'x'.repeat(17 * 1024) },
    });
    await bad(BrandManifestRequestDto, { title: '' });
    await bad(BrandManifestRequestDto, { userId: 'someone-else' }); // never client-settable
  });
  it('character: label/description only — photoUrl comes from the Blob flow', async () => {
    await ok(BrandCharacterRequestDto, {
      label: 'Модель 1',
      description: null,
    });
    await bad(BrandCharacterRequestDto, {
      label: 'x',
      photoUrl: 'https://evil',
    });
    await bad(BrandCharacterRequestDto, { label: '' });
  });
  it('character photo: png/jpeg only (Veo referenceImage), confirm pathname must be a character key', async () => {
    await ok(CharacterPhotoUploadUrlRequestDto, {
      fileName: 'a.png',
      fileSize: 10,
      mimeType: 'image/png',
    });
    await bad(CharacterPhotoUploadUrlRequestDto, {
      fileName: 'a.webp',
      fileSize: 10,
      mimeType: 'image/webp',
    });
    await ok(CharacterPhotoConfirmRequestDto, {
      pathname: 'brand-manifests/bm1/characters/bc1/photo.jpg',
    });
    await bad(CharacterPhotoConfirmRequestDto, {
      pathname: 'projects/p1/items/i1/photo.jpg',
    });
    await bad(CharacterPhotoConfirmRequestDto, {
      pathname: 'brand-manifests/bm1/characters/bc1/photo.webp',
    });
    // Stage 22: the same DTO serves brand scenes.
    await ok(CharacterPhotoConfirmRequestDto, {
      pathname: 'brand-manifests/bm1/scenes/bs1/photo.png',
    });
    await bad(CharacterPhotoConfirmRequestDto, {
      pathname: 'brand-manifests/bm1/props/bs1/photo.png',
    });
  });
});
