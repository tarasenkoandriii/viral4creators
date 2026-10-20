// Story‑Tales, проход 3 (Р-ST3-1/7): платный пилот по приглашению — раздел
// «Пилот» на странице Story‑Tales. Здесь — запросы к API и чистая часть
// экрана (места, подписи, ошибки словами); разметка — в
// `app/story-tales/page.tsx`. Контракт — бриф прохода 3, backend —
// `story-pilot.controller.ts` (AdminSessionGuard + оператор, каждое
// действие — в журнал `story_operator_actions`, повтор того же
// `requestId` возвращает прежний результат).
import { ApiRequestError, apiDelete, apiGet, apiPost } from './admin-api';
import type {
  StoryPilotActionInput,
  StoryPilotApplication,
  StoryPilotOverview,
  StoryTalesAccessMode,
  StoryTalesActionResult,
} from './types';

const BASE = '/admin/story-tales/pilot';

export function getStoryPilot() {
  return apiGet<StoryPilotOverview>(BASE);
}
export function approveStoryPilotApplication(id: string, body: StoryPilotActionInput) {
  return apiPost<StoryTalesActionResult>(`${BASE}/applications/${encodeURIComponent(id)}/approve`, body);
}
export function rejectStoryPilotApplication(id: string, body: StoryPilotActionInput) {
  return apiPost<StoryTalesActionResult>(`${BASE}/applications/${encodeURIComponent(id)}/reject`, body);
}
/** Отзыв доступа: данные пользователя остаются, новые сборки — 404, публичные ссылки снимаются. */
export function revokeStoryPilotMember(userId: string, body: StoryPilotActionInput) {
  return apiDelete<StoryTalesActionResult>(`${BASE}/members/${encodeURIComponent(userId)}`, body);
}

export type StoryPilotActionKind = 'approve' | 'reject' | 'revoke';

export const PILOT_ACTION_TITLE: Record<StoryPilotActionKind, string> = {
  approve: 'Одобрить заявку',
  reject: 'Отклонить заявку',
  revoke: 'Отозвать доступ к пилоту',
};
/** Что произойдёт — текст подтверждения. */
export const PILOT_ACTION_EFFECT: Record<StoryPilotActionKind, string> = {
  approve:
    'Пользователь станет участником пилота и сможет создавать сказки в TMA. Первая сказка участника — бесплатно, дальше — кредитами по смете. Займёт одно место.',
  reject: 'Заявка будет отклонена; доступа к Story‑Tales у пользователя не будет. Решение записывается в журнал.',
  revoke:
    'Новые сборки станут недоступны (404), публичные ссылки на его сказки снимаются сразу. Уже созданные сказки остаются у пользователя (просмотр и удаление). Место освободится. Повторно одобрить этого пользователя нельзя.',
};
/** Причина по умолчанию — дословно та, что подставит сервер (`DEFAULT_REASON` в `story-pilot.service.ts`). */
export const PILOT_DEFAULT_REASON: Record<StoryPilotActionKind, string> = {
  approve: 'Заявка одобрена владельцем',
  reject: 'Заявка отклонена владельцем',
  revoke: 'Доступ к пилоту отозван владельцем',
};

export const PILOT_MODE_LABEL: Record<StoryTalesAccessMode, string> = {
  owner: 'только владелец — пилот выключен (STORY_TALES_ACCESS=owner)',
  pilot: 'пилот по приглашению (STORY_TALES_ACCESS=pilot)',
  public: 'открытый доступ 18+ (STORY_TALES_ACCESS=public)',
};

export const PILOT_APPLICATION_STATUS: Record<StoryPilotApplication['status'], string> = {
  pending: 'ждёт решения',
  approved: 'одобрена',
  rejected: 'отклонена',
  expired: 'истекла (90 дней без решения; текст стёрт, можно подать снова)',
};

/** Кто подал заявку / кто участник: `@username (shortId)` или только shortId. */
export function pilotUserLabel(x: { shortId: string; telegramUsername?: string }): string {
  return x.telegramUsername ? `@${x.telegramUsername} (${x.shortId})` : x.shortId;
}

/**
 * Машинный код отказа. Глобальный фильтр backend
 * (`common/filters/http-exception.filter.ts`) кладёт в `error.code` класс
 * HTTP-ошибки (`CONFLICT`, `NOT_FOUND`…), а код из тела исключения
 * (`{ code: 'STORY_PILOT_FULL', message }`) — в `error.details.code`;
 * `handle()` в `admin-api.ts` раскладывает их в `code` и `details`.
 */
export function pilotErrorCode(error: ApiRequestError): string | undefined {
  const machine = error.details?.code;
  return typeof machine === 'string' ? machine : error.code;
}

export interface PilotSeats {
  used: number;
  max: number;
  left: number;
  full: boolean;
}

/** Занятые места — активные участники; лимит — `STORY_PILOT_MAX_MEMBERS`. */
export function pilotSeats(o: Pick<StoryPilotOverview, 'members' | 'maxMembers'>): PilotSeats {
  const used = o.members.length;
  const max = Math.max(0, Math.floor(o.maxMembers));
  const left = Math.max(0, max - used);
  return { used, max, left, full: left === 0 };
}

