/**
 * ST3-R-10/U-14: the public gift page — in the language of the story
 * (ru/uk/en; other → ru) and with a narration caption built from the parts
 * that are really in the release: Nova or a profile voice for the speech, a
 * live recording of the adult in the intro, a narrator image. Pure.
 */
import { escapeStoryHtml as esc, storyIllustration } from './story-catalog';

export type StoryPageLocale = 'ru' | 'uk' | 'en';
export const storyPageLocale = (locale: string): StoryPageLocale =>
  locale === 'uk' || locale === 'en' ? locale : 'ru';

export interface StoryReleaseParts {
  /** Main speech by a profile voice clone (else Nova). */
  profileVoice: boolean;
  /** The intro is the adult's own live recording. */
  recordedIntro: boolean;
  /** The intro frame shows the narrator image. */
  narratorImage: boolean;
}

/** Parts of a render from its stored manifest. */
export function storyReleaseParts(render: {
  userVoiceId?: string | null;
  segments?: unknown;
}): StoryReleaseParts {
  const m = render.segments as {
    segments?: Array<{ source?: string } | null>;
    narrator?: unknown;
  } | null;
  return {
    profileVoice: !!render.userVoiceId,
    recordedIntro:
      !!m &&
      Array.isArray(m.segments) &&
      m.segments.some((s) => s?.source === 'recorded'),
    narratorImage: !!m && !!m.narrator,
  };
}

const T = {
  ru: {
    title: 'Story‑Tales — сказка',
    video: 'Видеоподарок',
    audio: 'Аудиоподарок',
    gift: 'Подарок',
    nova: 'Основная озвучка — синтетический голос Nova.',
    profile: 'Основная озвучка — синтетический голос рассказчика из профиля.',
    introLive: 'Вступление — живая запись взрослого.',
    introSynth: 'Вступление озвучено тем же синтетическим голосом.',
    image: 'В начале — изображение рассказчика.',
    note: 'Включает подготовленное взрослым обращение, если оно было добавлено.',
    mp3: 'Основная озвучка отдельно (MP3)',
    pending: 'Видео к этой сказке появится после подтверждения создателя.',
    photo: 'Подарок к сказке',
    photoAlt: 'Физический подарок, добавленный создателем',
    night: 'Спокойной ночи.',
    footer:
      'Сказка одобрена создателем. Доступна любому, у кого есть ссылка; поисковая индексация запрещена. Создатель может отозвать ссылку',
    until: 'ссылка действует до',
  },
  uk: {
    title: 'Story‑Tales — казка',
    video: 'Відеоподарунок',
    audio: 'Аудіоподарунок',
    gift: 'Подарунок',
    nova: 'Основне озвучення — синтетичний голос Nova.',
    profile: 'Основне озвучення — синтетичний голос оповідача з профілю.',
    introLive: 'Вступ — живий запис дорослого.',
    introSynth: 'Вступ озвучено тим самим синтетичним голосом.',
    image: 'На початку — зображення оповідача.',
    note: 'Містить звернення, підготоване дорослим, якщо його було додано.',
    mp3: 'Основне озвучення окремо (MP3)',
    pending: 'Відео до цієї казки з’явиться після підтвердження автора.',
    photo: 'Подарунок до казки',
    photoAlt: 'Фізичний подарунок, доданий автором',
    night: 'На добраніч.',
    footer:
      'Казку схвалив автор. Доступна кожному, хто має посилання; індексацію пошуковими системами заборонено. Автор може відкликати посилання',
    until: 'посилання діє до',
  },
  en: {
    title: 'Story‑Tales — a story',
    video: 'Video gift',
    audio: 'Audio gift',
    gift: 'Gift',
    nova: 'Main narration — the synthetic voice Nova.',
    profile: 'Main narration — a synthetic narrator voice from the profile.',
    introLive: 'The intro is a live recording by the adult.',
    introSynth: 'The intro is read by the same synthetic voice.',
    image: 'The intro shows the narrator image.',
    note: 'Includes a message prepared by the adult, if one was added.',
    mp3: 'Main narration separately (MP3)',
    pending:
      'The video for this story will appear once its creator confirms it.',
    photo: 'A gift with the story',
    photoAlt: 'A physical gift added by the creator',
    night: 'Good night.',
    footer:
      'Approved by its creator. Anyone with the link can open it; search engine indexing is not allowed. The creator can revoke the link',
    until: 'the link is valid until',
  },
} as const;

/** Narration caption from the real parts (no «Nova» when it is not Nova). */
export function storyNarrationCaption(
  locale: string,
  parts: StoryReleaseParts | null,
): string {
  const t = T[storyPageLocale(locale)];
  if (!parts) return `${t.nova} ${t.note}`;
  return [
    parts.profileVoice ? t.profile : t.nova,
    parts.recordedIntro ? t.introLive : t.introSynth,
    ...(parts.narratorImage ? [t.image] : []),
    t.note,
  ].join(' ');
}

export function storyPublicPageHtml(input: {
  token: string;
  gift: {
    locale: string;
    title: string;
    occasion: string | null;
    giftNote: string | null;
    giftNotePosition: string | null;
    hasGiftPhoto: boolean;
    chapters: unknown;
    shareExpiresAt: Date | null;
  };
  /** The served video release, if any. */
  video: { userVoiceId?: string | null; segments?: unknown } | null;
  /** A video release waits for the narrator's consent (ST3-S-04). */
  awaitingConsent: boolean;
}): string {
  const { token, gift, video, awaitingConsent } = input;
  const lang = storyPageLocale(gift.locale);
  const t = T[lang];
  const parts = video ? storyReleaseParts(video) : null;
  const chapters = gift.chapters as Array<{
    title: string;
    text: string;
    scene: string;
  }>;
  const kind = video ? t.video : awaitingConsent ? t.gift : t.audio;
  const media = video
    ? `<video controls playsinline preload="metadata" style="width:100%;border-radius:18px" src="./${token}/video"></video>${video.userVoiceId ? '' : `<p><a style="color:inherit" href="./${token}/audio">${t.mp3}</a></p>`}`
    : `<audio controls preload="none" src="./${token}/audio"></audio>${awaitingConsent ? `<p>${t.pending}</p>` : ''}`;
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${t.title}</title><style>body{margin:auto;max-width:760px;padding:24px;background:#102b35;color:#f6ebd7;font:18px/1.7 system-ui}svg{width:100%;height:auto}audio{width:100%}section{margin:36px 0}h1,h2{line-height:1.2}small{opacity:.8}</style><main><small>Story‑Tales · ${kind}</small><h1>${esc(gift.title)}</h1>${gift.occasion ? `<p>${esc(gift.occasion)}</p>` : ''}<p>${storyNarrationCaption(lang, parts)}</p>${media}${gift.giftNote && gift.giftNotePosition === 'beginning' ? `<p>${esc(gift.giftNote)}</p>` : ''}${chapters.map((c) => `<section>${storyIllustration(c.scene)}<h2>${esc(c.title)}</h2><p>${esc(c.text)}</p></section>`).join('')}${gift.giftNote && gift.giftNotePosition === 'end' ? `<p>${esc(gift.giftNote)}</p>` : ''}${gift.hasGiftPhoto ? `<section><h2>${t.photo}</h2><img style="max-width:100%;border-radius:16px" src="./${token}/photo" alt="${t.photoAlt}" loading="lazy"></section>` : ''}<p>${t.night}</p><small>${t.footer}${gift.shareExpiresAt ? `; ${t.until} ${esc(gift.shareExpiresAt.toISOString().slice(0, 10))}` : ''}.</small></main></html>`;
}
