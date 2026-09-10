/**
 * ProductRecognitionService — category (and a suggested title) from the
 * product photo. doc/PRODUCT-PROJECT-SPEC.md §6.1 ("автоматически
 * определяется категория товара — аналогично SilverFinance") and §9.4
 * (decided: free text, no fixed taxonomy).
 *
 * PORTED PATTERN, not code, from SilverFinance `src/lib/server/recognize.ts`
 * (`recognizeItem`): a vision LLM is shown the photo and asked for STRICT
 * JSON `{ title, category, ... }`, then the reply is parsed defensively
 * (strip ```json fences, take the first {...} block, fall back on garbage).
 * That is exactly where SilverFinance's category comes from — Google Lens
 * itself has no category field, so the answer to the spec's "уточнить
 * точный источник при переносе кода" is: a vision-LLM call, not Lens.
 *
 * Differences from the original:
 *  - Gemini (`@google/genai`, GEMINI_API_KEY already in this backend)
 *    instead of xAI Grok — the spec's standing rule is "no new AI
 *    service/key when Gemini can do it" (§6.2). Same model the analysis
 *    step already uses.
 *  - Category is FREE TEXT (§9.4), not SilverFinance's fixed
 *    coins|bullion|jewelry|... enum — that enum is specific to a precious-
 *    metals auction; an ad generator sells anything.
 *  - No price estimate: the market price comes from the Lens analogs
 *    (§4 Экран 5), not from the model's guess.
 *  - Input is a public URL (the photo is already in Blob for Lens), not a
 *    base64 data-URL — Gemini fetches it via `fileData.fileUri`… except
 *    that Gemini's URL fetching is limited to specific hosts, so we
 *    download the bytes ourselves and send `inlineData` (photos are
 *    ≤10 MB, well under the 20 MB inline cap).
 *
 * Never throws: a recognition failure must not block the photo flow
 * (spec §7.4 — category is a convenience, never a gate). Returns
 * `{ category: null, title: null, reason }` instead.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { AudienceProfile } from '../../common/types/audience.types';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { languageNameForLocale, normalizeLocale } from '../../common/locale';

export interface RecognitionResult {
  /** Short free-text product category, e.g. "кроссовки" / "running shoes". */
  category: string | null;
  /** Short product name — used to prefill ProductItem.title when empty. */
  title: string | null;
  /** Who buys this (spec §18, Stage 23) — null when the model gave nothing usable. */
  audience: AudienceProfile | null;
  reason?: string;
}

const MODEL = GEMINI_MODEL;

/**
 * Этап 59 (ТЗ §35.5): язык больше не "русский, если на упаковке нет
 * текста" (жёсткий фолбэк был осмыслен только до появления реального
 * сигнала о языке пользователя) — теперь явный целевой язык UI-локали
 * пользователя. НО `title` — сознательное исключение: это название
 * товара, СЧИТАННОЕ с упаковки/фото (SilverFinance-паттерн, см. заголовок
 * файла), а не аналитическая проза модели — переводить собственное имя
 * товара («SuperBelly Mango Passion Fruit» → нечто на немецком) исказило
 * бы то, что реально написано на коробке. `category`/`audience` — это
 * УЖЕ анализ модели для продавца, их и переводим на его язык.
 */
function buildRecognitionPrompt(languageName: string): string {
  return (
    'Определи товар на фото для продавца, который готовит рекламу этого товара. ' +
    'Верни СТРОГО валидный JSON без markdown ровно такой формы: ' +
    '{"title":"короткое название товара (до 60 символов)","category":"короткая категория товара, 1-3 слова, свободным текстом",' +
    '"audience":{"ageRange":"основной возраст покупателей, напр. \"25-34\" или \"35-44 и 45+\"","gender":"women | men | any",' +
    '"interests":["3-6 коротких тегов интересов/ситуаций покупки"],"summary":"1-2 предложения: кто покупает этот товар и зачем"}}. ' +
    'Аудитория — про ПОКУПАТЕЛЯ товара, не про людей на фото. ' +
    `"title" — так, как написано на фото/упаковке товара, на языке оригинала, БЕЗ перевода (это считанное название, не анализ). ` +
    `Если на упаковке нет читаемого текста — придумай короткое название на ${languageName}. ` +
    `"category" и "audience.summary"/"interests" — ВСЕГДА на ${languageName}, независимо от языка на упаковке: это анализ для продавца, не цитата с фото. ` +
    'Если товар неясен — всё равно дай лучшую догадку. Только JSON.'
  );
}

