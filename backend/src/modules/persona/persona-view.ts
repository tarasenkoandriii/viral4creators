/**
 * Формы ответа персоны (контракт волны «Я в кадре»). Одна функция на
 * образ — её зовут и E (`GET /personas/me`, базовый образ из verify), и
 * F (`POST/PATCH /personas/me/looks`), чтобы форма `Look` не разошлась.
 *
 * Пути и URL селфи и ролика живости сюда не попадают НИКОГДА (§4.9):
 * у персоны в ответе нет ни одного поля с ними.
 */

export interface PersonaLookView {
  id: string;
  label: string;
  preset: string | null;
  targetAge: number | null;
  isBase: boolean;
  status: string;
  photoUrl: string | null;
  sketchUrl: string | null;
  /** Причина `failed` — человеку, чтобы не гадать (сверх контракта). */
  error: string | null;
  createdAt: string;
}

export interface PersonaLookRow {
  id: string;
  label: string;
  preset: string | null;
  targetAge: number | null;
  isBase: boolean;
  status: string;
  photoUrl: string | null;
  error: string | null;
  createdAt: Date;
  activeSketch?: { url: string | null } | null;
}

export function personaLookToDto(look: PersonaLookRow): PersonaLookView {
  return {
    id: look.id,
    label: look.label,
    preset: look.preset,
    targetAge: look.targetAge,
    isBase: look.isBase,
    status: look.status,
    photoUrl: look.status === 'ready' ? look.photoUrl : null,
    sketchUrl: look.activeSketch?.url ?? null,
    error: look.status === 'failed' ? look.error : null,
    createdAt: look.createdAt.toISOString(),
  };
}

export interface PersonaView {
  id: string;
  consentGivenAt: string;
  /** Проверка пройдена. Не «личность подтверждена» (Т-16). */
  verified: boolean;
  ageMin: number | null;
  ageMax: number | null;
  sourcesPurgedAt: string | null;
  /** Причины последнего отказа проверки (сверх контракта): `under-18` — режим закрыт. */
  refusals: string[] | null;
}

export interface PersonaMeView {
  persona: PersonaView | null;
  looks: PersonaLookView[];
  /** Статус голоса в нижнем регистре (`training`/`ready`/`failed`), как `toView` в user-voices. */
  voice: { id: string; status: string } | null;
  quota: { dayLeft: number; monthLeft: number };
  /**
   * Рубильник `PERSONA_ENABLED` (сверх контракта). Выключен, а персона
   * есть — ответ всё равно 200 (право на удаление): клиент показывает
   * только просмотр и «Удалить себя», без создания образов.
   */
  enabled: boolean;
}

export interface CreatePersonaResult {
  personaId: string;
  selfieUploadUrl: string;
  selfiePathname: string;
  livenessUploadUrl: string;
  livenessPathname: string;
}

export interface VerifyPersonaResult {
  status: 'ok' | 'refused';
  reasons?: string[];
  ageMin?: number;
  ageMax?: number;
  baseLook?: PersonaLookView;
}

export interface DeletePersonaResult {
  /** `sessionId` — клиенту для `DELETE /sessions/:sessionId/shared-video/:id`. */
  publishedSharesWithPersona: { id: string; url: string; sessionId: string }[];
}

/** Что лежит в `Persona.verifyResult` (JSON). */
export interface StoredVerifyResult {
  status: 'ok' | 'refused';
  reasons: string[];
  /** То же, что `reasons`, — имя из контракта волны исправлений (CONTRACT5). */
  refusals: string[];
  checkedAt: string;
  /** Итог модели без возраста — для разбора жалоб; возраст — в своих колонках. */
  faces?: number;
  frontal?: boolean;
  quality?: string;
  screenOrPrint?: boolean;
  sameAsSelfie?: boolean;
  liveMotion?: boolean;
}

/** Причины отказа из JSON строки — не доверяя форме (колонка Json). */
export function refusalsOf(verifyResult: unknown): string[] | null {
  if (!verifyResult || typeof verifyResult !== 'object') return null;
  const v = verifyResult as {
    status?: unknown;
    reasons?: unknown;
    refusals?: unknown;
  };
  if (v.status !== 'refused') return null;
  const list = Array.isArray(v.refusals)
    ? v.refusals
    : Array.isArray(v.reasons)
      ? v.reasons
      : null;
  return list ? list.filter((r): r is string => typeof r === 'string') : null;
}
