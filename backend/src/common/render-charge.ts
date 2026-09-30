/**
 * Чем оплачивается старт рендера — чистая часть решения
 * `RenderAccessService.assertCanRender` (этап 132, стена бесплатных
 * генераций) и её вывод «что спишет» для согласия голосом (K7 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.4).
 *
 * Почему вынесено: клиент перед согласием голосом называет цену по данным
 * кабинета (`frontend/src/lib/voice-consent.ts`, `renderChargeOf`) — это
 * зеркало решения сервера. Пока решение жило внутри сервиса с базой и
 * кредитами, зеркало нечем было сверить, и расхождение (цена «включено»,
 * а сервер списал кредит) никто бы не заметил. Теперь сервис и клиентский
 * тест читают ОДНУ функцию `renderPathOf`, а `renderChargeOf` здесь —
 * эталон, с которым клиентский тест сравнивает своё зеркало перебором.
 */

/**
 * Путь старта рендера (порядок проверок `assertCanRender`):
 *
 *  - `credit-or-limit` — рубильник стены выключен: кредит, если есть,
 *    иначе суточный лимит тарифа (как до этапа 132);
 *  - `limit`           — право (подписка или снятая стена): кредит не
 *    трогается, только суточный лимит;
 *  - `credit-or-wall`  — стена включена, права нет: кредит (сначала
 *    приветственный, если положен), иначе стена;
 *  - `wall`            — анонимный при включённой стене: сразу стена.
 */
export type RenderPath =
  | 'credit-or-limit'
  | 'limit'
  | 'credit-or-wall'
  | 'wall';

export interface RenderPathFacts {
  wallEnabled: boolean;
  /** Есть владелец (не анонимный браузерный путь). */
  signedIn: boolean;
  /** Подписка или снятая стена (`hasRenderRight`). */
  hasRight: boolean;
}

export function renderPathOf(f: RenderPathFacts): RenderPath {
  if (!f.wallEnabled) return 'credit-or-limit';
  if (!f.signedIn) return 'wall';
  if (f.hasRight) return 'limit';
  return 'credit-or-wall';
}

/**
 * Что спишет старт рендера — с точки зрения человека перед кнопкой:
 *
 *  - `credit`   — одна генерация из баланса;
 *  - `included` — генерации не списываются, рендер идёт в суточный лимит;
 *  - `unknown`  — назвать цену нельзя: нет данных, или стена без
 *    кредитов (сервер может выдать приветственную генерацию, а может
 *    показать стену) — тогда согласия голосом нет, только кнопка.
 */
export type RenderCharge =
  | { kind: 'credit'; balance: number }
  | { kind: 'included' }
  | { kind: 'unknown'; reason: 'no-data' | 'locked' };

/** Поля кабинета (`GET /referrals/me`), от которых зависит цена. */
export interface ChargeFacts {
  wallEnabled: boolean;
  generationsAvailable: number;
  /** Право на рендер (подписка или снятая стена). */
  unlocked: boolean;
}

/**
 * Эталон клиентского `renderChargeOf`: та же сигнатура, то же решение,
 * но через `renderPathOf` — то есть через тот же путь, по которому идёт
 * сервер. Кабинет открыт только вошедшему, поэтому `signedIn: true`.
 */
export function renderChargeOf(facts: ChargeFacts | null): RenderCharge {
  if (!facts) return { kind: 'unknown', reason: 'no-data' };
  const balance = Math.max(0, Math.floor(facts.generationsAvailable));
  const path = renderPathOf({
    wallEnabled: facts.wallEnabled,
    signedIn: true,
    hasRight: facts.unlocked,
  });
  switch (path) {
    case 'credit-or-limit':
      return balance > 0 ? { kind: 'credit', balance } : { kind: 'included' };
    case 'limit':
      return { kind: 'included' };
    case 'credit-or-wall':
      return balance > 0
        ? { kind: 'credit', balance }
        : { kind: 'unknown', reason: 'locked' };
    case 'wall':
      return { kind: 'unknown', reason: 'locked' };
  }
}
