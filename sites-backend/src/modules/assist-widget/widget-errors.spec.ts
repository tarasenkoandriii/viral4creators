/**
 * Интеграция Э2: один код ошибки — один HTTP-статус во всём публичном API
 * виджета (W2 — widgetError, W3 — chatError бросаются из одних маршрутов).
 * Раньше `WIDGET_DISABLED` у W2 был 403, а у W3 (лид без ключа) — 503.
 */
import { HttpException } from '@nestjs/common';
import {
  SITE_CHAT_ERROR_STATUS,
  chatError,
  type SiteChatErrorCode,
} from '../assist-site-chat/chat-errors';
import { WIDGET_ERROR_CODES } from './api-types';
import { WIDGET_ERROR_STATUS, widgetError } from './widget-errors';

describe('коды ошибок виджета: W2 и W3 согласованы', () => {
  it('каждый код W3 есть в WIDGET_ERROR_CODES и имеет тот же статус', () => {
    for (const code of Object.keys(
      SITE_CHAT_ERROR_STATUS,
    ) as SiteChatErrorCode[]) {
      expect(WIDGET_ERROR_CODES).toContain(code);
      expect(chatError(code, 'x').getStatus()).toBe(
        WIDGET_ERROR_STATUS[code as keyof typeof WIDGET_ERROR_STATUS],
      );
    }
    expect(chatError('WIDGET_DISABLED', 'x').getStatus()).toBe(403);
  });

  it('UPSTREAM — код REST (502) для JSON-пути чата', () => {
    expect(WIDGET_ERROR_CODES).toContain('UPSTREAM');
    const e = widgetError('UPSTREAM');
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(502);
    expect((e.getResponse() as { error: string }).error).toBe('UPSTREAM');
  });

  it('errors[] лида — на верхнем уровне тела (фильтр пропускает только его)', () => {
    const body = chatError('LEAD_INVALID', 'x', {
      errors: [{ field: 'phone', code: 'format' }],
    }).getResponse() as Record<string, unknown>;
    expect(body.errors).toEqual([{ field: 'phone', code: 'format' }]);
    expect(body.details).toBeUndefined();
  });
});
