/** Машинные коды карты «Админки» (форма `{ error, code, message, … }`, как у карты «Сайта»). */
import { HttpException, HttpStatus } from '@nestjs/common';
import type {
  AdminEditorToolErrorCode,
  AdminVoiceMapErrorCode,
} from './api-types';

export function adminVoiceMapError(
  status: HttpStatus,
  code: AdminVoiceMapErrorCode | AdminEditorToolErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}
