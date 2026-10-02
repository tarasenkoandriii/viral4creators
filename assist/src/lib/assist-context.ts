/**
 * Контекст приложения Помощника поверх кита: клиенты знаний/песочницы,
 * виджета, персоны и мастера и словарь приложения. Отдельно от
 * `KitContext`: кит общий с QA и о помощнике не знает (контракт Э1,
 * правило «site-tma-kit — только общее»).
 */

import { createContext, useContext } from 'react';
import type { AppDictionary } from '../i18n';
import type { BillingApi } from './billing-api';
import type { HandoffApi } from './handoff-api';
import type { KnowledgeApi } from './knowledge-api';
import type { LearningApi } from './learning-api';
import type { StatsApi } from './stats-api';
import type { PersonaApi } from './persona-api';
import type { WidgetApi } from './widget-api';
import type { VoiceApi } from './voice-api';
import type { MediaApi } from './media-api';
import type { WizardApi } from './wizard-api';

export interface AssistValue {
  knowledge: KnowledgeApi;
  appDict: AppDictionary;
  /** Э2 (W4). */
  widget: WidgetApi;
  persona: PersonaApi;
  wizard: WizardApi;
  /** Э3 (T): диалоги и передача (H), обучение (L), цели и статистика (A). */
  handoff: HandoffApi;
  learning: LearningApi;
  stats: StatsApi;
  /** Э4: тариф и оплата. */
  billing: BillingApi;
  /** Э5: голос виджета (раздел экрана характера). */
  voice: VoiceApi;
  /** Э6: экран «Видео» (ролики обучалки, карта интерфейса). */
  media: MediaApi;
}

export const AssistContext = createContext<AssistValue | null>(null);

export function useAssist(): AssistValue {
  const v = useContext(AssistContext);
  if (!v) throw new Error('useAssist() вызван вне <AssistContext.Provider>');
  return v;
}
