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
 * ⚠️⚠️ ОТКЛЮЧЕНО (2026-09-13) — реальный сбой в проде подтвердил
 * предупреждение выше: `veo-3.0-generate-001` (первая догадка) даёт
 * 404 `NOT_FOUND` от Gemini API — «is not found… or is not supported
 * for predictLongRunning». Реальные деньги были потрачены на
 * проваленные попытки генерации, пока это было включено вслепую.
 *
 * `VEO_3_0_ENABLED = false` ниже отключает переключение целиком —
 * `pickVeoModel()`/`usesVeo30()` теперь всегда ведут себя так, будто
 * персонаж есть всегда (то есть всегда Veo 3.1), сама логика подбора
 * НЕ удалена, чтобы не терять эту работу, если Veo 3.0 когда-нибудь
 * захотят включить снова — но только после того, как кто-то реально
 * проверит рабочий ID модели одним ручным вызовом (сторонние источники
 * вроде LiteLLM называют `veo-3.0-generate-preview` по аналогии с уже
 * рабочей `veo-3.1-generate-preview` — это ДОГАДКА чуть лучше прежней,
 * не подтверждённый факт; я уже был неправ с первой догадкой один раз
 * на этом же вопросе, второй раз в проде проверять не стоит).
 */
import { ReferencePlan } from './reference-plan';

const VEO_3_0_ENABLED = false;

/** Обновлено на лучшую (но всё ещё НЕ подтверждённую) догадку после
 * первого сбоя — не проверено реальным вызовом, см. предупреждение
 * выше. Используется только если `VEO_3_0_ENABLED` включат обратно. */
export const VEO_3_0_MODEL = 'veo-3.0-generate-preview';

export function pickVeoModel(
  plan: Pick<ReferencePlan, 'legacyFirstFrame'>,
  quality: 'fast' | 'standard',
  fallback: string,
): string {
  if (!VEO_3_0_ENABLED) return fallback;
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
  if (!VEO_3_0_ENABLED) return false;
  return quality === 'standard' && plan.legacyFirstFrame;
}
