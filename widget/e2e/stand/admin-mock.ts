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
  proposalId?: string | null;
}

/** Э8: предложение действия — форма ответа sites-backend (ProposalView). */
interface AdminProposal {
  id: string;
  sub: string;
  status: string;
  kind: 'write' | 'danger';
  title: string;
  fields: Array<{ name: string; before?: string | null; after: string }>;
  paramsHash: string;
  unrequested: boolean;
  confirmPhrase: string | null;
  idempotent: boolean;
  undoDeclared: boolean;
  undoAvailable: boolean;
  checkAvailable: boolean;
  dryRun: string;
  dryRunStatus: string | null;
  dryRunNote: string | null;
  amount: number | null;
  errorText: string | null;
  compensationOf: string | null;
  memo: null;
  /** Мок: первое «Да» — `unknown` (API не ответил вовремя). */
  flaky?: boolean;
}

const A = {
  sessions: new Map<string, { sub: string; exp: number }>(),
  dialogs: new Map<string, AdminMsg[]>(),
  log: [] as Array<{ path: string; sub: string | null }>,
  proposals: new Map<string, AdminProposal>(),
  /** Исполнения «Да» на «стенд-API» (приёмка §4-бис.10 п.4 (б): ровно одно). */
  execs: [] as string[],
};

export function adminReset(): void {
  A.sessions.clear();
  A.dialogs.clear();
  A.log.length = 0;
  A.proposals.clear();
  A.execs.length = 0;
}

export function adminLog() {
  return {
    log: A.log,
    dialogs: Object.fromEntries(A.dialogs),
    execs: A.execs,
  };
}

function proposalFor(sub: string, text: string): AdminProposal | null {
  const danger = /видали|удали|delete/i.test(text);
  if (!danger && !/зміни|измени|change/i.test(text)) return null;
  return {
    id: crypto.randomUUID(),
    sub,
    status: 'pending',
    kind: danger ? 'danger' : 'write',
    title: danger ? 'Видалити замовлення' : 'Змінити статус замовлення',
    fields: danger
      ? [{ name: 'id', after: '1042' }]
      : [
          { name: 'id', after: '1042' },
          { name: 'status', before: 'paid', after: 'shipped' },
        ],
    paramsHash: crypto.createHash('sha256').update(text).digest('hex'),
    unrequested: false,
    confirmPhrase: danger ? 'ПІДТВЕРДЖУЮ 1' : null,
    idempotent: false,
    undoDeclared: !danger,
    undoAvailable: false,
    checkAvailable: false,
    dryRun: danger ? 'none' : 'preview',
    dryRunStatus: danger ? null : 'ok',
    dryRunNote: null,
    amount: null,
    errorText: null,
    compensationOf: null,
    memo: null,
    flaky: /таймаут/i.test(text),
  };
}

const view = (p: AdminProposal) => {
  const { sub: _sub, flaky: _flaky, ...rest } = p;
  void _sub;
  void _flaky;
  return rest;
};

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
      proposals: [...A.proposals.values()]
        .filter((x) => x.sub === sess!.sub)
        .map(view),
    });
  }
  const pm =
    /^\/assist-admin\/v1\/proposals\/([0-9a-f-]{36})\/(confirm|reject)$/.exec(
      p
    );
  if (req.method === 'POST' && pm) {
    const pr = A.proposals.get(pm[1]);
    if (!pr || pr.sub !== sess!.sub) {
      return json(res, 404, { code: 'PROPOSAL_NOT_FOUND', message: 'nf' });
    }
    const b = await body(req);
    if (pm[2] === 'reject') {
      if (pr.status === 'pending') pr.status = 'rejected';
      return json(res, 200, { proposal: view(pr), text: '', next: null });
    }
    if (pr.status !== 'pending' && pr.status !== 'unknown') {
      // Повторное «Да» (перезагрузка) — тот же итог, без исполнения.
      return json(res, 200, { proposal: view(pr), text: '', next: null });
    }
    if (b.paramsHash !== pr.paramsHash) {
      return json(res, 409, { code: 'PROPOSAL_CHANGED', message: 'changed' });
    }
    if (
      pr.confirmPhrase &&
      String(b.phrase ?? '')
        .trim()
        .toUpperCase() !== pr.confirmPhrase
    ) {
      return json(res, 422, { code: 'PROPOSAL_PHRASE', message: 'phrase' });
    }
    if (
      pr.status === 'unknown' &&
      !pr.idempotent &&
      b.acknowledgeRisk !== true
    ) {
      return json(res, 409, { code: 'PROPOSAL_RISK_ACK', message: 'ack' });
    }
    A.execs.push(pr.id);
    if (pr.flaky && pr.status === 'pending') {
      // Как sites-backend: таймаут write — `unknown`, повтор — новым «Да».
      pr.status = 'unknown';
      return json(res, 200, { proposal: view(pr), text: '', next: null });
    }
    pr.status = 'done';
    pr.undoAvailable = pr.undoDeclared;
    const list = A.dialogs.get(sess!.sub) ?? [];
    list.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      text: `Готово: ${pr.title}.`,
      answerPath: 'action',
      rating: null,
      proposalId: pr.id,
    });
    A.dialogs.set(sess!.sub, list);
    return json(res, 200, { proposal: view(pr), text: 'Готово', next: null });
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
    const prop = proposalFor(sess!.sub, q.text);
    if (prop) A.proposals.set(prop.id, prop);
    const a: AdminMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: prop
        ? `Я збираюсь: ${prop.title}. Підтвердьте у картці.`
        : `Відповідь для ${sess!.sub}: регламент знайдено.`,
      answerPath: prop ? 'action' : 'knowledge',
      rating: null,
      proposalId: prop?.id ?? null,
    };
    list.push(q, a);
    A.dialogs.set(sess!.sub, list);
    return json(res, 200, {
      question: q,
      answer: { ...a, proposal: prop ? view(prop) : null },
      version: list.length,
    });
  }
  if (req.method === 'POST' && p === '/assist-admin/v1/logout') {
    A.sessions.delete(token);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { code: 'NOT_FOUND', message: 'not found' });
}
