import { HttpException } from '@nestjs/common';
import { AdminAssistClient } from './admin-assist.client';
import { AdminAssistController } from './admin-assist.controller';
import type { AdminPanelService } from './admin-panel.service';
import type { AdminAuthenticatedRequest } from '../admin-auth/admin-session.guard';

const SECRET = 'assist-internal-secret-1234';

function client(over: Record<string, string | undefined> = {}) {
  const c = new AdminAssistClient();
  c.env = {
    SITES_BACKEND_URL: 'https://sites.example.com/ignored-path',
    SITES_INTERNAL_SECRET: SECRET,
    ...over,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: { status: number; body: unknown } = {
    status: 200,
    body: { success: true, data: { ok: 1 } },
  };
  c.fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return {
    c,
    calls,
    reply: (r: typeof reply) => {
      reply = r;
    },
  };
}

describe('AdminAssistClient — внутренний API sites-backend (Э4)', () => {
  it('без адреса или с коротким секретом — 503 и ни одного запроса', async () => {
    for (const env of [
      { SITES_BACKEND_URL: undefined },
      { SITES_INTERNAL_SECRET: 'short' },
      { SITES_BACKEND_URL: 'http://evil.example.com' },
    ]) {
      const { c, calls } = client(env);
      expect(c.configured()).toBe(false);
      await expect(c.call('GET', '/summary', 'u1')).rejects.toMatchObject({
        status: 503,
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('секрет и оператор — в заголовках; origin без пути; ответ — data из конверта', async () => {
    const { c, calls } = client();
    await expect(
      c.call('POST', '/accounts/a1/plan', 'user-9', {
        planId: 'pro',
        days: 30,
      }),
    ).resolves.toEqual({ ok: 1 });
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/assist/accounts/a1/plan',
    );
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['X-Sites-Internal-Secret']).toBe(SECRET);
    expect(h['X-Admin-Actor']).toBe('user-9');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      planId: 'pro',
      days: 30,
    });
  });

  it('4xx sites-backend — тот же код и текст; 401 — 502 «секреты не совпадают»; сеть — 502', async () => {
    const { c, reply } = client();
    reply({
      status: 409,
      body: {
        success: false,
        error: { code: 'NO_CONSENT', message: 'нет согласия' },
      },
    });
    const e = (await c
      .call('POST', '/review/m/eval', 'u')
      .catch((x: unknown) => x)) as HttpException;
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      error: 'NO_CONSENT',
      message: 'нет согласия',
    });
    reply({ status: 401, body: {} });
    await expect(c.call('GET', '/summary', 'u')).rejects.toMatchObject({
      status: 502,
    });
    c.fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(c.call('GET', '/summary', 'u')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('контроллер: сначала assertOperator (не оператор — до sites-backend не доходит), id чистится', async () => {
    const { c, calls } = client();
    const panel = {
      assertOperator: jest.fn(async (id: string) => {
        if (id !== 'op')
          throw new HttpException('Operator access required', 403);
      }),
    } as unknown as AdminPanelService;
    const ctl = new AdminAssistController(panel, c);
    const req = (userId: string) => ({ userId }) as AdminAuthenticatedRequest;
    await expect(ctl.summary(req('nobody'), '7')).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toHaveLength(0);
    await ctl.account(req('op'), '../../etc');
    expect(calls[0].url).toBe(
      'https://sites.example.com/internal/admin/assist/accounts/invalid',
    );
    await ctl.accounts(req('op'), 'shop.example.com', undefined);
    expect(calls[1].url).toBe(
      'https://sites.example.com/internal/admin/assist/accounts?q=shop.example.com',
    );
  });
});