/**
 * Почему кнопка «Одобрить» недоступна (или `null` — доступна). Сервер
 * проверит то же сам (409 STORY_PILOT_FULL), но оператору лучше знать
 * заранее, а не после нажатия.
 */
export function approveBlockedReason(o: StoryPilotOverview, app: StoryPilotApplication): string | null {
  if (app.status !== 'pending') return 'заявка уже рассмотрена';
  if (pilotSeats(o).full) return `мест нет: занято ${o.members.length} из ${o.maxMembers}`;
  return null;
}

/** Предупреждение о режиме: решения по пилоту действуют только в `pilot`. */
export function pilotModeNote(mode: StoryTalesAccessMode): string | null {
  if (mode === 'owner')
    return 'Story‑Tales сейчас доступна только владельцу: одобренные участники получат доступ, когда backend переключат на STORY_TALES_ACCESS=pilot. Новые заявки в этом режиме не принимаются.';
  if (mode === 'public')
    return 'Открытый режим: Story‑Tales доступна любому взрослому после принятия правил; участие в пилоте даёт только бесплатную первую сказку. Новые заявки не принимаются.';
  return null;
}

const KYIV = new Intl.DateTimeFormat('ru', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
/** Дата по Киеву; негодная строка — как есть (не «Invalid Date»). */
export function kyivDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : KYIV.format(d);
}

/** После такого отказа список устарел — раздел перечитывается сам. */
export function pilotErrorNeedsReload(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  const code = pilotErrorCode(error);
  return (
    error.httpStatus === 404 ||
    code === 'STORY_PILOT_FULL' ||
    code === 'STORY_PILOT_DECIDED' ||
    code === 'STORY_PILOT_ALREADY_MEMBER' ||
    code === 'STORY_PILOT_REVOKED'
  );
}

/**
 * «Перед одобрением первых участников» — что владелец делает вне кода
 * (решения прохода 3, юридическая проверка). Статический текст, отметки не
 * хранятся.
 */
export const PILOT_OWNER_CHECKLIST: ReadonlyArray<string> = [
  'Заполнить §12 оферты (doc/legal/offer.md): РНОКПП, налоговый статус, e-mail для обращений — и перегенерировать legal-content (node scripts/sync-legal.mjs).',
  'Включить удаление по срокам: STORY_RETENTION_PURGE_ENABLED=true и STORY_RETENTION_READY_PURGE_ENABLED=true (после выката кабинета с предупреждением за 14 дней).',
  'Ключ Gemini — платного уровня (на бесплатном Google вправе использовать данные для обучения): фото и образы рассказчика.',
  'Подписать/принять DPA с Resemble (голос) и Soniox (распознавание речи).',
  'VeryGoodFFmpeg (сборка видео): проверить юрлицо и DPA; без договора о данных не отправлять пилотные материалы.',
  'Уведомить Уповноваженого ВРУ з прав людини об обработке персональных данных повышенного риска (голос, изображение) — в течение 30 рабочих дней с начала первой обработки.',
];

/** Ошибка действия или загрузки — словами, с тем, что делать дальше. */
export function pilotErrorText(error: unknown, kind?: StoryPilotActionKind): string {
  if (error instanceof ApiRequestError) {
    switch (pilotErrorCode(error)) {
      case 'STORY_PILOT_FULL':
        return 'Мест в пилоте нет — все места заняты. Освободите место (отзовите доступ у участника) или увеличьте STORY_PILOT_MAX_MEMBERS на backend.';
      case 'STORY_PILOT_DECIDED':
        return 'Заявка уже рассмотрена (возможно, в другой вкладке) — список обновлён.';
      case 'STORY_PILOT_ALREADY_MEMBER':
        return 'Этот пользователь уже был участником пилота (в том числе с отозванным доступом) — повторно одобрить его нельзя.';
      case 'STORY_PILOT_REVOKED':
        return 'Доступ этого участника уже отозван — список обновлён.';
    }
    if (error.httpStatus === 401) return 'Сессия админки истекла — войдите заново.';
    if (error.httpStatus === 403) return 'Нет прав оператора Story‑Tales для этого действия.';
    if (error.httpStatus === 404)
      return kind === 'revoke'
        ? 'Участник не найден — возможно, доступ уже отозван. Обновите список.'
        : kind
          ? 'Заявка не найдена — обновите список.'
          : 'Раздел пилота не найден на backend — проверьте, что выкачен проход 3 Story‑Tales.';
    if (error.httpStatus === 409) return `Конфликт: ${error.message}. Обновите список и повторите.`;
    if (error.httpStatus === 400) return `Сервер отклонил запрос: ${error.message}`;
    if (error.httpStatus >= 500) return `Ошибка сервера (${error.httpStatus}) — повторите позже; повтор безопасен.`;
    return error.message;
  }
  if (error instanceof TypeError) return 'Нет связи с сервером — проверьте подключение и повторите; повтор того же действия безопасен.';
  return error instanceof Error ? error.message : 'Действие не выполнено';
}
