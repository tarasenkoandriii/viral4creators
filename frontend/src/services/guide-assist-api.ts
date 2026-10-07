/**
 * Гид «Админка» (Э-С Ш6): какой гид у человека и employee-JWT для
 * загрузчика помощника платформы. Разбор ответов — в `lib/guide-assist.ts`.
 *
 * Подсказка «какой гид» (аудит Ш6): последний известный гид хранится на
 * устройстве, и при `legacy` мини-апп не спрашивает `config` на каждом
 * старте — гид приходит и в ответе гида проекта (`noteWizardGuideState`).
 */
import { api } from './api';
import {
  announceGuideEngine,
  identityFailureOf,
  parseGuideAssistConfig,
  parseIdentity,
  readGuideEngineHint,
  writeGuideEngineHint,
  type GuideAssistConfig,
  type GuideAssistIdentity,
  type GuideEngine,
  type GuideEngineStore,
} from '../lib/guide-assist';

/** localStorage, если он есть и доступен (приватный режим может бросить). */
function hintStore(): GuideEngineStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Никогда не бросает: сбой — старый гид. Удачный ответ запоминается
 * подсказкой; сбой сети — нет (иначе один сбой выключал бы «Админку» до
 * следующего ответа гида проекта).
 */
export async function getGuideAssistConfig(): Promise<GuideAssistConfig> {
  try {
    const res = await api.get<unknown>('/guide-assist/config');
    const cfg = parseGuideAssistConfig(res.data);
    writeGuideEngineHint(hintStore(), cfg.engine);
    return cfg;
  } catch {
    return { engine: 'legacy' };
  }
}

/** Последний известный гид на устройстве (`null` — неизвестно). */
export function guideEngineHint(): GuideEngine | null {
  return readGuideEngineHint(hintStore());
}

/** Забыть подсказку: личность сменилась — у другого человека гид свой. */
export function forgetGuideEngineHint(): void {
  writeGuideEngineHint(hintStore(), null);
}

/**
 * Ответ гида проекта (`GET`/`PATCH /projects/:id/wizard-guide`) несёт
 * `engine` — запомнить и сообщить `GuideAssistMount` событием окна.
 */
export function noteWizardGuideState(state: unknown): void {
  if (typeof window === 'undefined') return;
  announceGuideEngine(state, window, hintStore());
}

export type { GuideAssistIdentity };

/**
 * Свежий JWT или причина отказа (`identityFailureOf`): `off` — флаг
 * выключили или человек вышел, `retry` — сеть/сервер подвели.
 */
export async function getGuideAssistIdentity(): Promise<GuideAssistIdentity> {
  try {
    const res = await api.post<unknown>('/guide-assist/identity', {});
    return parseIdentity(res.data) ?? { failure: 'off' };
  } catch (e) {
    const status = (e as { response?: { status?: unknown } } | null)?.response
      ?.status;
    return { failure: identityFailureOf(status) };
  }
}
