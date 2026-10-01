/**
 * Контекст приложения Помощника поверх кита: клиенты знаний/песочницы,
 * виджета, персоны и мастера и словарь приложения. Отдельно от
 * `KitContext`: кит общий с QA и о помощнике не знает (контракт Э1,
 * правило «site-tma-kit — только общее»).
 */

import { createContext, useContext } from 'react';
import type { AppDictionary } from '../i18n';
import type { KnowledgeApi } from './knowledge-api';
import type { PersonaApi } from './persona-api';
import type { WidgetApi } from './widget-api';
import type { WizardApi } from './wizard-api';

export interface AssistValue {
  knowledge: KnowledgeApi;
  appDict: AppDictionary;
  /** Э2 (W4). */
  widget: WidgetApi;
  persona: PersonaApi;
  wizard: WizardApi;
}

export const AssistContext = createContext<AssistValue | null>(null);

export function useAssist(): AssistValue {
  const v = useContext(AssistContext);
  if (!v) throw new Error('useAssist() вызван вне <AssistContext.Provider>');
  return v;
}
