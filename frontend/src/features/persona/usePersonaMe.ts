/**
 * Состояние персоны для экрана, входа и экранов FE2 (ТЗ Greeting 2.0
 * §4.1) — поверх общего кеша `lib/persona-store.ts`: сколько бы
 * компонентов ни смонтировалось, `GET /personas/me` уходит один раз.
 *
 * Исходы: «выключено» (404 `PERSONA_DISABLED` — прячем всё), «гость»
 * (401 — вход прячется, экран просит войти), ошибка сети, ответ.
 */

import { useCallback, useEffect, useState } from 'react';
import { getPersonaMe, isPersonaDisabled } from '../../services/persona-api';
import { isUnauthorized, errorMessage } from '../../services/projects-api';
import { createPersonaStore, type StoreState } from '../../lib/persona-store';
import type { PersonaMe } from '../../lib/persona-flow';

export type PersonaLoad =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'guest' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; me: PersonaMe };

/**
 * 30 с: переход «бренд-буки → Я в кадре → бриф» не перечитывает
 * персону, а вернувшийся через минуту человек видит свежую.
 */
const personaStore = createPersonaStore(getPersonaMe, { maxAgeMs: 30_000 });

function toLoad(s: StoreState<PersonaMe>): PersonaLoad {
  if (s.kind === 'loading') return { kind: 'loading' };
  if (s.kind === 'ready') return { kind: 'ready', me: s.value };
  if (isPersonaDisabled(s.error)) return { kind: 'disabled' };
  if (isUnauthorized(s.error)) return { kind: 'guest' };
  return { kind: 'error', message: errorMessage(s.error) };
}

/** Забыть персону (после «Удалить всё»): следующий экран перечитает. */
export function resetPersonaCache(): void {
  personaStore.reset();
}

export function usePersonaMe(): {
  load: PersonaLoad;
  reload: () => Promise<void>;
  setMe: (me: PersonaMe) => void;
} {
  const [load, setLoad] = useState<PersonaLoad>(() =>
    toLoad(personaStore.get())
  );

  useEffect(() => {
    const off = personaStore.subscribe((s) => setLoad(toLoad(s)));
    void personaStore.ensure().then((s) => setLoad(toLoad(s)));
    return off;
  }, []);

  const reload = useCallback(async () => {
    await personaStore.refresh();
  }, []);

  const setMe = useCallback((me: PersonaMe) => personaStore.set(me), []);

  return { load, reload, setMe };
}
