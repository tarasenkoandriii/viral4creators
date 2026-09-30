/**
 * Явный выбор провайдера синтеза голоса (контракт S-FE «Soniox как голос
 * дубляжа/озвучки»): бренд-бук, снимок сессии в мастере и переозвучка.
 *
 * Чистая логика вынесена сюда, а не в компоненты, потому что правило
 * «Soniox можно без voiceId» и правило «что именно сохранить как тег»
 * нужны в трёх местах сразу, и расхождение между ними — это ролик,
 * озвученный не тем голосом, который человек слышал в пробе.
 */

/** Зеркалит backend/src/modules/tts/default-tts-provider.ts EXPLICIT_TTS_PROVIDER_KEYS. */
export const EXPLICIT_TTS_PROVIDERS = [
  'elevenlabs',
  'resemble',
  'soniox',
] as const;

export type ExplicitTtsProvider = (typeof EXPLICIT_TTS_PROVIDERS)[number];

/**
 * Тег голоса из ответа сервера → значение селектора. Строка — потому что
 * `ttsProvider` в ответе типизирован как `string` (исторически там мог
 * оказаться и `'veo'`); всё, что не настоящий провайдер синтеза,
 * показываем как «по умолчанию», а не как несуществующий пункт.
 */
export function parseExplicitProvider(
  value: string | null | undefined
): ExplicitTtsProvider | null {
  return (EXPLICIT_TTS_PROVIDERS as readonly string[]).includes(value ?? '')
    ? (value as ExplicitTtsProvider)
    : null;
}

/**
 * Можно ли синтезировать речь без выбранного voiceId. У Soniox есть свой
 * голос по умолчанию (`SONIOX_TTS_VOICE` на сервере), а у ElevenLabs и
 * Resemble без идентификатора голоса синтеза нет вовсе.
 */
export function allowsDefaultVoice(
  provider: string | null | undefined
): boolean {
  return provider === 'soniox';
}

/** Есть чем озвучить: выбран голос либо провайдер обходится без него. */
export function hasSynthesisVoice(
  voiceId: string,
  provider: string | null | undefined
): boolean {
  return voiceId.trim().length > 0 || allowsDefaultVoice(provider);
}

/**
 * Какой тег реально окажется на голосе после сохранения. Сервер без
 * voiceId тег обнуляет — кроме Soniox («голос по умолчанию»), — поэтому
 * и сравнение «есть ли несохранённые правки» идёт по этому значению, а
 * не по сырому выбору: иначе ElevenLabs без голоса вечно висел бы
 * «несохранённым», хотя сохранять там нечего.
 */
export function savedProviderTag(
  provider: ExplicitTtsProvider | null,
  voiceId: string
): ExplicitTtsProvider | null {
  if (!provider) return null;
  return hasSynthesisVoice(voiceId, provider) ? provider : null;
}

/**
 * Предупреждать ли, что голос выпущен другим провайдером, чем тот, чей
 * каталог сейчас открыт. Явный выбор провайдера — осознанное решение
 * (и синтез пойдёт именно по нему), так что при нём предупреждение —
 * шум, а не сигнал.
 */
export function showProviderMismatch(args: {
  explicitProvider: string | null | undefined;
  voiceId: string;
  voiceProvider: string | null | undefined;
  catalogueProvider: string | null | undefined;
}): boolean {
  const { explicitProvider, voiceId, voiceProvider, catalogueProvider } = args;
  if (explicitProvider) return false;
  if (!voiceId || !voiceProvider || !catalogueProvider) return false;
  return voiceProvider !== catalogueProvider;
}

/**
 * Показывать ли пометку «у Soniox нет пословного тайминга субтитров».
 * Провайдер — явный выбор, а без него тот, что активен на стенде (из
 * ответа каталога): субтитры в обоих случаях построятся без слов.
 */
export function lacksWordTiming(
  explicitProvider: string | null | undefined,
  catalogueProvider: string | null | undefined
): boolean {
  return (explicitProvider || catalogueProvider) === 'soniox';
}

/**
 * Провайдер, которым реально пойдёт синтез: явный выбор на экране, иначе
 * тег, уже сохранённый на голосе. Каталог, проба и пометки пикера должны
 * смотреть на него же — иначе снимок «Soniox по умолчанию» на стенде с
 * ElevenLabs показывал бы каталог ElevenLabs, а звучал бы Soniox.
 */
export function effectiveProvider(
  override: ExplicitTtsProvider | null | undefined,
  savedTag: string | null | undefined
): ExplicitTtsProvider | null {
  return override ?? parseExplicitProvider(savedTag);
}

// ── Голос Soniox у отправителя поздравления (S2-FE) ─────────────────────

/** Языки поздравления — зеркало `GreetingScriptLanguage` (types/project.ts). */
export type SonioxGreetingLanguage = 'ru' | 'uk' | 'en' | 'de' | 'es';

const SONIOX_GREETING_LANGUAGES: readonly SonioxGreetingLanguage[] = [
  'ru',
  'uk',
  'en',
  'de',
  'es',
];

/**
 * Фраза пробы голоса — на языке ПОЗДРАВЛЕНИЯ, а не интерфейса: человек
 * выбирает, как прозвучит ролик, и русская проба голосом, которым затем
 * заговорит немецкое поздравление, обещала бы не то. Поэтому фразы здесь,
 * а не в словаре интерфейса (словарь следует языку экрана). Soniox язык
 * синтеза определяет по тексту, отдельного поля у пробы нет.
 */
export const SONIOX_PREVIEW_PHRASES: Readonly<
  Record<SonioxGreetingLanguage, string>
> = {
  ru: 'Привет! Так прозвучит твоё поздравление.',
  uk: 'Привіт! Так звучатиме твоє привітання.',
  en: 'Hi! This is how your greeting will sound.',
  de: 'Hallo! So wird dein Glückwunsch klingen.',
  es: '¡Hola! Así sonará tu felicitación.',
};

/**
 * Язык поздравления: выбранный в брифе, иначе язык интерфейса сессии
 * (так пишет сценарий сервер, когда `scriptLanguage` не задан), иначе
 * русский — основной язык продукта.
 */
export function greetingVoiceLanguage(
  scriptLanguage: string | null | undefined,
  uiLocale: string | null | undefined
): SonioxGreetingLanguage {
  const known = (v: string | null | undefined) =>
    (SONIOX_GREETING_LANGUAGES as readonly string[]).includes(v ?? '')
      ? (v as SonioxGreetingLanguage)
      : null;
  return known(scriptLanguage) ?? known(uiLocale) ?? 'ru';
}

export function sonioxPreviewText(language: SonioxGreetingLanguage): string {
  return SONIOX_PREVIEW_PHRASES[language];
}
