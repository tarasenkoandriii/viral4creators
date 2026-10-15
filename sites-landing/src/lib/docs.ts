import fs from 'node:fs';
import path from 'node:path';
import { BRAND_IS_PLACEHOLDER, brandDisplayName, PRODUCT_NAMES, WIDGET_NAMES } from '../brand';
import { ASSISTANT_WORD } from './get-dictionary';
import { assistEnv, type AssistEnv } from './assist-env';
import { parseDoc, substitute, type ParsedDoc } from './docs-markdown';
import type { Locale } from './i18n';
import {
  cspLines,
  embedTag,
  goalCall,
  goalMarkup,
  gtmHtml,
  nextScript,
  robotsBlock,
  spaInject,
  verifyExamples,
  webhookNodeExample,
  wordpressHook,
  SIGNATURE_FORMAT,
} from './install';
import type { DocsKey } from './pages';

/**
 * Документация установки (Л5, §3.13): Markdown в
 * `sites-landing/docs/assistant/<локаль>/<файл>.md`, читается при сборке
 * (страницы статические). Плейсхолдеры `%%имя%%` и блоки `gen:` — из
 * `brand.ts` и `lib/install.ts` (сверены с продуктом тестом).
 */
export const DOC_FILES: Record<DocsKey, string> = {
  docs: 'install',
  'docs-js-api': 'js-api',
  'docs-goals': 'goals',
  'docs-csp': 'csp',
};

/** `%%brand%%` — имя на языке документа (`brandDisplayName`, Р-З15-1). */
export function docVars(env: Pick<AssistEnv, 'widgetOrigin' | 'apiOrigin'>, locale: Locale): Record<string, string> {
  const v = verifyExamples();
  return {
    brand: brandDisplayName(locale),
    global: WIDGET_NAMES.global,
    anchor: WIDGET_NAMES.anchor,
    loaderPath: WIDGET_NAMES.loaderPath,
    widgetOrigin: env.widgetOrigin,
    loaderUrl: `${env.widgetOrigin}${WIDGET_NAMES.loaderPath}`,
    webhookPath: '/assist/v1/sites/<SITE_ID>/goal-events',
    signatureHeader: PRODUCT_NAMES.webhookSignatureHeader,
    signatureFormat: SIGNATURE_FORMAT,
    npmPackage: PRODUCT_NAMES.npmPackage,
    wpPluginSlug: PRODUCT_NAMES.wpPluginSlug,
    goalAttr: PRODUCT_NAMES.goalAttr,
    goalSubmitAttr: PRODUCT_NAMES.goalSubmitAttr,
    verifyDnsName: v.dnsName,
    verifyDnsValue: v.dnsValue,
    verifyFileUrl: v.fileUrl,
    verifyMeta: v.meta,
    verifyFilePath: PRODUCT_NAMES.verifyFilePath,
    robotsToken: PRODUCT_NAMES.crawlerRobotsToken,
  };
}

export function docGenerators(env: Pick<AssistEnv, 'widgetOrigin' | 'apiOrigin'>): Record<string, () => string> {
  return {
    embedTag: () => embedTag(env.widgetOrigin),
    gtm: () => gtmHtml(env.widgetOrigin),
    wordpress: () => wordpressHook(env.widgetOrigin),
    next: () => nextScript(env.widgetOrigin),
    spa: () => spaInject(env.widgetOrigin),
    csp: () => cspLines(env.widgetOrigin),
    goal: () => goalCall(),
    goalMarkup: () => goalMarkup(),
    webhook: () => webhookNodeExample(`${env.apiOrigin}/assist/v1/sites/SITE_ID/goal-events`),
    robots: () => robotsBlock(),
    verifyMeta: () => verifyExamples().meta,
  };
}

export function docsDir(root: string = process.cwd()): string {
  return path.join(root, 'docs', 'assistant');
}

export function loadDoc(key: DocsKey, locale: Locale, opts: { root?: string; env?: Pick<AssistEnv, 'widgetOrigin' | 'apiOrigin'> } = {}): ParsedDoc {
  const env = opts.env ?? assistEnv();
  const raw = untautologize(fs.readFileSync(path.join(docsDir(opts.root), locale, `${DOC_FILES[key]}.md`), 'utf8'));
  return parseDoc(substitute(raw, { ...docVars(env, locale), loc: locale }), docGenerators(env));
}

/**
 * Р-З15-1: пока бренд — заглушка, заголовок, который уже называет
 * помощника, не повторяет родовое имя суффиксом («Встановлення
 * ШІ-помічника — документація «ШІ-помічник для сайту»» → «… — документація»).
 */
export function untautologize(raw: string): string {
  if (!BRAND_IS_PLACEHOLDER) return raw;
  return raw.replace(/^(title: .*) — (?:документація «%%brand%%»|%%brand%% docs)$/m, (line, head: string) =>
    ASSISTANT_WORD.test(head) ? `${head} — ${line.includes('документація') ? 'документація' : 'docs'}` : line,
  );
}
