import {
  storyNarrationCaption,
  storyPublicPageHtml,
  storyReleaseParts,
} from './story-public-page';

const gift = (locale: string) => ({
  locale,
  title: 'Ріпка',
  occasion: null,
  giftNote: null,
  giftNotePosition: null,
  hasGiftPhoto: true,
  chapters: [{ title: 'Глава', text: 'Текст', scene: 'turnip' }],
  shareExpiresAt: new Date('2027-01-18T00:00:00Z'),
});

describe('ST3-R-10/U-14: public gift page language and narration caption', () => {
  it('the page speaks the language of the story (uk/en/ru; others → ru)', () => {
    const uk = storyPublicPageHtml({
      token: 't',
      gift: gift('uk'),
      video: null,
      awaitingConsent: false,
    });
    expect(uk).toContain('<html lang="uk">');
    expect(uk).toContain('На добраніч.');
    expect(uk).toContain('Аудіоподарунок');
    expect(uk).toContain('посилання діє до 2027-01-18');
    expect(uk).not.toMatch(/Спокойной ночи|Сказка одобрена/);
    const en = storyPublicPageHtml({
      token: 't',
      gift: gift('en'),
      video: null,
      awaitingConsent: false,
    });
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Good night.');
    expect(
      storyPublicPageHtml({
        token: 't',
        gift: gift('de'),
        video: null,
        awaitingConsent: false,
      }),
    ).toContain('<html lang="ru">');
  });
  it('the caption names the real parts: Nova / profile voice / live recorded intro / image', () => {
    const live = storyReleaseParts({
      userVoiceId: null,
      segments: { segments: [{ source: 'recorded' }, { source: 'gift' }] },
    });
    expect(live).toEqual({
      profileVoice: false,
      recordedIntro: true,
      narratorImage: false,
    });
    const ru = storyNarrationCaption('ru', live);
    expect(ru).toContain('синтетический голос Nova');
    expect(ru).toContain('живая запись взрослого');
    const profile = storyNarrationCaption(
      'uk',
      storyReleaseParts({ userVoiceId: 'v', segments: { narrator: {} } }),
    );
    expect(profile).toContain('голос оповідача з профілю');
    expect(profile).toContain('зображення оповідача');
    expect(profile).not.toContain('Nova');
    expect(storyNarrationCaption('en', null)).toContain('Nova');
  });
  it('a video release: video tag; a release waiting for consent: no video, no «audio gift» label', () => {
    const video = storyPublicPageHtml({
      token: 'tok',
      gift: gift('ru'),
      video: { userVoiceId: null, segments: null },
      awaitingConsent: false,
    });
    expect(video).toContain('src="./tok/video"');
    expect(video).toContain('Видеоподарок');
    const waiting = storyPublicPageHtml({
      token: 'tok',
      gift: gift('ru'),
      video: null,
      awaitingConsent: true,
    });
    expect(waiting).not.toContain('<video');
    expect(waiting).not.toContain('Аудиоподарок');
    expect(waiting).toContain('после подтверждения создателя');
  });
  it('escapes the title and keeps noindex meta', () => {
    const html = storyPublicPageHtml({
      token: 't',
      gift: { ...gift('ru'), title: '<b>x</b>' },
      video: null,
      awaitingConsent: false,
    });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain(
      '<meta name="robots" content="noindex,nofollow,noarchive">',
    );
  });
});
