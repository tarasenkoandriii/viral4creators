// Карточка «Обучалка по сайту: выключатель и суточные потолки» (П-Т9,
// заход 7) — чистые помощники, чтобы их проверял
// site-tutorial-settings.test.ts без браузера.
//
// Поле потолка: пусто — вернуть умолчание (env, иначе код), иначе целое
// 1…1 000 000. Ноль не принимается: бэкенд читает его как «не задано» и
// молча взял бы умолчание; остановить обучалку — выключателем.

import type { SetSiteTutorialSettingsInput, SiteTutorialSettingsView } from './types';

export const SITE_TUTORIAL_CAP_MAX = 1_000_000;

export interface SiteTutorialDraft {
  paused: boolean;
  /** Строки полей ввода: '' — умолчание. */
  rounds: string;
  liveSessions: string;
}

export function siteTutorialDraft(s: SiteTutorialSettingsView): SiteTutorialDraft {
  return {
    paused: s.paused,
    rounds: s.rounds.stored === null ? '' : String(s.rounds.stored),
    liveSessions: s.liveSessions.stored === null ? '' : String(s.liveSessions.stored),
  };
}

/** Значение поля: `null` — умолчание; `undefined` — негодное. */
export function parseCapField(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= SITE_TUTORIAL_CAP_MAX ? n : undefined;
}

/**
 * Что отправить: только изменившееся. `error` — первое негодное поле
 * (тогда не отправляется ничего).
 */
export function siteTutorialChanges(
  state: SiteTutorialSettingsView,
  draft: SiteTutorialDraft,
): { input: SetSiteTutorialSettingsInput; error: string | null } {
  const input: SetSiteTutorialSettingsInput = {};
  if (draft.paused !== state.paused) input.paused = draft.paused;
  const fields: Array<['roundsPerDay' | 'liveSessionsPerDay', string, number | null, string]> = [
    ['roundsPerDay', draft.rounds, state.rounds.stored, 'раундов'],
    ['liveSessionsPerDay', draft.liveSessions, state.liveSessions.stored, 'живых сессий'],
  ];
  for (const [key, raw, stored, label] of fields) {
    const v = parseCapField(raw);
    if (v === undefined) {
      return {
        input: {},
        error: `Потолок ${label} в сутки — целое от 1 до ${SITE_TUTORIAL_CAP_MAX.toLocaleString('ru-RU')} или пусто (умолчание). Остановить обучалку — выключателем.`,
      };
    }
    if (v !== stored) input[key] = v;
  }
  return { input, error: null };
}

const SOURCE_LABEL: Record<string, string> = {
  admin: 'задано здесь',
  env: 'из переменной окружения',
  default: 'умолчание кода',
};

/** «Действует: 5 000 (умолчание кода) · сегодня 123 · осталось 4 877». */
export function capSummary(c: SiteTutorialSettingsView['rounds']): string {
  const parts = [`действует ${c.value.toLocaleString('ru-RU')} (${SOURCE_LABEL[c.source] ?? c.source})`];
  if (c.source === 'admin') parts.push(`умолчание ${c.defaultValue.toLocaleString('ru-RU')}`);
  if (c.usedToday === null) parts.push('расход за сутки не прочитан');
  else {
    parts.push(`сегодня ${c.usedToday.toLocaleString('ru-RU')}`);
    parts.push(
      c.usedToday >= c.value
        ? 'потолок выбран — новые запуски отклоняются до конца суток UTC'
        : `осталось ${(c.value - c.usedToday).toLocaleString('ru-RU')}`,
    );
  }
  return parts.join(' · ');
}
