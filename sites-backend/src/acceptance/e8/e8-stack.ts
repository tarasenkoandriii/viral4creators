/**
 * Стенд приёмки Э8 «Админка: действия» — поверх стенда Э7 (настоящий
 * Postgres, гварды, `pinnedFetch` поверх https-стенда LocalSites) плюс:
 *  - фейк-модель, которая умеет ПРЕДЛОЖИТЬ действие (`proposer`) — «злая»
 *    модель предлагает что угодно, код обязан не исполнить без «Да»;
 *  - стенд-API магазина с состоянием заказов и идемпотентностью по
 *    `Idempotency-Key` (повтор с тем же ключом — тот же ответ, без дубля).
 */
import type { IncomingMessage } from 'http';
import type {
  GenerateRequest,
  GenerateResult,
} from '../../modules/site-ai/text-model';
import { E7Stack, FakeAdminText } from '../e7/e7-stack';

export { describeE7 as describeE8 } from '../e7/e7-stack';

export class FakeE8Text extends FakeAdminText {
  proposer: (
    user: string,
  ) => { operation: string; args: Record<string, unknown> } | null = () => null;

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (/планувальник/.test(req.system)) {
      this.calls.push(req);
      return {
        model: 'gemini-3.6-flash',
        inputTokens: 900,
        cachedInputTokens: 0,
        outputTokens: 30,
        text: JSON.stringify({
          calls: this.planner(req.user),
          propose: this.proposer(req.user),
        }),
      };
    }
    return super.generate(req);
  }
}

export class E8Stack extends E7Stack {
  override readonly text = new FakeE8Text();
}

export interface ShopOrder {
  id: string;
  status: string;
  total: number;
  notes: string[];
}

/** Стенд-API магазина: заказы, идемпотентность, счётчики изменений. */
export class ShopApi {
  readonly orders = new Map<string, ShopOrder>();
  readonly idem = new Map<string, { status: number; body: string }>();
  /** Применённые изменения (без повторов по ключу). */
  readonly applied: Array<{ op: string; key: string | null }> = [];
  refunds = 0;
  /** Текст, который API вернёт в заказе (инъекция в данных read). */
  injection: string | null = null;

  constructor() {
    for (const id of ['1042', '1043', '2001', '3001']) {
      this.orders.set(id, { id, status: 'paid', total: 1290, notes: [] });
    }
  }

  private json(status: number, body: unknown) {
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  /** Идемпотентно: тот же ключ — тот же ответ, без изменения. */
  private once(
    req: IncomingMessage,
    op: string,
    apply: () => { status: number; body: unknown },
  ) {
    const key = (req.headers['idempotency-key'] as string | undefined) ?? null;
    if (key && this.idem.has(key)) {
      const r = this.idem.get(key)!;
      return {
        status: r.status,
        headers: { 'content-type': 'application/json' },
        body: r.body,
      };
    }
    const r = apply();
    this.applied.push({ op, key });
    const body = JSON.stringify(r.body);
    if (key) this.idem.set(key, { status: r.status, body });
    return {
      status: r.status,
      headers: { 'content-type': 'application/json' },
      body,
    };
  }

  routes(): Record<
    string,
    (
      req: IncomingMessage,
      body: string,
    ) => {
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      delayMs?: number;
    }
  > {
    const out: ReturnType<ShopApi['routes']> = {};
    for (const id of this.orders.keys()) {
      out[`/v1/orders/${id}`] = (req, raw) => {
        const o = this.orders.get(id)!;
        if (req.method === 'GET') {
          return this.json(200, {
            ...o,
            ...(this.injection ? { comment: this.injection } : {}),
          });
        }
        if (req.method === 'PATCH') {
          return this.once(req, `patch:${id}`, () => {
            const b = JSON.parse(raw || '{}') as { status?: string };
            if (b.status === 'bogus')
              return {
                status: 422,
                body: { message: 'Статус bogus недопустим' },
              };
            if (b.status) o.status = b.status;
            return { status: 200, body: o };
          });
        }
        if (req.method === 'DELETE') {
          return this.once(req, `delete:${id}`, () => {
            o.status = 'deleted';
            return { status: 204, body: {} };
          });
        }
        return this.json(405, {});
      };
      out[`/v1/orders/${id}/cancel`] = (req) =>
        this.once(req, `cancel:${id}`, () => {
          this.orders.get(id)!.status = 'cancelled';
          return { status: 200, body: this.orders.get(id) };
        });
      out[`/v1/orders/${id}/notes`] = (req, raw) => {
        const r = this.once(req, `note:${id}`, () => {
          const b = JSON.parse(raw || '{}') as { text?: string };
          this.orders.get(id)!.notes.push(b.text ?? '');
          return { status: 201, body: { ok: true } };
        });
        // 2001 — «медленный» API: изменение применено, ответ опаздывает.
        return id === '2001' ? { ...r, delayMs: 1_500 } : r;
      };
    }
    out['/v1/refunds'] = (req) =>
      this.once(req, 'refund', () => {
        this.refunds++;
        return { status: 201, body: { ok: true } };
      });
    out['/v1/orders/bulk-cancel'] = (req, raw) =>
      this.once(req, 'bulk', () => {
        const b = JSON.parse(raw || '{}') as { ids?: string[] };
        for (const id of b.ids ?? []) {
          const o = this.orders.get(id);
          if (o) o.status = 'cancelled';
        }
        return { status: 200, body: { ok: true } };
      });
    return out;
  }
}

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
};

