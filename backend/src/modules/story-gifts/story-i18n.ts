/**
 * ST3: user-facing Story texts in the language of the request (the
 * `Accept-Language` header the TMA sends on every call, as in plans/billing):
 * ru / uk / en, anything else — en. Consent versions are the same for every
 * language; the language of the text shown is recorded with the consent.
 */
import {
  STORY_PARENT_CONSENT_TEXT,
  STORY_RECORDING_CONSENT_TEXT,
} from './story-video-plan';

export type StoryTextLocale = 'ru' | 'uk' | 'en';
export const STORY_TEXT_LOCALES: readonly StoryTextLocale[] = [
  'ru',
  'uk',
  'en',
];

export function storyTextLocale(
  header: string | string[] | undefined,
): StoryTextLocale {
  const raw = Array.isArray(header) ? header[0] : header;
  const primary = (raw ?? '').split(',')[0]?.trim().slice(0, 2).toLowerCase();
  return primary === 'ru' || primary === 'uk' || primary === 'en'
    ? primary
    : 'en';
}
export const storyTextLocaleOf = (req: {
  headers?: Record<string, string | string[] | undefined>;
}) => storyTextLocale(req.headers?.['accept-language']);

/** Version `story-parent-voice-v1`; uk/en are exact translations of ru. */
export const STORY_PARENT_CONSENT_TEXTS: Readonly<
  Record<StoryTextLocale, string>
> = {
  ru: STORY_PARENT_CONSENT_TEXT,
  uk: 'Підтверджую: це мій голос або я маю явний дозвіл його власника. Дозволяю використовувати обраний клон для окремого озвучення тексту «Ріпки» та преамбули через Resemble; складання відео через FFmpeg API та перевірку мовлення через Soniox. Одержувачі посилання зможуть почути голос після мого схвалення відео.',
  en: 'I confirm: this is my voice or I have explicit permission from its owner. I allow the selected clone to be used for a separate narration of the text of «The Turnip» and of the preamble via Resemble; for video assembly via FFmpeg API and for speech checking via Soniox. Recipients of the link will be able to hear the voice after I approve the video.',
};

/** Version `story-preamble-recording-v1`; uk/en are exact translations of ru. */
export const STORY_RECORDING_CONSENT_TEXTS: Readonly<
  Record<StoryTextLocale, string>
> = {
  ru: STORY_RECORDING_CONSENT_TEXT,
  uk: 'Підтверджую: на записі мій голос або я маю явний дозвіл людини, яка говорить. Запис зберігається приватно в цьому подарунку і використовується лише як вступ цієї казки: для складання відео він передається за тимчасовим посиланням у FFmpeg API, для перевірки мовлення готового відео — у Soniox. Голос не клонується. Одержувачі почують запис лише після мого окремого схвалення відео.',
  en: 'I confirm: the recording is my voice or I have explicit permission from the person speaking. The recording is stored privately in this gift and is used only as the intro of this story: for video assembly it is passed via a temporary link to FFmpeg API, and for checking the speech of the finished video — to Soniox. The voice is not cloned. Recipients will hear the recording only after I separately approve the video.',
};

/**
 * Catalogue `rights` (the edition's `rightsSummary`, written in Russian) in
 * uk/en, keyed by the exact Russian text — a new or changed summary without
 * a translation fails the test.
 */
export const STORY_RIGHTS_TEXTS: Readonly<
  Record<string, Readonly<Record<'uk' | 'en', string>>>
> = {
  'Народная сказка в обработке К. Д. Ушинского (1824–1871). Точный текст по изданию 1949 года, с. 45–46; без сокращений и новой морали. Используется текст автора в общественном достоянии, без редакционных комментариев и иллюстраций издания.':
    {
      uk: 'Народна казка в обробці К. Д. Ушинського (1824–1871). Точний текст за виданням 1949 року, с. 45–46; без скорочень і нової моралі. Використовується текст автора в суспільному надбанні, без редакційних коментарів та ілюстрацій видання.',
      en: "A folk tale as retold by K. D. Ushinsky (1824–1871). The exact text of the 1949 edition, pp. 45–46; no abridgement and no new moral. The author's public-domain text is used, without the edition's editorial comments or illustrations.",
    },
  'Оригинальный текст платформы, редакция 1. Не адаптация стороннего издания.':
    {
      uk: 'Оригінальний текст платформи, редакція 1. Не адаптація стороннього видання.',
      en: 'An original platform text, revision 1. Not an adaptation of a third-party edition.',
    },
  'Короткий авторский пересказ народного сюжета. Мягкий финал; не текст современного издания.':
    {
      uk: 'Короткий авторський переказ народного сюжету. М’який фінал; не текст сучасного видання.',
      en: 'A short original retelling of a folk plot. A gentle ending; not the text of a modern edition.',
    },
  'Казка Івана Франка (1856–1916). Точный текст по 4-му изданию (Киев, 1918), с. 3–14; без сокращений и новой морали. Иллюстрации Г. Павловича и оформление издания не используются.':
    {
      uk: 'Казка Івана Франка (1856–1916). Точний текст за 4-м виданням (Київ, 1918), с. 3–14; без скорочень і нової моралі. Ілюстрації Г. Павловича та оформлення видання не використовуються.',
      en: "A tale by Ivan Franko (1856–1916). The exact text of the 4th edition (Kyiv, 1918), pp. 3–14; no abridgement and no new moral. H. Pavlovych's illustrations and the edition's design are not used.",
    },
  'Украинская народная сказка в записи А. Я. Рудченко (Миргород); «Народныя южнорусскія сказки», вып. 2, изд. И. Рудченко, Киев, 1870, с. 1–2. Точный текст в орфографии издания, без новой морали. Финал не смягчён: стрелец стреляет в рукавичку, и звери гибнут.':
    {
      uk: 'Українська народна казка в записі А. Я. Рудченка (Миргород); «Народныя южнорусскія сказки», вип. 2, вид. І. Рудченка, Київ, 1870, с. 1–2. Точний текст в орфографії видання, без нової моралі. Фінал не пом’якшено: стрілець стріляє в рукавичку, і звірі гинуть.',
      en: 'A Ukrainian folk tale recorded by A. Ya. Rudchenko (Myrhorod); «Narodnyia yuzhnorusskiia skazki», issue 2, ed. I. Rudchenko, Kyiv, 1870, pp. 1–2. The exact text in the spelling of the edition, no new moral. The ending is not softened: the hunter shoots at the mitten and the animals die.',
    },
};

export function storyRightsText(ru: string, locale: StoryTextLocale): string {
  return locale === 'ru' ? ru : (STORY_RIGHTS_TEXTS[ru]?.[locale] ?? ru);
}
