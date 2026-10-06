/**
 * Мок редактора голосовой карты для e2e (Э6-тер): ОТДЕЛЬНЫЙ origin
 * `http://127.0.0.2:<порт виджета>` (тот же процесс, другой Host — для
 * браузера другой origin, как `we.` против `w.` в проде; пикер выводит его
 * из origin виджета `localhost` — editor-protocol.ts `panelOrigin`). На нём,
 * как на Vercel (`has host`), работают ТОЛЬКО `/we/v1/frame` и
 * `/editor/v1/*` (+ статика `/v1/*`).
 *
 * Бизнес-правила sites-backend (риск только вверх, ворота, тенант, хосты)
 * мок не воспроизводит — их проверяет acceptance/e6t на настоящем сервере.
 * Здесь — форма протокола: одноразовый обмен ссылки с origin родителя,
 * сессия-заголовок, ревизия черновика, журнал операций (для «0 изменений
 * без клика человека»).
 */
import type http from 'node:http';
import crypto from 'node:crypto';

export const EDITOR_HOST_PREFIX = '127.0.0.2:';

interface Target {
  key: string;
  [k: string]: unknown;
}

const E = {
  links: new Map<string, { origin: string; used: boolean }>(),
  sessions: new Set<string>(),
  revision: 0,
  targets: new Map<string, Target>(),
  log: [] as Array<{ path: string; body: unknown }>,
  publishAttempts: 0,
};

export function editorReset(): void {
  E.links.clear();
  E.sessions.clear();
  E.revision = 0;
  E.targets.clear();
  E.log.length = 0;
  E.publishAttempts = 0;
}

export function editorLink(token: string, origin: string): void {
  E.links.set(token, { origin, used: false });
}

export function editorLog() {
  return {
    log: E.log,
    revision: E.revision,
    targets: [...E.targets.values()],
    publishAttempts: E.publishAttempts,
  };
}

export function isEditorHost(req: http.IncomingMessage): boolean {
  return (req.headers.host || '').startsWith(EDITOR_HOST_PREFIX);
}

const FRAME_HTML = [
  '<!doctype html>',
  '<html lang="uk"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<link rel="stylesheet" href="/v1/editor-panel.css">',
  '<script src="/v1/editor-panel.js" defer></script>',
  '</head><body><div id="app"></div></body></html>',
].join('\n');

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const ok = (res: http.ServerResponse, data: unknown) =>
  json(res, 200, { success: true, data });
const err = (res: http.ServerResponse, status: number, code: string) =>
  json(res, status, {
    success: false,
    error: { code, message: code, details: { code } },
  });

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

function mapView(path: string) {
  const targets = [...E.targets.values()];
  return {
    revision: E.revision,
    publishedVersion: 0,
    path,
    template: null,
    templates: [],
    targets,
    keys: targets.map((t) => t.key),
    gates: { ok: true, problems: [] },
  };
}

