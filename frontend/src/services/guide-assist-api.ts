/**
 * Гид «Админка» (Э-С Ш6): какой гид у человека и employee-JWT для
 * загрузчика помощника платформы. Разбор ответов — в `lib/guide-assist.ts`.
 */
import { api } from './api';
import {
  identityFailureOf,
  parseGuideAssistConfig,
  parseIdentity,
  type GuideAssistConfig,
} from '../lib/guide-assist';

/** Никогда не бросает: сбой — старый гид. */
export async function getGuideAssistConfig(): Promise<GuideAssistConfig> {
  try {
    const res = await api.get<unknown>('/guide-assist/config');
    return parseGuideAssistConfig(res.data);
  } catch {
    return { engine: 'legacy' };
  }
}

export type GuideAssistIdentity =
  | { jwt: string; exp: number }
  | { failure: 'off' | 'retry' };

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
