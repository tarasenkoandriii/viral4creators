/** Local request recipe only: provider-managed model weights are not pinned. */
import { createHash } from 'crypto';
const MAX_CHARACTERS = 3000;
export interface ResembleSynthesisRecipe {
  version: 'resemble-request-v1';
  endpoint: 'https://f.cluster.resemble.ai/synthesize';
  modelSelection: 'provider-default-unpinned';
  mode: 'synchronous';
  normalization: 'trim-xml-escape-ssml-limit3000-v1';
  promptVersion: 'none';
  locale: string | null;
  outputFormat: 'mp3';
  requestTextSha256: string;
}
/** Язык реплик → локаль SSML Resemble. Только проверенные по списку
 * локалей документации; незнакомый язык — без обёртки, как раньше. */
const RESEMBLE_LOCALES: Record<string, string> = {
  uk: 'uk-ua',
  ru: 'ru-ru',
  en: 'en-us',
  de: 'de-de',
  es: 'es-es',
  fr: 'fr-fr',
  it: 'it-it',
  pl: 'pl-pl',
};

export function resembleLocale(
  language: string | null | undefined,
): string | undefined {
  const code = language?.trim().toLowerCase().split(/[-_]/)[0];
  return code ? RESEMBLE_LOCALES[code] : undefined;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function withLanguage(text: string, locale: string): string {
  return `<speak><lang xml:lang="${locale}">${escapeXml(text)}</lang></speak>`;
}

export function prepareResembleSpeech(
  text: string,
  language?: string | null,
): {
  payloadText: string;
  requestText: string;
  recipe: ResembleSynthesisRecipe;
} {
  text = text.trim();
  const locale = resembleLocale(language);
  let payloadText = text.slice(0, MAX_CHARACTERS);
  let requestText = locale ? withLanguage(payloadText, locale) : payloadText;
  if (requestText.length > MAX_CHARACTERS) {
    payloadText = payloadText.slice(
      0,
      payloadText.length - (requestText.length - MAX_CHARACTERS),
    );
    requestText = withLanguage(payloadText, locale!);
  }
  return {
    payloadText,
    requestText,
    recipe: {
      version: 'resemble-request-v1',
      endpoint: 'https://f.cluster.resemble.ai/synthesize',
      modelSelection: 'provider-default-unpinned',
      mode: 'synchronous',
      normalization: 'trim-xml-escape-ssml-limit3000-v1',
      promptVersion: 'none',
      locale: locale ?? null,
      outputFormat: 'mp3',
      requestTextSha256: createHash('sha256').update(requestText).digest('hex'),
    },
  };
}

export function parseResembleRecipe(
  raw: unknown,
): ResembleSynthesisRecipe | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    r.version !== 'resemble-request-v1' ||
    r.endpoint !== 'https://f.cluster.resemble.ai/synthesize' ||
    r.modelSelection !== 'provider-default-unpinned' ||
    r.mode !== 'synchronous' ||
    r.normalization !== 'trim-xml-escape-ssml-limit3000-v1' ||
    r.promptVersion !== 'none' ||
    (r.locale !== null && typeof r.locale !== 'string') ||
    r.outputFormat !== 'mp3' ||
    typeof r.requestTextSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.requestTextSha256)
  )
    return undefined;
  return {
    version: r.version,
    endpoint: r.endpoint,
    modelSelection: r.modelSelection,
    mode: r.mode,
    normalization: r.normalization,
    promptVersion: r.promptVersion,
    locale: r.locale,
    outputFormat: r.outputFormat,
    requestTextSha256: r.requestTextSha256,
  };
}
