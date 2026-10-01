/**
 * ResponseInterceptor — единый конверт успешного ответа, как у backend:
 * `{ success: true, data, meta: { timestamp, requestId } }`.
 *
 * Контроллеры возвращают ГОЛЫЕ данные; обёртку добавляет только этот
 * перехватчик. Фронтенд (`assist/`, `site-tma-kit`) разбирает конверт
 * один раз — двойная обёртка в контроллере сломала бы его молча.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';

export interface ApiResponse<T> {
  success: true;
  data: T;
  meta: {
    timestamp: string;
    requestId: string;
  };
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        meta: {
          timestamp: new Date().toISOString(),
          requestId: uuidv4(),
        },
      })),
    );
  }
}
