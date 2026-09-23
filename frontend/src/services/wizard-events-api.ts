/**
 * Отправка телеметрии шагов — «Тонкая красная линия» §8.
 *
 * Отдельный файл от `wizard-guide-api`: подсказка — это разговор с
 * моделью за деньги, а это — наблюдение за продуктом, которое обязано
 * молчать при любой неудаче.
 */

import { api } from './api';
import type { WizardEvent } from '../lib/wizard-events';

export async function sendWizardEvents(
  projectId: string,
  events: WizardEvent[]
): Promise<void> {
  if (!events.length) return;
  try {
    await api.post(`/projects/${projectId}/wizard-guide/events`, { events });
  } catch {
    // Телеметрия не имеет права испортить экран. Потерянная пачка — это
    // потерянные ЧАСТОТЫ, а не потерянная работа человека.
  }
}
