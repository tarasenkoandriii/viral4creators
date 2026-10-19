import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import {
  STORY_EDITIONS,
  storyEditionBlocker,
  storyEditionTextSha256,
  storyEditionView,
  storyEditionsList,
  validateStoryEditions,
  type StoryEdition,
} from './story-editions';
import { STORY_CATALOG, storyCatalogEntry } from './story-catalog';
import { STORY_VIDEO_BASE } from './story-video-base';
import { StoryGiftsService } from './story-gifts.service';
import { StoryGiftsController } from './story-gifts.controller';
import { StoryReferenceLibraryController } from './story-reference-library.controller';
import { StoryDevelopmentGuard } from './story-development.guard';

const TURNIP = 'turnip-ushinsky-ru-1949-v1';
const turnip = () => STORY_EDITIONS.find((e) => e.id === TURNIP)!;
const clone = (e: StoryEdition, patch: Partial<StoryEdition>): StoryEdition =>
  JSON.parse(JSON.stringify({ ...e, ...patch })) as StoryEdition;

describe('Story editorial registry (WP2, §23.5)', () => {
  it('is internally consistent: hashes, rights, sources, adaptation links', () => {
    expect(validateStoryEditions(STORY_EDITIONS)).toEqual([]);
    for (const e of STORY_EDITIONS)
      expect(storyEditionTextSha256(e.chapters)).toBe(e.textSha256);
  });

  it('keeps published ids and the Ushinsky 1949 hash pinned by renders', () => {
    expect(STORY_EDITIONS.map((e) => e.id)).toEqual([
      'turnip-ushinsky-ru-1949-v1',
      'little-lantern-ru-v1',
      'mitten-ru-short-v1',
      'mitten-uk-short-v1',
      'three-pigs-en-short-v1',
      'three-pigs-ru-short-v1',
    ]);
    const t = turnip();
    expect(t.textSha256).toBe(
      '39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',
    );
    expect(t.textSha256).toBe(STORY_VIDEO_BASE.textSha256);
    expect(STORY_VIDEO_BASE.catalogId).toBe(t.id);
    expect(t.publication).toMatchObject({ volume: '6', year: 1949 });
    expect(t.publication?.pages).toContain('45–46');
    expect(t.chapters.at(-1)?.text).toContain('вытащили репку!');
  });

  /**
   * B-S3-5. Frozen `id → textSha256` of every edition that was ever
   * approved. Editing an approved text and recomputing its literal would pass
   * the consistency test above; this map makes that a red build. Rule: an
   * approved text never changes under the same id — publish a new id and
   * retire the old one. New approved editions are APPENDED here; lines are
   * never edited or removed (retired editions stay with their hash).
   */
  const FROZEN_APPROVED_TEXT_SHA256: Readonly<Record<string, string>> = {
    'turnip-ushinsky-ru-1949-v1':
      '39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',
    'little-lantern-ru-v1':
      'b5e81549e1c2708fe7ba469e8d2dc338e64862d9ec052bf6017637d2c0f1d5f5',
    'mitten-ru-short-v1':
      '4cda9202310b4d148adb7c36b9d4b19b11c1fb49f27716dc6bcf508eb0e81ba1',
    'mitten-uk-short-v1':
      '64240f55bff95f59be433a58f092c75aa0df71d8878612fe6b389402cd25c0d1',
    'three-pigs-en-short-v1':
      '1279cc0c7957211c4fdd1cc7c509e59539f2c9c2c93b95162b20cd891c854609',
    'three-pigs-ru-short-v1':
      '549e06fbfb9514a8753559e02a6e3f88b55d91827921da11b0e23cdaaee479ab',
  };
  it('never changes the text of an approved edition under the same id (frozen hashes)', () => {
    for (const e of STORY_EDITIONS.filter(
      (x) => x.status === 'approved' || x.status === 'retired',
    )) {
      expect([e.id, FROZEN_APPROVED_TEXT_SHA256[e.id]]).toEqual([
        e.id,
        e.textSha256,
      ]);
      expect([e.id, storyEditionTextSha256(e.chapters)]).toEqual([
        e.id,
        FROZEN_APPROVED_TEXT_SHA256[e.id],
      ]);
    }
    // Frozen ids are never dropped from the registry (retire, don't delete).
    for (const id of Object.keys(FROZEN_APPROVED_TEXT_SHA256))
      expect(STORY_EDITIONS.some((e) => e.id === id)).toBe(true);
  });

  it('approves classics only with confirmed rights and a scan comparison', () => {
    for (const e of STORY_EDITIONS.filter(
      (x) => x.kind === 'classic' && x.status === 'approved',
    )) {
      expect(e.legal.status).not.toBe('unknown');
      expect(e.textVerification?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.source.scanUrl ?? e.source.textUrl).toMatch(/^https:\/\//);
    }
    // No scan bytes in the registry — link and optional hash only.
    for (const e of STORY_EDITIONS)
      expect(JSON.stringify(e.source)).not.toMatch(/base64|data:/);
  });

  it('labels every adaptation with its differences and source', () => {
    const adaptations = STORY_EDITIONS.filter((e) => e.kind === 'adaptation');
    expect(adaptations.length).toBeGreaterThan(0);
    for (const e of adaptations) {
      expect(e.adaptation?.changes.length).toBeGreaterThan(0);
      expect(e.adaptation?.plotSourceUrl).toMatch(/^https:\/\//);
      const classic = e.adaptation?.classicEditionId ?? null;
      expect(
        classic === null ||
          STORY_EDITIONS.some((x) => x.id === classic && x.kind === 'classic'),
      ).toBe(true);
      const view = storyEditionView(e);
      expect(view.kindLabel).toBe('адаптация');
      expect(view.adaptation?.changes).toEqual(e.adaptation?.changes);
    }
    for (const e of STORY_EDITIONS.filter((x) => x.kind !== 'adaptation'))
      expect(e.adaptation).toBeNull();
  });

  it('offers in the wizard only approved, rights-cleared, hash-verified editions', () => {
    const t = turnip();
    expect(storyEditionBlocker(t)).toBeNull();
    expect(storyEditionBlocker(clone(t, { status: 'candidate' }))).toMatch(
      /Кандидат/,
    );
    expect(storyEditionBlocker(clone(t, { status: 'retired' }))).toMatch(
      /снята/,
    );
    expect(
      storyEditionBlocker(
        clone(t, { legal: { ...t.legal, status: 'unknown' } }),
      ),
    ).toMatch(/Права/);
    const edited = clone(t, {});
    (edited.chapters as unknown as { text: string }[])[0].text +=
      ' И жили долго.';
    expect(storyEditionBlocker(edited)).toMatch(/SHA-256/);
    expect(validateStoryEditions([edited])).toEqual([
      `${TURNIP}: textSha256 не совпадает с текстом`,
    ]);
    expect(storyEditionBlocker(clone(t, { textVerification: null }))).toMatch(
      /сверки/,
    );
    const ids = STORY_CATALOG.map((s) => s.id);
    expect(ids).toEqual(
      STORY_EDITIONS.filter((e) => storyEditionBlocker(e) === null).map(
        (e) => e.id,
      ),
    );
  });

  it('rejects broken adaptation links and compares with a registered classic', () => {
    const mitten = STORY_EDITIONS.find((e) => e.id === 'mitten-ru-short-v1')!;
    const orphan = clone(mitten, {
      adaptation: { ...mitten.adaptation!, classicEditionId: 'missing-v1' },
    });
    expect(validateStoryEditions([...STORY_EDITIONS, orphan])).toContain(
      'mitten-ru-short-v1: повтор id',
    );
    const renamed = clone(orphan, { id: 'mitten-ru-short-v2' });
    expect(validateStoryEditions([renamed])).toContain(
      'mitten-ru-short-v2: ссылка на несуществующую классику missing-v1',
    );
    expect(storyEditionBlocker(renamed, [renamed])).toMatch(/отсутствующую/);
    const linked = clone(mitten, {
      id: 'turnip-short-ru-v1',
      adaptation: { ...mitten.adaptation!, classicEditionId: TURNIP },
    });
    const view = storyEditionView(linked, [...STORY_EDITIONS, linked]);
    expect(view.adaptation?.comparedWith).toBe('registered-classic');
    expect(view.adaptation?.classic).toMatchObject({
      id: TURNIP,
      chapters: 3,
    });
    expect(
      validateStoryEditions([
        clone(turnip(), {
          id: 'turnip-candidate-v2',
          legal: { ...turnip().legal, status: 'unknown' },
        }),
      ]),
    ).toContain(
      'turnip-candidate-v2: утверждённая классика без подтверждённых прав',
    );
    expect(
      validateStoryEditions([
        clone(turnip(), {
          id: 'turnip-candidate-v3',
          status: 'candidate',
          legal: { ...turnip().legal, status: 'unknown' },
        }),
      ]),
    ).toEqual([]);
  });
});

describe('Catalogue API compatibility and editions route', () => {
  it('keeps every field StoryGiftsScreen reads and adds labelled metadata', () => {
    const catalog = StoryGiftsService.prototype.catalog.call({}) as Array<
      Record<string, unknown>
    >;
    expect(catalog.map((s) => s.id)).toEqual([
      'turnip-ushinsky-ru-1949-v1',
      'little-lantern-ru-v1',
      'mitten-ru-short-v1',
      'mitten-uk-short-v1',
      'three-pigs-en-short-v1',
      'three-pigs-ru-short-v1',
    ]);
    for (const s of catalog) {
      for (const key of [
        'id',
        'title',
        'rights',
        'chapters',
        'locale',
        'countries',
        'targetSeconds',
        'kind',
        'revision',
        'ageBand',
        'audioReserveUsd',
        'kindLabel',
        'legal',
        'editionStatus',
        'textSha256',
      ])
        expect(s).toHaveProperty(key);
      expect(s.kindLabel === 'адаптация').toBe(s.kind === 'adaptation');
      expect(
        Array.isArray((s.adaptation as { changes?: unknown })?.changes),
      ).toBe(s.kind === 'adaptation');
    }
    const t = catalog[0];
    expect(t).toMatchObject({
      sourceUrl:
        'https://imwerden.de/pdf/ushinsky_sobranie_sochineny_tom06_1949_text.pdf#page=46',
      sourceEdition: {
        author: 'Константин Дмитриевич Ушинский',
        edition:
          'Собрание сочинений. Том 6. Родное слово. Москва — Ленинград: Издательство АПН РСФСР, 1949',
        pages: '45–46 (PDF 46–47)',
        verifiedAt: '2026-10-16',
        textSha256:
          '39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',
      },
    });
    expect(catalog[1]).not.toHaveProperty('sourceUrl');
    expect(catalog[2].sourceUrl).toMatch(/wikisource/);
    // Catalogue entries are copies: mutating one never changes the registry.
    const entry = storyCatalogEntry(turnip());
    entry.chapters[0].text = 'x';
    expect(storyEditionBlocker(turnip())).toBeNull();
  });

  it('lists the whole registry without narrated texts', () => {
    const list = storyEditionsList();
    expect(list).toHaveLength(STORY_EDITIONS.length);
    expect(JSON.stringify(list)).not.toContain('тянут-потянут');
    expect(list[0]).toMatchObject({
      id: TURNIP,
      kindLabel: 'классика',
      legal: { status: 'public_domain' },
      textHashVerified: true,
      availableInWizard: true,
      blocker: null,
    });
  });

  it('serves editions privately, owner-only, before the `:id` route', () => {
    const names = Object.getOwnPropertyNames(StoryGiftsController.prototype);
    expect(names.indexOf('editions')).toBeGreaterThan(-1);
    expect(names.indexOf('editions')).toBeLessThan(names.indexOf('get'));
    const privateHandlers: [object, string][] = [
      [StoryGiftsController.prototype, 'editions'],
      [StoryReferenceLibraryController.prototype, 'quota'],
      [StoryReferenceLibraryController.prototype, 'youtube'],
      [StoryReferenceLibraryController.prototype, 'plan'],
    ];
    for (const [proto, method] of privateHandlers)
      expect(
        Reflect.getMetadata(
          HEADERS_METADATA,
          (proto as Record<string, unknown>)[method] as object,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Cache-Control',
            value: expect.stringContaining('no-store'),
          }),
          expect.objectContaining({
            name: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive',
          }),
        ]),
      );
    for (const controller of [
      StoryGiftsController,
      StoryReferenceLibraryController,
    ])
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(
        StoryDevelopmentGuard,
      );
  });
});
