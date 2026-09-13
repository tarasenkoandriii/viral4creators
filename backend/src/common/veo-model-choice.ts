/**
 * Авто-выбор версии Veo (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §1,
 * этап 5 плана реализации §14) — пониженный приоритет: с появлением
 * Grok (§10–11) пользователь может получить похожий эффект вручную,
 * без единой строки кода этого файла (см. §1 ТЗ, «Пересмотрено при
 * аудите»). Реализовано по прямому запросу продолжить план до конца,
 * не потому что это критично.
 *
 * Правило (§1 ТЗ): нет персонажей бренда у сессии → Veo 3.0 (открывает
 * `negativePrompt`); есть хотя бы один персонаж → Veo 3.1 (Veo 3.0
 * официально не принимает `referenceImages`, §2 ТЗ).
 *
 * Область: только `quality === 'standard'`. У Veo 3.0 нет
 * задокументированного «Lite»-аналога (это более старое поколение,
 * чем сам сплит Lite/Standard, появившийся в 3.1) — на `fast`
 * авто-переключения нет, там всегда Veo 3.1 Lite, как и раньше.
 *
 * ⚠️ Точный ID модели Veo 3.0 — НЕ подтверждён официальной
 * документацией на момент подготовки (ни в самом ТЗ, ни здесь) —
 * тот же принцип «ПРОВЕРИТЬ», что уже применяется к остальным именам
 * моделей в `common/ai-pricing.ts`/`config/configuration.ts`.
 */
import { ReferencePlan } from './reference-plan';

export const VEO_3_0_MODEL = 'veo-3.0-generate-001';

export function pickVeoModel(
  plan: Pick<ReferencePlan, 'legacyFirstFrame'>,
  quality: 'fast' | 'standard',
  fallback: string,
): string {
  if (quality !== 'standard') return fallback;
  return plan.legacyFirstFrame ? VEO_3_0_MODEL : fallback;
}

/** `true`, если для этой комбинации реально включается Veo 3.0 —
 * нужно вызывающему, чтобы решить, идёт ли «Чего избежать» в
 * настоящий `negativePrompt` или best-effort строкой в промпт
 * (§4.1 ТЗ). */
export function usesVeo30(
  plan: Pick<ReferencePlan, 'legacyFirstFrame'>,
  quality: 'fast' | 'standard',
): boolean {
  return quality === 'standard' && plan.legacyFirstFrame;
}
