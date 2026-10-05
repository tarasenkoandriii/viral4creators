/**
 * Отказы голосового управления «Админкой» с машинным кодом (TMA и iframe
 * `wa.` ветвятся по `code`). Текст — человеческий, без ПД, снимка и
 * значений полей.
 */
import { HttpException } from '@nestjs/common';

export type AdminVoiceErrorCode =
  | 'ADMIN_VC_INVALID'
  | 'ADMIN_VC_PLAN_REQUIRED'
  | 'ADMIN_VC_MODE_REQUIRED'
  | 'ADMIN_VC_VOICE_REQUIRED'
  | 'ADMIN_VC_RISKS_REQUIRED'
  | 'ADMIN_VC_SITE_NAME'
  | 'ADMIN_VC_TEST_REQUIRED'
  | 'ADMIN_VC_HOST_REQUIRED'
  | 'ADMIN_VC_TEST_NOT_FOUND'
  | 'ADMIN_VC_OFF'
  | 'ADMIN_VC_NOT_FOUND'
  | 'ADMIN_VC_EXPIRED'
  | 'ADMIN_VC_CONFLICT'
  | 'ADMIN_VC_CHANGED'
  | 'ADMIN_VC_BAD_REQUEST'
  | 'ADMIN_VC_LIMIT'
  | 'ADMIN_VC_UPSTREAM'
  | 'ADMIN_VC_TOO_LARGE'
  | 'ADMIN_VC_AUDIO_INVALID'
  | 'ADMIN_VC_NOT_HEARD';

export function adminVoiceError(
  status: number,
  code: AdminVoiceErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}

/** Отказы маршрутов плана сотрудника → HTTP (как «Сайт», свои коды). */
export type AdminPlanFailure =
  | 'bad_request'
  | 'off'
  | 'not_found'
  | 'expired'
  | 'conflict'
  | 'changed'
  | 'limit'
  | 'upstream'
  | 'too_large';

export class AdminPlanError extends Error {
  constructor(readonly failure: AdminPlanFailure) {
    super(failure);
    this.name = 'AdminPlanError';
  }
}

export const failPlan = (f: AdminPlanFailure): never => {
  throw new AdminPlanError(f);
};

const HTTP: Record<AdminPlanFailure, [number, AdminVoiceErrorCode, string]> = {
  bad_request: [400, 'ADMIN_VC_BAD_REQUEST', 'Неверный запрос'],
  off: [
    409,
    'ADMIN_VC_OFF',
    'Голосовое управление админкой на этом сайте не включено',
  ],
  not_found: [404, 'ADMIN_VC_NOT_FOUND', 'План не найден'],
  expired: [410, 'ADMIN_VC_EXPIRED', 'План устарел — скажите команду ещё раз'],
  conflict: [409, 'ADMIN_VC_CONFLICT', 'План уже изменился'],
  changed: [
    409,
    'ADMIN_VC_CHANGED',
    'План изменился после карточки — подтвердите заново',
  ],
  limit: [429, 'ADMIN_VC_LIMIT', 'Слишком много команд — подождите'],
  upstream: [
    502,
    'ADMIN_VC_UPSTREAM',
    'Не удалось построить план — повторите или нажмите сами',
  ],
  too_large: [
    413,
    'ADMIN_VC_TOO_LARGE',
    'Страница слишком большая для голосового управления',
  ],
};

export function planHttpError(e: unknown): never {
  if (e instanceof AdminPlanError) {
    const [s, c, m] = HTTP[e.failure];
    throw adminVoiceError(s, c, m);
  }
  throw e;
}
