/**
 * Машинные коды кабинета голосового управления (та же форма, что у
 * кабинета голоса Э5: `{ error, code, message, errors? }`; TMA ветвится по
 * коду).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { VoiceControlCabinetErrorCode } from '../api-types';

export function voiceControlError(
  status: HttpStatus,
  code: VoiceControlCabinetErrorCode,
  message: string,
  extra: { errors?: Array<{ path: string; code: string }> } = {},
): HttpException {
  return new HttpException({ error: code, code, message, ...extra }, status);
}