const GENDERS: ReadonlySet<string> = new Set(['women', 'men', 'any']);

/** Audience block of the recognition answer → AudienceProfile (null when empty). Exported for tests. */
export function parseAudienceBlock(raw: unknown): AudienceProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = (v: unknown, max: number): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
  };
  const g = (text(o.gender, 20) ?? '').toLowerCase();
  const gender = GENDERS.has(g)
    ? (g as AudienceProfile['gender'])
    : /^(female|woman|женщины|жен)/.test(g)
      ? 'women'
      : /^(male|man|мужчины|муж)/.test(g)
        ? 'men'
        : /^(all|mixed|both|любой|все|оба)/.test(g)
          ? 'any'
          : null;
  const interests = Array.isArray(o.interests)
    ? o.interests
        .map((x) => text(x, 40))
        .filter((x): x is string => !!x)
        .slice(0, 8)
    : [];
  const profile: AudienceProfile = {
    ageRange: text(o.ageRange ?? o.age, 80),
    gender,
    interests,
    summary: text(o.summary ?? o.description, 600),
    source: 'gemini',
  };
  return profile.ageRange || gender || interests.length || profile.summary
    ? profile
    : null;
}

/**
 * Pure parser — exported for tests. Mirrors SilverFinance's robust parse:
 * strip fences, slice to the first {...} block, JSON.parse, coerce fields.
 */
export function parseRecognition(content: string): RecognitionResult {
  let raw = String(content || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      category: null,
      title: null,
      audience: null,
      reason: `model returned non-JSON: ${String(content).slice(0, 120)}`,
    };
  }
  const clean = (v: unknown, max: number): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
  };
  return {
    category: clean(parsed.category, 60),
    title: clean(parsed.title, 120),
    audience: parseAudienceBlock(parsed.audience),
  };
}

@Injectable()
export class ProductRecognitionService {
  private readonly logger = new Logger(ProductRecognitionService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(private readonly aiUsage: AiUsageService) {
    // Ключ передаётся SDK явно (этап 53, В-6.15); без ключа сервис честно
    // отказывает на своём эндпоинте, а не роняет запуск.
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  async recognize(
    photo: Buffer,
    mimeType: string,
    /** Чей это расход (ТЗ §26) — маршрут фото товара идёт под идентичностью. */
    owner?: { userId?: string | null },
    /** UI-локаль продавца (этап 59, ТЗ §35.5) — по умолчанию DEFAULT_LOCALE. */
    locale?: string,
  ): Promise<RecognitionResult> {
    if (!this.genai) {
      return {
        category: null,
        title: null,
        audience: null,
        reason: 'GEMINI_API_KEY not set',
      };
    }
    try {
      const languageName = languageNameForLocale(normalizeLocale(locale));
      const response = await this.genai.models.generateContent({
        model: MODEL,
        contents: [
          { inlineData: { mimeType, data: photo.toString('base64') } },
          { text: buildRecognitionPrompt(languageName) },
        ],
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'product-photo',
        model: MODEL,
        userId: owner?.userId ?? null,
      });
      const result = parseRecognition(response?.text ?? '');
      if (result.reason)
        this.logger.warn(`recognition parse: ${result.reason}`);
      return result;
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'gemini error';
      this.logger.error(`recognition failed: ${reason}`);
      return { category: null, title: null, audience: null, reason };
    }
  }
}
