/** Машинные коды голосовой карты (форма `{ error, code, message, … }`, как у кабинета голоса). */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { VoiceMapErrorCode } from './api-types';

export function voiceMapError(
  status: HttpStatus,
  code: VoiceMapErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}
