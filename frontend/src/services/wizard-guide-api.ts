/**
 * Чекбокс «использовать ИИ» — «Тонкая красная линия» §3.
 *
 * Маршруты по конвенции мини-аппа: `projectId` в пути, права — по
 * проекту, всё за `TelegramIdentityGuard`.
 */

import { api } from './api';
import type { WizardGuideState, WizardHintResult } from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

const base = (projectId: string) => `/projects/${projectId}/wizard-guide`;

export async function getWizardGuide(
  projectId: string
): Promise<WizardGuideState> {
  return unwrap(
    await api.get<WizardGuideState>(base(projectId)),
    'wizard-guide'
  );
}

export async function setWizardGuide(
  projectId: string,
  enabled: boolean
): Promise<WizardGuideState> {
  return unwrap(
    await api.patch<WizardGuideState>(base(projectId), { enabled }),
    'wizard-guide'
  );
}

/**
 * Подсказка на шаге. `signal` обязателен по смыслу, а не по типу:
 * уход с шага и снятие галочки должны отменять вызов, иначе ответ
 * приедет на экран, которого уже нет.
 */
export async function requestWizardHint(
  projectId: string,
  body: { stepId: string; locale: string },
  signal?: AbortSignal
): Promise<WizardHintResult> {
  return unwrap(
    await api.post<WizardHintResult>(`${base(projectId)}/hint`, body, {
      signal,
    }),
    'hint'
  );
}

/**
 * «Тут непонятно» — самый дешёвый и самый честный сигнал (§6.3).
 *
 * Текст необязателен: без него остаётся только событие телеметрии, и
 * этого достаточно, чтобы увидеть шаг, на котором людям неясно. Со
 * словами заводится кандидат для оператора — на языке человека, как он
 * написал (§6.7).
 */
export async function sendWizardComplaint(
  projectId: string,
  body: { stepId: string; locale: string; text?: string }
): Promise<void> {
  try {
    await api.post(`${base(projectId)}/complaint`, body);
  } catch {
    // Жалоба на подсказку не имеет права превратиться в ошибку поверх
    // мастера: человек и так уже сказал, что ему тут непонятно.
  }
}
