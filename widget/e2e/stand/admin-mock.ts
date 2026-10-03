/**
 * Мок «Админки» для e2e (Э7): ОТДЕЛЬНЫЙ origin `http://127.0.0.1:<порт
 * виджета>` (тот же процесс, другой Host — для браузера это другой origin,
 * как `wa.` против `w.` в проде). На нём, как на Vercel (`has host`),
 * работают ТОЛЬКО `/wa/v1/frame` и `/assist-admin/v1/*` (+ статика
 * `/v1/*`); публичные `/w/v1/*` и `/widget/v1/*` — 404.
 *
 * Бизнес-правила sites-backend (подпись JWT, сроки, тариф, роли) мок не
 * воспроизводит — их проверяет acceptance/e7 на настоящем сервере. Здесь —
 * форма протокола: сессия привязана к `sub`, state отдаёт только диалог
 * этого `sub`, подпись — заглушка `sig-ok` (иначе 401).
 */
import type http from 'node:http';
import crypto from 'node:crypto';

export const ADMIN_HOST_PREFIX = '127.0.0.1:';

interface AdminMsg {
  id: string;
  role: 'employee' | 'assistant';
  text: string;
  answerPath: string | null;
  rating: number | null;
}

const A = {
  sessions: new Map<string, { sub: string; exp: number }>(),
  dialogs: new Map<string, AdminMsg[]>(),
  log: [] as Array<{ path: string; sub: string | null }>,
};

export function adminReset(): void {
  A.sessions.clear();
  A.dialogs.clear();
  A.log.length = 0;
}

export function adminLog() {
  return { log: A.log, dialogs: Object.fromEntries(A.dialogs) };
}

export function isAdminHost(req: http.IncomingMessage): boolean {
  return (req.headers.host || '').startsWith(ADMIN_HOST_PREFIX);
}

/** Тестовый JWT: payload настоящий (base64url), подпись — `sig-ok`. */
export function testJwt(
  sub: string,
  iat = Math.floor(Date.now() / 1000)
): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, aud: 'site', iat, exp: iat + 600 })}.sig-ok`;
}

const FRAME_HTML = [
  '<!doctype html>',
  '<html lang="uk"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<link rel="stylesheet" href="/v1/admin-chat.css">',
  '<script src="/v1/admin-chat.js" defer></script>',
  '</head><body><div id="app"></div></body></html>',
].join('\n');

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify(
      status < 400
        ? { success: true, data: body }
        : { success: false, error: body }
    )
  );
}

async function body(
  req: http.IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

export async function adminRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  siteOrigins: string
): Promise<void> {
  const p = url.pathname;
  if (p === '/wa/v1/frame') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "connect-src 'self'",
        `frame-ancestors ${siteOrigins}`,
        "base-uri 'none'",
        "form-action 'none'",
        "require-trusted-types-for 'script'",
        "trusted-types 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    return void res.end(FRAME_HTML);
  }
  const token = String(req.headers['x-assist-admin-session'] || '');
  const sess = A.sessions.get(token) || null;
  A.log.push({ path: p, sub: sess?.sub ?? null });
  if (req.method === 'POST' && p === '/assist-admin/v1/session') {
    const b = await body(req);
    const jwt = typeof b.jwt === 'string' ? b.jwt : '';
    const [, payload, sig] = jwt.split('.');
    if (sig !== 'sig-ok' || !payload) {
      return json(res, 401, {
        code: 'ADMIN_IDENTITY_REJECTED',
        message: 'rejected',
      });
    }
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    const t = crypto.randomBytes(32).toString('base64url');
    A.sessions.set(t, { sub: claims.sub, exp: claims.exp });
    return json(res, 200, {
      session: t,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      sub: claims.sub,
      employee: { name: null, role: null },
      statsPerEmployee: false,
    });
  }
  if (p.startsWith('/assist-admin/v1/') && !sess) {
    return json(res, 401, {
      code: 'ADMIN_SESSION_INVALID',
      message: 'expired',
    });
  }
  if (req.method === 'GET' && p === '/assist-admin/v1/state') {
    return json(res, 200, {
      conversationId: null,
      version: 0,
      messages: A.dialogs.get(sess!.sub) ?? [],
      employee: { name: null, role: null, tools: false },
      statsPerEmployee: false,
    });
  }
  if (req.method === 'POST' && p === '/assist-admin/v1/chat') {
    const b = await body(req);
    const list = A.dialogs.get(sess!.sub) ?? [];
    const q: AdminMsg = {
      id: crypto.randomUUID(),
      role: 'employee',
      text: String(b.text ?? ''),
      answerPath: null,
      rating: null,
    };
    const a: AdminMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: `Відповідь для ${sess!.sub}: регламент знайдено.`,
      answerPath: 'knowledge',
      rating: null,
    };
    list.push(q, a);
    A.dialogs.set(sess!.sub, list);
    return json(res, 200, { question: q, answer: a, version: list.length });
  }
  if (req.method === 'POST' && p === '/assist-admin/v1/logout') {
    A.sessions.delete(token);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { code: 'NOT_FOUND', message: 'not found' });
}