export async function editorRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ancestors: string
): Promise<void> {
  const p = url.pathname;
  if (p === '/we/v1/frame') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        `frame-ancestors ${ancestors}`,
        "base-uri 'none'",
        "form-action 'none'",
        "require-trusted-types-for 'script'",
        "trusted-types 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    return void res.end(FRAME_HTML);
  }
  if (!p.startsWith('/editor/v1/')) return err(res, 404, 'NOT_FOUND');
  const b = req.method === 'POST' ? await body(req) : {};
  E.log.push({ path: p, body: b });
  if (p === '/editor/v1/session') {
    const link = E.links.get(String(b.token || ''));
    if (!link || link.used || link.origin !== b.parentOrigin)
      return err(res, 403, 'EDITOR_LINK_INVALID');
    link.used = true;
    const s = crypto.randomBytes(24).toString('base64url');
    E.sessions.add(s);
    return ok(res, {
      session: s,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 14_400_000).toISOString(),
      pagePath: '/',
      focusKey: null,
      host: 'shop',
    });
  }
  if (!E.sessions.has(String(req.headers['x-assist-editor'] || '')))
    return err(res, 401, 'EDITOR_SESSION_EXPIRED');
  switch (p) {
    case '/editor/v1/map':
      return ok(res, mapView(url.searchParams.get('path') || '/'));
    case '/editor/v1/ops': {
      if (b.expectedRevision !== E.revision)
        return err(res, 409, 'VOICE_MAP_CONFLICT');
      for (const op of (b.ops as Array<Record<string, unknown>>) || []) {
        if (op.op === 'upsert-target') {
          const t = op.target as Record<string, unknown>;
          const prev = E.targets.get(String(t.key));
          const d = (t.descriptor ?? prev?.descriptor) as Record<
            string,
            unknown
          >;
          E.targets.set(String(t.key), {
            ...t,
            key: String(t.key),
            descriptor: d,
            stability: d && d.assistId ? 'strong' : 'medium',
            riskComputed: 'confirm',
            synonyms: (t.synonyms as object) || {},
            names: (t.names as object) || {},
            status: 'active',
          });
        } else if (op.op === 'remove-target') E.targets.delete(String(op.key));
      }
      E.revision++;
      return ok(res, { revision: E.revision, applied: 1 });
    }
    case '/editor/v1/try': {
      const snap = b.snapshot as {
        elements?: Array<{ ref: string; text: string }>;
      };
      const text = String(b.text || '').toLowerCase();
      const el = (snap?.elements || []).find(
        (e) => e.text && text.includes(e.text.toLowerCase())
      );
      return ok(res, {
        heard: b.text,
        via: el ? 'direct' : 'model_needed',
        key: null,
        phrase: null,
        steps: el
          ? [
              {
                i: 0,
                kind: 'click',
                risk: 'confirm',
                target: { ref: el.ref, text: el.text },
              },
            ]
          : [],
        notes: [],
        left: 99,
      });
    }
    // Э6-тер (д): мемо в редакторе — форма протокола (правила — acceptance/e6t).
    case '/editor/v1/memo/record/start':
      return ok(res, {
        page: b.path,
        maxSteps: 6,
        limit: { used: 0, max: 20 },
        memo: null,
      });
    case '/editor/v1/memo/record/step': {
      const d = (b.descriptor || {}) as Record<string, unknown>;
      const text = String(d.text || '');
      const pin = { text, assistId: d.assistId ?? null, role: d.role ?? null };
      const st = (action: string, value: unknown = null) => ({
        page: b.path,
        action,
        target: { uiElementId: null, key: null, pin },
        value,
        expect: d.hrefPath ? { path: d.hrefPath } : null,
        say: null,
        risk: null,
      });
      if (/оплат/i.test(text))
        return ok(res, {
          kind: 'stop',
          reason: 'payment',
          step: st('highlight'),
        });
      if (d.tag === 'input')
        return ok(res, {
          kind: 'step',
          step: st('fill', { slot: String(b.fieldName || 'text') }),
          slot: {
            name: String(b.fieldName || 'text'),
            kind: 'text',
            pii: false,
            options: [],
          },
          risk: 'confirm',
          exec: false,
        });
      const exec = d.assistId === 'add-to-cart' || d.tag === 'a';
      return ok(res, {
        kind: 'step',
        step: st('click'),
        slot: null,
        risk: exec ? 'auto' : 'confirm',
        exec,
      });
    }
    case '/editor/v1/memo/record/stop':
      return ok(res, {
        number: 1,
        key: 'm1',
        status: 'draft',
        draftRevision: 0,
        gates: { ok: true, problems: [] },
      });
    case '/editor/v1/memo/m1/try': {
      const snap = b.snapshot as {
        elements?: Array<{ ref: string; text: string }>;
      };
      const e = (snap?.elements || []).find((x) => x.text === 'В кошик');
      return ok(res, {
        steps: [
          {
            i: 0,
            action: 'click',
            text: 'В кошик',
            ok: !!e,
            problem: e ? null : 'missing',
            ref: e ? e.ref : null,
          },
        ],
        stopAt: e ? null : 0,
        problem: e ? null : 'missing',
        next: null,
        goal: 'ok',
        done: !!e,
        left: 98,
      });
    }
    case '/editor/v1/publish-request':
      return ok(res, { number: 1, status: 'checking' });
    case '/editor/v1/publish':
      E.publishAttempts++;
      return err(res, 403, 'EDITOR_PUBLISH_FORBIDDEN');
    case '/editor/v1/exit':
      return ok(res, { ok: true });
    default:
      return err(res, 404, 'NOT_FOUND');
  }
}
