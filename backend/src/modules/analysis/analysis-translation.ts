/**
 * Перевод уже готового разбора видео на UI-локаль пользователя (этап 59,
 * ТЗ §35.5 — открытый вопрос 35.2 решён в пользу "перевести готовый
 * результат", не "сгенерировать сразу на целевом языке"). Причина решения
 * — экономика общей библиотеки разборов (§21): один и тот же разбор
 * переиспользуется БЕСПЛАТНО любым будущим пользователем с тем же
 * исходником, независимо от локали (`LibraryService`/`AnalysisLibraryEntry`
 * не хранят локаль вообще). Если бы разбор сразу генерировался на целевом
 * языке, кеш пришлось бы делать локаль-специфичным — впятеро больше строк,
 * впятеро меньше попаданий в кеш, и придётся заново платить за САМЫЙ
 * дорогой вызов сервиса (весь ролик уходит в Gemini, `analysis.service.ts`)
 * на каждую локаль отдельно. Вместо этого канонический (английский) разбор
 * остаётся в библиотеке как есть, а по нему — один ДЕШЁВЫЙ текстовый вызов
 * перевода на сессию, результат которого пишется ТОЛЬКО в сессию, никогда
 * обратно в библиотеку (см. AnalysisService.runAnalysis — перевод
 * применяется ПОСЛЕ library.save()).
 *
 * Переводятся только поля, которые пользователь реально читает (см.
 * doc/PRODUCT-PROJECT-SPEC.md §39, исследование при подготовке этапа):
 * sceneBreakdown, characters[].label/role/appearance, scenes[].title,
 * extras[].label/description, audience.ageRange/interests/summary,
 * promotedProduct.category/description. НЕ переводятся: таймкоды,
 * previewAt/previewUrl, frame, gender/priceTier (уже локализуются во
 * фронтенде через словари — components/AudienceCard.tsx,
 * AnalysisInsights.tsx), prominence (enum), id (ключ, не текст).
 *
 * Массивы сопоставляются по стабильному `id` ("c1", "s1", "e1"…), а не по
 * индексу — модель отвечает списком той же длины почти всегда, но если
 * порядок или число элементов разойдётся, привязка по id всё равно не
 * перепутает подписи местами; отсутствующий в ответе id — исходный текст
 * остаётся как есть (перевод — улучшение отображения, а не источник
 * истины, потерять оригинал недопустимо).
 */

import { VideoAnalysis } from '../../common/types/analysis.types';

const MAX_TEXT = 4000;

/** Что отправляем модели — только текстовые поля, без служебных. */
export function buildAnalysisTranslationPrompt(
  analysis: VideoAnalysis,
  languageName: string,
): string {
  const payload = {
    sceneBreakdown: (analysis.userEdits || analysis.sceneBreakdown || '').slice(
      0,
      MAX_TEXT,
    ),
    audience: analysis.audience
      ? {
          ageRange: analysis.audience.ageRange,
          interests: analysis.audience.interests,
          summary: analysis.audience.summary,
        }
      : null,
    promotedProduct: analysis.promotedProduct
      ? {
          category: analysis.promotedProduct.category,
          description: analysis.promotedProduct.description,
        }
      : null,
    characters: (analysis.characters ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      role: c.role,
      appearance: c.appearance,
    })),
    scenes: (analysis.scenes ?? []).map((s) => ({ id: s.id, title: s.title })),
    extras: (analysis.extras ?? []).map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
    })),
  };

  return `Translate the text fields below (a video-ad analysis) into ${languageName}. Preserve meaning, tone and any timecodes or numbers verbatim. Do not translate the "id" values — copy them unchanged, they are keys, not text. Keep null as null. Keep the same array lengths and the same "id" for each item.

Respond with a single JSON object of EXACTLY this shape, no other text:
${JSON.stringify(payload, null, 2)}

DATA TO TRANSLATE:
${JSON.stringify(payload)}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length === v.length ? out : null;
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** id → translated row, tolerant of a missing/malformed array. */
function byId(raw: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(raw)) return map;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id === 'string') map.set(o.id, o);
  }
  return map;
}

/**
 * Накладывает перевод на исходный разбор. Никогда не бросает: непонятный
 * или неполный ответ модели просто оставляет соответствующие поля
 * непереведёнными (английский оригинал), а не роняет уже готовый разбор.
 */
export function applyAnalysisTranslation(
  analysis: VideoAnalysis,
  modelResponseText: string,
): VideoAnalysis {
  const json = extractJson(modelResponseText);
  if (!json) return analysis;

  const sceneBreakdown = str(json.sceneBreakdown) ?? analysis.sceneBreakdown;

  const audience = analysis.audience
    ? {
        ...analysis.audience,
        ...(json.audience && typeof json.audience === 'object'
          ? (() => {
              const a = json.audience as Record<string, unknown>;
              return {
                ageRange: str(a.ageRange) ?? analysis.audience!.ageRange,
                interests:
                  strArray(a.interests) ?? analysis.audience!.interests,
                summary: str(a.summary) ?? analysis.audience!.summary,
              };
            })()
          : {}),
      }
    : analysis.audience;

  const promotedProduct = analysis.promotedProduct
    ? {
        ...analysis.promotedProduct,
        ...(json.promotedProduct && typeof json.promotedProduct === 'object'
          ? (() => {
              const p = json.promotedProduct as Record<string, unknown>;
              return {
                category: str(p.category) ?? analysis.promotedProduct!.category,
                description:
                  str(p.description) ?? analysis.promotedProduct!.description,
              };
            })()
          : {}),
      }
    : analysis.promotedProduct;

  const characterRows = byId(json.characters);
  const characters = analysis.characters?.map((c) => {
    const row = characterRows.get(c.id);
    if (!row) return c;
    return {
      ...c,
      label: str(row.label) ?? c.label,
      role: str(row.role) ?? c.role,
      appearance: str(row.appearance) ?? c.appearance,
    };
  });

  const sceneRows = byId(json.scenes);
  const scenes = analysis.scenes?.map((s) => {
    const row = sceneRows.get(s.id);
    if (!row) return s;
    return { ...s, title: str(row.title) ?? s.title };
  });

  const extraRows = byId(json.extras);
  const extras = analysis.extras?.map((e) => {
    const row = extraRows.get(e.id);
    if (!row) return e;
    return {
      ...e,
      label: str(row.label) ?? e.label,
      description: str(row.description) ?? e.description,
    };
  });

  return {
    ...analysis,
    sceneBreakdown,
    ...(audience ? { audience } : {}),
    ...(promotedProduct ? { promotedProduct } : {}),
    ...(characters ? { characters } : {}),
    ...(scenes ? { scenes } : {}),
    ...(extras ? { extras } : {}),
  };
}
