/**
 * Доступ к Story‑Tales (`GET /story-gifts/access`) — один ответ на всё
 * приложение: его грузит `App.tsx` (вкладка, экран заявки/правил), а
 * мастер читает отсюда режим (есть ли публикация по ссылке) и умеет
 * попросить перечитать доступ (например, после 403 `STORY_TERMS_REQUIRED`).
 * Файл без JSX — `Provider` подставляется в `App.tsx` напрямую.
 */
import { createContext, useContext } from 'react';
import type { StoryAccess } from './story-pilot';

export type StoryAccessValue = {
  /** `null` — вне провайдера (например, в тестовом рендере): режим владельца. */
  access: StoryAccess | null;
  refresh: () => void;
};

export const StoryAccessContext = createContext<StoryAccessValue>({
  access: null,
  refresh: () => {},
});

export function useStoryAccess(): StoryAccessValue {
  return useContext(StoryAccessContext);
}
