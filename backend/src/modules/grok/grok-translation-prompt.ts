/**
 * Промпт-находка solar-shop, переносимая ОТДЕЛЬНО от батч-клиента (ТЗ
 * §35.1): в промпт перевода язык нужно передавать ЯВНЫМ названием
 * («Ukrainian»), а не голым ISO-кодом («uk») — модель может прочитать
 * `uk` как United Kingdom (Великобритания), а не украинский. Это не
 * гипотетический риск — реальная, найденная и исправленная в solar-shop
 * причина, по которой переводы там молчаливо оставались английскими
 * (`grok.service.ts`, `LOCALE_LANGUAGE_NAMES`).
 *
 * Этап 59 (ТЗ §35.5/§38): та же находка понадобилась ЗА ПРЕДЕЛАМИ блога —
 * `AnalysisService`/`ProductRecognitionService`/`RelevanceService`/
 * `VideoAuditService` теперь тоже локализуют свой ИИ-вывод под UI-локаль
 * пользователя, поэтому `LOCALE_LANGUAGE_NAMES`/`languageNameForLocale`
 * переехали в общий `common/locale.ts` — здесь только ре-экспорт, чтобы не
 * трогать существующие импорты (`grok-translation-prompt.spec.ts` и
 * вызовы ниже в этом файле продолжают работать как раньше).
 */
export {
  LOCALE_LANGUAGE_NAMES,
  languageNameForLocale,
} from '../../common/locale';
import { languageNameForLocale } from '../../common/locale';

export interface ArticleTranslationPromptInput {
  targetLocale: string;
  title: string;
  bodyHtml: string;
}

/**
 * Промпт перевода одной статьи блога — используется при сборке элементов
 * пачки для GrokBatchService.submitBatch (этап 57, ArticleTranslation
 * ещё не существует, поэтому здесь только билдер, без обвязки БД).
 * `response_format: json_object` (см. GrokBatchRequestItem) держит ответ
 * разбираемым — этот промпт САМ описывает форму JSON именно поэтому.
 */
export function buildArticleTranslationPrompt(
  input: ArticleTranslationPromptInput,
): string {
  const languageName = languageNameForLocale(input.targetLocale);
  return [
    `Translate the following blog article into ${languageName}.`,
    'Preserve meaning and tone. Preserve HTML markup exactly — translate text content only, never tag names or attributes.',
    'Respond with a single JSON object of the exact shape: {"title": string, "bodyHtml": string}. No other text.',
    '',
    `TITLE:\n${input.title}`,
    '',
    `BODY_HTML:\n${input.bodyHtml}`,
  ].join('\n');
}
