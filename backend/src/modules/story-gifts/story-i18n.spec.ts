import { STORY_EDITIONS } from './story-editions';
import {
  STORY_PARENT_CONSENT_TEXTS,
  STORY_RECORDING_CONSENT_TEXTS,
  STORY_RIGHTS_TEXTS,
  STORY_TEXT_LOCALES,
  storyRightsText,
  storyTextLocale,
} from './story-i18n';
import {
  STORY_PARENT_CONSENT_TEXT,
  STORY_RECORDING_CONSENT_TEXT,
} from './story-video-plan';
import { STORY_CATALOG } from './story-catalog';
import { StoryGiftsService } from './story-gifts.service';
import { StoryGiftsController } from './story-gifts.controller';

describe('ST3: Story texts in the request language', () => {
  it('Accept-Language → ru / uk / en, anything else → en', () => {
    expect(storyTextLocale('uk')).toBe('uk');
    expect(storyTextLocale('ru-RU,ru;q=0.9')).toBe('ru');
    expect(storyTextLocale(['en-GB'])).toBe('en');
    for (const v of ['de', 'es', '', undefined, 'xx'])
      expect(storyTextLocale(v)).toBe('en');
  });
  it('consent texts exist in every language; ru is the versioned original', () => {
    expect(STORY_PARENT_CONSENT_TEXTS.ru).toBe(STORY_PARENT_CONSENT_TEXT);
    expect(STORY_RECORDING_CONSENT_TEXTS.ru).toBe(STORY_RECORDING_CONSENT_TEXT);
    for (const l of STORY_TEXT_LOCALES) {
      expect(STORY_PARENT_CONSENT_TEXTS[l].length).toBeGreaterThan(150);
      expect(STORY_RECORDING_CONSENT_TEXTS[l].length).toBeGreaterThan(150);
    }
    // The same providers are named in every translation.
    for (const t of Object.values(STORY_PARENT_CONSENT_TEXTS))
      expect(t).toMatch(/Resemble.*FFmpeg API.*Soniox/s);
    for (const t of Object.values(STORY_RECORDING_CONSENT_TEXTS))
      expect(t).toMatch(/FFmpeg API.*Soniox/s);
    expect(STORY_PARENT_CONSENT_TEXTS.uk).not.toMatch(/[ыэъ]/);
    expect(STORY_PARENT_CONSENT_TEXTS.en).not.toMatch(/[а-яё]/i);
  });
  it('every edition rights summary has a uk and an en translation', () => {
    for (const e of STORY_EDITIONS) {
      const t = STORY_RIGHTS_TEXTS[e.rightsSummary];
      expect([e.id, !!t?.uk && !!t?.en]).toEqual([e.id, true]);
      expect(t.en).not.toMatch(/[а-яё]/i);
    }
    const ru = STORY_CATALOG[0].rights;
    expect(storyRightsText(ru, 'ru')).toBe(ru);
    expect(storyRightsText(ru, 'en')).toBe(STORY_RIGHTS_TEXTS[ru].en);
  });
});

describe('ST3: catalogue rights in the request language', () => {
  it('service and controller', () => {
    const service = new StoryGiftsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { attemptDeadlineMs: 0 } as never,
      {} as never,
    );
    const uk = service.catalog('uk');
    expect(uk[0].rights).toBe(STORY_RIGHTS_TEXTS[STORY_CATALOG[0].rights].uk);
    expect(service.catalog()[0].rights).toBe(STORY_CATALOG[0].rights);
    const stub = { catalog: jest.fn(() => []) };
    const controller = new StoryGiftsController(
      stub as never,
      {} as never,
      {} as never,
    );
    controller.catalog({ headers: { 'accept-language': 'de' } } as never);
    expect(stub.catalog).toHaveBeenCalledWith('en');
  });
});
