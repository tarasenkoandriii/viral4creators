/**
 * «Я в кадре» в поздравлении и в бренд-буке — сетевая обвязка FE2 над
 * клиентом персоны FE1 (services/persona-api.ts) и маршрутом референсов.
 * Решения «что показать» — в `lib/persona-greeting.ts` (чистые, с тестом).
 */

import { api } from '../services/api';
import { usePersonaMe } from '../features/persona/usePersonaMe';
import type { GreetingReferenceImageView } from '../types/project';
import { personaStateFromLoad, type PersonaState } from './persona-greeting';
import { EmptyResponseError } from './greeting-errors';

/**
 * Состояние персоны для блока «Кто в кадре» и личного бренд-бука —
 * поверх общего кеша FE1 (`usePersonaMe`): один `GET /personas/me` на
 * экран, сколько бы блоков его ни спросили. Сбой не ломает экран — блок
 * прячется (см. `PersonaState`).
 */
export function usePersonaState(): PersonaState {
  return personaStateFromLoad(usePersonaMe().load);
}

/**
 * PATCH …/greeting-references/:id `{ faceConsent: true }` — автор
 * подтверждает согласие человека на фото (§4.8, Г-8). Ответ — весь
 * список, как у правки подписи.
 */
export async function confirmReferenceFaceConsent(
  sessionId: string,
  imageId: string
): Promise<GreetingReferenceImageView[]> {
  const res = await api.patch<GreetingReferenceImageView[]>(
    `/sessions/${sessionId}/greeting-references/${imageId}`,
    { faceConsent: true }
  );
  if (res.data === undefined)
    throw new EmptyResponseError('greeting-references');
  return res.data;
}
