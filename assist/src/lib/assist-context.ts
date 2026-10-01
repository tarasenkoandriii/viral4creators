/**
 * Контекст приложения Помощника поверх кита: клиент знаний/песочницы и
 * словарь приложения. Отдельно от `KitContext`: кит общий с QA и о
 * знаниях помощника не знает (контракт Э1, правило «site-tma-kit — только
 * общее»).
 */

import { createContext, useContext } from 'react';
import type { AppDictionary } from '../i18n';
import type { KnowledgeApi } from './knowledge-api';

export interface AssistValue {
  knowledge: KnowledgeApi;
  appDict: AppDictionary;
}

export const AssistContext = createContext<AssistValue | null>(null);

export function useAssist(): AssistValue {
  const v = useContext(AssistContext);
  if (!v) throw new Error('useAssist() вызван вне <AssistContext.Provider>');
  return v;
}
