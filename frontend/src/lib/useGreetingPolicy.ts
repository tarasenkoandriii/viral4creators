import { useEffect, useState } from 'react';
import {
  getGreetingMusic,
  getGreetingPolicy,
  getGreetingScenes,
  searchGreetingStickers,
} from '../services/greeting-api';
import {
  sessionSelectionsKey,
  type GreetingPolicyView,
  type SelectedMusic,
} from './greeting-policy';
import type { GreetingOccasion, GreetingRegister } from '../types/project';

/**
 * Таблица `GET /greeting/policy` для экрана (этап D, §3.5).
 *
 * `null` — пока грузится и если запрос не прошёл. Отдельной ошибки
 * наружу нет намеренно: без таблицы интерфейс не выдумывает правила —
 * все тоны доступны, а проверку делает сервер отказом с объяснением
 * (см. шапку `lib/greeting-policy.ts`). Кэш — в `getGreetingPolicy`,
 * так что два экрана подряд не запрашивают таблицу дважды.
 */
export function useGreetingPolicy(): GreetingPolicyView | null {
  const [policy, setPolicy] = useState<GreetingPolicyView | null>(null);
  useEffect(() => {
    let alive = true;
    getGreetingPolicy()
      .then((p) => alive && setPolicy(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return policy;
}

export interface SessionSelections {
  sticker: boolean;
  sceneCount: number | null;
  music: SelectedMusic | null;
}

/**
 * Что уже выбрано в начатой сессии — для предупреждения ДО сохранения
 * брифа, что сбросится (§3.5: «экран показывает список изменений»).
 *
 * Перечитывается при каждой смене повода или регистра и после каждого
 * сохранения (`sessionSelectionsKey` в `lib/greeting-policy.ts`), а не
 * один раз: наклейку, музыку и число сцен меняют карточки «Характера
 * ролика» ниже, и снимок, прочитанный при открытии брифа, врал бы.
 * Ограничение: выбор в карточке ПОСЛЕ смены повода, но до сохранения,
 * предупреждение не увидит до следующей смены повода или регистра —
 * окончательный список всё равно назовёт сервер. Три лёгких GET — наклейка
 * пустым запросом до Pixabay не доходит, сервер отдаёт только выбранную.
 *
 * `null` — сессии нет или прочитать не удалось: предупреждения просто
 * нет, окончательный список всё равно назовёт сервер (`resetFields`).
 */
export function useSessionSelections(
  sessionId: string | null,
  occasion: GreetingOccasion,
  register: GreetingRegister | null,
  refresh: number
): SessionSelections | null {
  const [selections, setSelections] = useState<SessionSelections | null>(null);
  const key = sessionSelectionsKey(sessionId, occasion, register, refresh);
  useEffect(() => {
    setSelections(null);
    if (!key || !sessionId) return;
    let alive = true;
    Promise.all([
      searchGreetingStickers(sessionId, ''),
      getGreetingScenes(sessionId),
      getGreetingMusic(sessionId),
    ])
      .then(([sticker, scenes, music]) => {
        if (!alive) return;
        setSelections({
          sticker: !!sticker.selected,
          sceneCount: scenes.sceneCount,
          // `occasions` — копия поводов темы на момент выбора, её же
          // читает сервер (`reconcileSelections`). По списку `themes` её
          // не восстановить: он уже отфильтрован по ТЕКУЩЕМУ поводу.
          music: music.selected
            ? {
                source: music.selected.source,
                occasions: music.selected.occasions,
              }
            : null,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // `key` включает sessionId — отдельной зависимостью он не нужен.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return selections;
}
