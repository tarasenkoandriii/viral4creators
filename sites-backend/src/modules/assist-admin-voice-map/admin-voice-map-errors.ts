/** Машинные коды карты «Админки» (форма `{ error, code, message, … }`, как у карты «Сайта»). */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { AdminVoiceMapErrorCode } from './api-types';

export function adminVoiceMapError(
  status: HttpStatus,
  code: AdminVoiceMapErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}