/** OpenAPI стенда с расширениями Э8 (`x-assist-*`). */
export function actionsSpec(
  apiHost: string,
  over: { compensationOfCancel?: unknown; compensationOfPatch?: unknown } = {},
): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Shop admin API' },
    servers: [{ url: `https://${apiHost}/v1` }],
    paths: {
      '/orders/{id}': {
        parameters: [idParam],
        get: {
          operationId: 'getOrder',
          summary: 'Заказ по номеру: статус, сумма',
        },
        patch: {
          operationId: 'updateOrderStatus',
          summary: 'Изменить статус заказа',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: {
                      type: 'string',
                      enum: ['new', 'paid', 'shipped', 'bogus'],
                    },
                  },
                },
              },
            },
          },
          'x-assist-preview': {
            operationId: 'getOrder',
            params: { id: '$.request.id' },
          },
          'x-assist-compensation': over.compensationOfPatch ?? {
            operationId: 'updateOrderStatus',
            params: { id: '$.request.id', status: '$.preview.status' },
          },
        },
        delete: { operationId: 'deleteOrder', summary: 'Удалить заказ' },
      },
      '/orders/{id}/cancel': {
        parameters: [idParam],
        post: {
          operationId: 'cancelOrder',
          summary: 'Отменить заказ',
          ...(over.compensationOfCancel
            ? { 'x-assist-compensation': over.compensationOfCancel }
            : {}),
        },
      },
      '/orders/{id}/restore': {
        parameters: [idParam],
        post: {
          operationId: 'restoreOrder',
          summary: 'Вернуть заказ в работу',
        },
      },
      '/orders/{id}/notes': {
        parameters: [idParam],
        post: {
          operationId: 'addNote',
          summary: 'Добавить заметку к заказу',
          'x-assist-idempotent': true,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['text'],
                  properties: { text: { type: 'string', maxLength: 500 } },
                },
              },
            },
          },
        },
      },
      '/refunds': {
        post: {
          operationId: 'createRefund',
          summary: 'Возврат денег клиенту',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['orderId', 'amount'],
                  properties: {
                    orderId: { type: 'string' },
                    amount: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
      '/orders/bulk-cancel': {
        post: {
          operationId: 'bulkCancel',
          summary: 'Массово отменить заказы',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ids'],
                  properties: {
                    ids: {
                      type: 'array',
                      items: { type: 'string' },
                      maxItems: 20,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}
