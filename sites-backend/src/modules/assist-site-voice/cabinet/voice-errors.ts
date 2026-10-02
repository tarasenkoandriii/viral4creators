/**
 * Машинные коды кабинета голоса (та же форма, что у кабинета виджета Э2 —
 * `assist-site-setup/errors.ts`: `{ error, code, message, errors? }`; TMA
 * ветвится по коду).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { VoiceCabinetErrorCode } from '../api-types';

export function voiceCabinetError(
  status: HttpStatus,
  code: VoiceCabinetErrorCode,
  message: string,
  extra: { errors?: Array<{ path: string; code: string }> } = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}
