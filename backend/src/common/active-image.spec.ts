import {
  activeCastImage,
  activeProductImage,
  activeRowImage,
  activeSessionSceneImage,
  activeSnapshotCharacterImage,
  activeSnapshotSceneImage,
  mimeFromPath,
  sketchRefFromRow,
} from './active-image';
import { SketchRef } from './types/sketch.types';
import { CastReplacement } from './types/casting.types';
import { ProductInformation } from './types/product.types';
import { SceneAsset } from './types/reference.types';

const SKETCH: SketchRef = {
  sketchId: 'sk1',
  url: 'https://blob/sketches/u1/sk1.png',
  pathname: 'sketches/u1/sk1.png',
  mimeType: 'image/png',
  style: 'pencil',
  sketchRendering: 'realistic',
  appliedAt: '2026-09-17T10:00:00.000Z',
};

const cast = (over: Partial<CastReplacement> = {}): CastReplacement => ({
  kind: 'photo',
  photoUrl: 'https://blob/sessions/s1/characters/c1/photo.jpg',
  photoPathname: 'sessions/s1/characters/c1/photo.jpg',
  description: null,
  brandCharacterId: null,
  label: null,
  ...over,
});

describe('active-image (doc/AI-SKETCH-SPEC.md §6.3)', () => {
  it('без скетча отдаёт оригинал, со скетчем — скетч', () => {
    expect(activeCastImage(cast())).toMatchObject({
      variant: 'original',
      pathname: 'sessions/s1/characters/c1/photo.jpg',
      mimeType: 'image/jpeg',
    });
    expect(activeCastImage(cast({ sketch: SKETCH }))).toMatchObject({
      variant: 'sketch',
      pathname: 'sketches/u1/sk1.png',
      url: SKETCH.url,
      sketchRendering: 'realistic',
    });
  });

  it('удалённый оригинал: остаётся только скетч', () => {
    const replacement = cast({
      sketch: SKETCH,
      originalDeleted: true,
      photoUrl: null,
      photoPathname: null,
    });
    expect(activeCastImage(replacement)?.variant).toBe('sketch');
  });

  it('пустой слот — null', () => {
    expect(
      activeCastImage(
        cast({ kind: 'none', photoUrl: null, photoPathname: null }),
      ),
    ).toBeNull();
    expect(activeProductImage(undefined)).toBeNull();
    expect(activeProductImage({} as ProductInformation)).toBeNull();
  });

  it('товар: скетч перебивает и путь, и mime оригинала', () => {
    const product = {
      productName: 'Пиво',
      productDescription: '',
      productImagePathname: 'projects/p1/items/i1/photo.jpg',
      productImageUrl: 'https://blob/projects/p1/items/i1/photo.jpg',
      productImageMimeType: 'image/jpeg',
      addedAt: new Date(),
    } as ProductInformation;
    expect(activeProductImage(product)).toMatchObject({
      variant: 'original',
      mimeType: 'image/jpeg',
    });
    expect(activeProductImage({ ...product, sketch: SKETCH })).toMatchObject({
      variant: 'sketch',
      mimeType: 'image/png',
      pathname: 'sketches/u1/sk1.png',
    });
  });

  it('сцена сессии и снимки бренда читаются так же', () => {
    const scene = {
      id: 'sc1',
      label: 'Кухня',
      description: null,
      photoUrl: 'https://blob/sessions/s1/scenes/sc1/photo.png',
      photoPathname: 'sessions/s1/scenes/sc1/photo.png',
      createdAt: '',
    } as SceneAsset;
    expect(activeSessionSceneImage(scene)?.variant).toBe('original');
    expect(activeSessionSceneImage({ ...scene, sketch: SKETCH })?.variant).toBe(
      'sketch',
    );

    const brandCharacter = {
      sourceCharacterId: 'bc1',
      label: 'Аня',
      photoUrl: 'https://blob/brand-manifests/bm1/characters/bc1/photo.jpg',
      description: null,
    };
    // У снимка бренда pathname нет — только публичный URL.
    expect(activeSnapshotCharacterImage(brandCharacter)).toMatchObject({
      variant: 'original',
      pathname: null,
    });
    expect(
      activeSnapshotCharacterImage({ ...brandCharacter, sketch: SKETCH }),
    ).toMatchObject({ variant: 'sketch', pathname: 'sketches/u1/sk1.png' });
    expect(
      activeSnapshotSceneImage({
        sourceSceneId: 'bs1',
        label: 'Шоурум',
        photoUrl: null,
        description: null,
      }),
    ).toBeNull();
  });

  it('строки Prisma: скетч подставляется из связанной записи', () => {
    const row = {
      photoUrl: 'https://blob/projects/p1/items/i1/photo.jpg',
      activeSketch: {
        id: 'sk9',
        url: 'https://blob/sketches/u1/sk9.png',
        pathname: 'sketches/u1/sk9.png',
        mimeType: null,
        style: 'flat',
        options: { sketchRendering: 'stylized' },
        appliedAt: new Date('2026-09-17T10:00:00.000Z'),
      },
    };
    expect(activeRowImage(row)).toMatchObject({
      variant: 'sketch',
      url: 'https://blob/sketches/u1/sk9.png',
      mimeType: 'image/png',
      sketchRendering: 'stylized',
    });
    expect(activeRowImage({ photoUrl: row.photoUrl })).toMatchObject({
      variant: 'original',
    });
    // Скетч без файла (его убрала уборка §6.7) — не подставляем битую ссылку.
    expect(
      sketchRefFromRow({ ...row.activeSketch, url: null, pathname: null }),
    ).toBeNull();
  });

  it('mime по расширению, с безопасным запасным вариантом', () => {
    expect(mimeFromPath('a/b.png')).toBe('image/png');
    expect(mimeFromPath('a/b.JPG')).toBe('image/jpeg');
    expect(mimeFromPath('a/b.bin')).toBe('image/jpeg');
    expect(mimeFromPath(null, 'image/png')).toBe('image/png');
  });
});
