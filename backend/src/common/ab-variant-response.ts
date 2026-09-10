/**
 * Разбор ответа GPT-5 на запрос A/B-вариантов (TODO §III.6, этап 66).
 *
 * `PromptService.generateAbVariants` просит модель одним вызовом вернуть
 * РОВНО `count` альтернативных промптов, отличающихся только хуком
 * (открывающие секунды) и CTA (закрывающий бит) — раскадровка, камера,
 * персонажи, темп и цвет должны остаться теми же. Ответ — JSON вида
 * `{"variants": [{"hookLabel": "...", "ctaLabel": "...", "prompt": "...",
 * "voiceoverScript": "..."}, ...]}`.
 *
 * Разбор терпимый, тем же приёмом, что `parsePromptResponse`
 * (`voiceover-script.ts`) — модель то оборачивает ответ в ```json, то
 * пишет пояснение перед объектом. Строгий разбор здесь стоил бы дороже,
 * чем для одиночного промпта: это самый дорогой по токенам вызов
 * сервиса, и «не получилось — переспросите» после него ощутимо бьёт по
 * счёту.
 */

export interface AbVariantDraft {
  /** Короткая подпись хука для экрана прогресса, напр. "Хук: вопрос". */
  hookLabel: string;
  /** Короткая подпись CTA, напр. "CTA: скидка 20%". */
  ctaLabel: string;
  /** Полный Veo-текст этого варианта. */
  prompt: string;
  /** Текст озвучки этого варианта, если модель его выделила отдельно. */
  voiceoverScript: string | null;
}

function firstJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // следующая попытка
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function draftFrom(raw: unknown, index: number): AbVariantDraft | null {
  if (!isRecord(raw)) return null;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return null;
  const hookLabel =
    typeof raw.hookLabel === 'string' && raw.hookLabel.trim()
      ? raw.hookLabel.trim()
      : `Вариант ${index + 1}`;
  const ctaLabel =
    typeof raw.ctaLabel === 'string' && raw.ctaLabel.trim()
      ? raw.ctaLabel.trim()
      : `Вариант ${index + 1}`;
  const voiceoverScript =
    typeof raw.voiceoverScript === 'string' && raw.voiceoverScript.trim()
      ? raw.voiceoverScript.trim()
      : null;
  return { hookLabel, ctaLabel, prompt, voiceoverScript };
}

/**
 * Разбирает ответ модели в массив вариантов. Бросает `Error` только если
 * не удалось выделить НИ ОДНОГО валидного варианта с непустым `prompt` —
 * частичный ответ (модель вернула 2 из 3 запрошенных) лучше отдать как
 * есть, чем провалить весь запуск: вызывающий код (`AbTestService.create`)
 * сам решает, достаточно ли этого числа.
 */
export function parseAbVariantsResponse(raw: string): AbVariantDraft[] {
  const parsed = firstJsonValue(raw);

  let rawVariants: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawVariants = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.variants)) {
    rawVariants = parsed.variants;
  }

  const drafts = rawVariants
    .map((v, i) => draftFrom(v, i))
    .filter((v): v is AbVariantDraft => v !== null);

  if (drafts.length === 0) {
    throw new Error(
      'Не удалось разобрать варианты в ответе модели — не найдено ни одного объекта с непустым полем "prompt".',
    );
  }

  return drafts;
}
