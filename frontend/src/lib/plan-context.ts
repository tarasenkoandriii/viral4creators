/**
 * Контекст режима (ТЗ §23): одно состояние `PlanState` на всё приложение.
 *
 * Почему контекст, а не запрос в каждом компоненте: замков много (вкладка
 * «Библиотека», аудит, публикация, слоты референсов, свои сцены, фото-
 * замена персонажа, форматы кадра), и восемь независимых запросов
 * `GET /me/plan` при открытии мастера — это восемь шансов показать разные
 * ответы в разных карточках одного экрана.
 *
 * Файл намеренно `.ts`, без JSX: `PlanContext.Provider` подставляется в
 * `App.tsx` напрямую. Так рядом с хуками не оказывается компонента, и
 * правило `react-refresh/only-export-components` не спорит с экспортом
 * хуков из одного модуля.
 */

import { createContext, useContext } from 'react';
import type { PlanFeature, PlanState } from '../types';
import { allows, lockLabel } from './plan';
import { useI18n } from './i18n-context';

export interface PlanContextValue {
  /** `null`, пока ответ не пришёл ИЛИ если запрос провалился. */
  state: PlanState | null;
  /**
   * Чем именно кончился последний запрос, если он провалился (этап 119,
   * В-5.6). Отличить «ещё грузится» от «не загрузилось» по одному
   * `state === null` невозможно, и экран «Режимы», который целиком
   * рисуется из этого ответа, крутил спиннер до перезапуска приложения.
   */
  error: unknown;
  /** Перечитать после смены режима — и повторить после сбоя. */
  refresh: () => void;
}

export const PlanContext = createContext<PlanContextValue>({
  state: null,
  error: null,
  refresh: () => {},
});

export function usePlanContext(): PlanContextValue {
  return useContext(PlanContext);
}

export function usePlanState(): PlanState | null {
  return useContext(PlanContext).state;
}

/**
 * Что интерфейсу нужно знать про одну возможность: разрешена ли и как
 * подписать замок. `loading` отделено от `allowed=false` сознательно —
 * пока матрица не пришла, честнее не рисовать ни кнопку, ни замок, чем
 * мигнуть замком у премиум-пользователя.
 */
export function useFeature(feature: PlanFeature): {
  allowed: boolean;
  loading: boolean;
  lock: string;
} {
  const state = usePlanState();
  const { dict } = useI18n();
  return {
    allowed: allows(state, feature),
    loading: state === null,
    lock: lockLabel(state, feature, dict.common),
  };
}
