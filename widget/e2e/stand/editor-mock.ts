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
 *
 * Заход 11 (№117): тот же мок — панель карты «Админки» на origin «Админки»
 * (`127.0.0.1`, admin-mock.ts): `/wa/v1/editor-frame` (метка контура в
 * разметке) и `/assist-admin/v1/editor/*` — те же тела, плюс сессия
 * сотрудника `X-Assist-Admin-Session`; сессия редактора привязана к ней
 * (другая сессия сотрудника — 401, как на сервере).
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
  /** Заход 11: сессия редактора → сессия сотрудника «Админки» ('' — «Сайт»). */
  bound: new Map<string, string>(),
  /** Раунд исправлений: зоны владельца «Админки» (denySelectors/allowSelectors). */
  deny: [] as string[],
  allow: [] as string[],
  revision: 0,
  targets: new Map<string, Target>(),
  templates: [] as Array<Record<string, unknown>>,
  /** Заход 9: байты последней записи «Сказать сейчас» (`/editor/v1/voice`). */
  voiceBytes: 0,
  log: [] as Array<{ path: string; body: unknown }>,
  publishAttempts: 0,
  /** Заход 10 (№113): «не предлагать» — id предложений. */
  muted: new Set<string>(),
  /** Заход 11 (№113): термины черновика (принятые из распознавания). */
  terms: [] as string[],
};

export function editorReset(): void {
  E.links.clear();
  E.sessions.clear();
  E.bound.clear();
  E.deny = [];
  E.allow = [];
  E.revision = 0;
  E.targets.clear();
  E.templates = [];
  E.voiceBytes = 0;
  E.log.length = 0;
  E.publishAttempts = 0;
  E.muted.clear();
  E.terms = [];
}

export function editorZones(deny: string[], allow: string[]): void {
  E.deny = deny;
  E.allow = allow;
}

export function editorLink(token: string, origin: string): void {
  E.links.set(token, { origin, used: false });
}

export function editorLog() {
  return {
    log: E.log,
    revision: E.revision,
    targets: [...E.targets.values()],
    templates: E.templates,
    voiceBytes: E.voiceBytes,
    publishAttempts: E.publishAttempts,
    terms: E.terms,
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
/** Заход 11: HTML панели «Админки» — тот же чанк + метка контура (как сервер). */
const ADMIN_FRAME_HTML = FRAME_HTML.replace(
  '<link',
  '<meta name="v4c-editor-kind" content="admin">\n<link'
);

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

function mapView(path: string, admin: boolean) {
  const targets = [...E.targets.values()];
  return {
    ...(admin ? { denySelectors: E.deny, allowSelectors: E.allow } : {}),
    revision: E.revision,
    publishedVersion: 0,
    path,
    template: null,
    templates: E.templates,
    targets,
    keys: targets.map((t) => t.key),
    gates: { ok: true, problems: [] },
  };
}

/**
 * `admin` — только для origin «Админки»: сессия сотрудника из заголовка
 * (''/нет — не вошёл); маршруты `/assist-admin/v1/editor/*` = `/editor/v1/*`.
 */
export async function editorRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ancestors: string,
  admin?: string,
  /** «Админка»: `sub` сессии сотрудника (и истёкшей) — для `rebind`. */
  subOf: (token: string) => string | null = () => null
): Promise<void> {
  const isAdmin = admin !== undefined;
  let p = url.pathname;
  if (isAdmin) {
    if (p !== '/wa/v1/editor-frame') {
      if (!p.startsWith('/assist-admin/v1/editor/'))
        return err(res, 404, 'NOT_FOUND');
      if (!admin) {
        E.log.push({ path: p, body: null });
        return err(res, 401, 'ADMIN_SESSION_INVALID');
      }
      p = p.replace('/assist-admin/v1/editor/', '/editor/v1/');
    }
  }
  if (p === '/we/v1/frame' || (isAdmin && p === '/wa/v1/editor-frame')) {
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
    return void res.end(isAdmin ? ADMIN_FRAME_HTML : FRAME_HTML);
  }
  if (!p.startsWith('/editor/v1/')) return err(res, 404, 'NOT_FOUND');
  // Заход 9: запись микрофона — сырое тело `audio/*` (как на сервере).
  if (p === '/editor/v1/voice') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    E.log.push({ path: p, body: { type: req.headers['content-type'] } });
    if (!E.sessions.has(String(req.headers['x-assist-editor'] || '')))
      return err(res, 401, 'EDITOR_SESSION_EXPIRED');
    if (!/^audio\//.test(String(req.headers['content-type'] || '')))
      return err(res, 400, 'EDITOR_VOICE_AUDIO_INVALID');
    E.voiceBytes = Buffer.concat(chunks).length;
    return ok(res, { text: 'натисни в кошик', lang: 'uk', left: 97 });
  }
  const b = req.method === 'POST' ? await body(req) : {};
  E.log.push({ path: url.pathname, body: b });
  if (p === '/editor/v1/session') {
    const link = E.links.get(String(b.token || ''));
    if (!link || link.used || link.origin !== b.parentOrigin)
      return err(res, 403, 'EDITOR_LINK_INVALID');
    link.used = true;
    const s = crypto.randomBytes(24).toString('base64url');
    E.sessions.add(s);
    E.bound.set(s, admin ?? '');
    return ok(res, {
      session: s,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 14_400_000).toISOString(),
      pagePath: '/',
      focusKey: null,
      host: 'shop',
      ...(isAdmin ? { kind: 'admin' } : {}),
    });
  }
  const es = String(req.headers['x-assist-editor'] || '');
  // Раунд исправлений: перепривязка к новой сессии ТОГО ЖЕ сотрудника.
  if (isAdmin && p === '/editor/v1/rebind') {
    const old = E.bound.get(es);
    if (!E.sessions.has(es) || !old || subOf(old) !== subOf(admin!))
      return err(res, 401, 'EDITOR_SESSION_EXPIRED');
    E.bound.set(es, admin!);
    return ok(res, {
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 14_400_000).toISOString(),
    });
  }
  if (!E.sessions.has(es) || E.bound.get(es) !== (admin ?? ''))
    return err(res, 401, 'EDITOR_SESSION_EXPIRED');
  switch (p) {
    case '/editor/v1/map':
      return ok(res, mapView(url.searchParams.get('path') || '/', isAdmin));
    case '/editor/v1/ops': {
      if (b.expectedRevision !== E.revision)
        return err(res, 409, 'VOICE_MAP_CONFLICT');
      const list = (b.ops as Array<Record<string, unknown>>) || [];
      // Как сервер: id нового шаблона выдаёт сервер; цель шаблона — только
      // на существующий id (иначе 422 весь пакет).
      for (const op of list) {
        const t = op.target as Record<string, unknown> | undefined;
        if (
          op.op === 'upsert-target' &&
          t?.scope === 'template' &&
          !E.templates.some((x) => x.id === t.templateId)
        )
          return json(res, 422, {
            success: false,
            error: {
              code: 'VOICE_MAP_INVALID',
              message: 'bad_target',
              details: {
                code: 'VOICE_MAP_INVALID',
                errors: [{ code: 'bad_target' }],
              },
            },
          });
      }
      for (const op of list) {
        if (op.op === 'upsert-template') {
          const t = op.template as Record<string, unknown>;
          E.templates.push({
            ...t,
            id: `t-srv${E.templates.length + 1}`,
            status: 'active',
          });
        } else if (op.op === 'upsert-target') {
          const t = op.target as Record<string, unknown>;
          const prev = E.targets.get(String(t.key));
          const d = (t.descriptor ?? prev?.descriptor) as Record<
            string,
            unknown
          >;
          // Как сервер: правка без поля — прежнее значение цели (№113:
          // принять ИИ-синоним — `{ key, synonyms }`).
          E.targets.set(String(t.key), {
            ...prev,
            ...t,
            key: String(t.key),
            descriptor: d,
            stability: d && d.assistId ? 'strong' : 'medium',
            riskComputed: 'confirm',
            synonyms: (t.synonyms as object) || prev?.synonyms || {},
            names: (t.names as object) || prev?.names || {},
            status: 'active',
          });
        } else if (op.op === 'add-synonym') {
          // Заход 11: «перепривязати» к существующей цели.
          const t = E.targets.get(String(op.key));
          if (t) {
            const syn = { ...((t.synonyms as object) || {}) } as Record<
              string,
              Array<{ text: string; origin: string }>
            >;
            const l = String(op.lang);
            syn[l] = [
              ...(syn[l] || []),
              { text: String(op.text), origin: 'owner' },
            ];
            t.synonyms = syn;
          }
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
    case '/editor/v1/memo/list':
      return ok(res, {
        items: [
          {
            number: 3,
            key: 'koshyk',
            name: 'Кошик',
            status: 'published',
            page: '/page',
            steps: 2,
          },
        ],
        limit: { used: 1, max: 20 },
      });
    case '/editor/v1/memo/record/wait': {
      const d = (b.descriptor || {}) as Record<string, unknown>;
      const text = String(d.text || '');
      return /\d/.test(text)
        ? ok(res, {
            kind: 'counter',
            target: {
              assistId: d.assistId ?? null,
              text: text.replace(/[\d()]/g, '').trim(),
            },
            delta: 1,
            now: 0,
          })
        : ok(res, { kind: 'appear', text });
    }
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
        // Заход 9: «Як скасувати» цели карты (стандартная пара разметки).
        undo:
          d.assistId === 'add-to-cart'
            ? {
                assistId: 'remove-from-cart',
                at: null,
                src: 'standard',
                key: 'add-to-cart',
              }
            : null,
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
    // Заход 10 (№113): ИИ-синонимы, «Промахи», «Предложения».
    case '/editor/v1/suggest-synonyms': {
      if (b.expectedRevision !== E.revision)
        return err(res, 409, 'VOICE_MAP_CONFLICT');
      const t = E.targets.get(String(b.key));
      if (!t) return err(res, 400, 'EDITOR_BAD_REQUEST');
      const syn = (t.synonyms || {}) as Record<
        string,
        Array<{ text: string; origin: string }>
      >;
      const add = ['подарунок', 'упаковка'].filter(
        (x) => !E.muted.has(`ai:${t.key}:uk:${x}`)
      );
      syn.uk = [
        ...(syn.uk || []),
        ...add.map((text) => ({ text, origin: 'suggested' })),
      ];
      t.synonyms = syn;
      E.revision++;
      return ok(res, {
        revision: E.revision,
        key: t.key,
        langs: ['uk'],
        kept: { uk: add.length },
        dropped: {},
      });
    }
    case '/editor/v1/misses': {
      const k = [...E.targets.keys()][0];
      return ok(res, {
        days: 7,
        path: url.searchParams.get('path') || '/',
        items: k
          ? [
              {
                key: k,
                page: '/',
                self: 3,
                notFound: 0,
                wrong: 1,
                missed: 0,
                done: 2,
                last: new Date().toISOString(),
              },
            ]
          : [],
        // Заход 11: тепловые значки (все цели страницы с шагами) и «не туди».
        heat: k
          ? [
              {
                key: k,
                page: '/',
                self: 3,
                notFound: 0,
                wrong: 1,
                missed: 0,
                done: 2,
                last: new Date().toISOString(),
              },
            ]
          : [],
        wrong: k
          ? [
              {
                id: 'd'.repeat(24),
                key: k,
                phrase: 'доставка',
                lang: 'uk',
                count: 2,
                visitors: 2,
              },
            ]
          : [],
        asked: [
          {
            id: 'a'.repeat(24),
            phrase: 'таблиця розмірів',
            lang: 'ru',
            count: 4,
            visitors: 3,
            key: null,
            last: new Date().toISOString(),
          },
        ],
      });
    }
    case '/editor/v1/suggestions': {
      const k = [...E.targets.keys()][0];
      return ok(res, {
        path: url.searchParams.get('path') || '/',
        items: [
          {
            id: 'a'.repeat(24),
            kind: 'asked',
            phrase: 'таблиця розмірів',
            lang: 'ru',
            visitors: 3,
            key: null,
          },
          ...(k
            ? [
                {
                  id: 'd'.repeat(24),
                  kind: 'wrong',
                  key: k,
                  phrase: 'доставка',
                  lang: 'uk',
                  visitors: 2,
                },
              ]
            : []),
          ...(E.terms.includes('Ксіомі')
            ? []
            : [
                {
                  id: 'e'.repeat(24),
                  kind: 'term',
                  phrase: 'Ксіомі',
                  visitors: 2,
                },
              ]),
          ...(k
            ? [{ id: 'c'.repeat(24), kind: 'self', key: k, count: 3 }]
            : []),
        ].filter((x) => !E.muted.has(x.id)),
      });
    }
    // Заход 11 (№113): принять термин распознавания (текст — по id, у сервера).
    case '/editor/v1/suggestions/term': {
      if (b.expectedRevision !== E.revision)
        return err(res, 409, 'VOICE_MAP_CONFLICT');
      if (b.id !== 'e'.repeat(24) || E.terms.includes('Ксіомі'))
        return err(res, 400, 'EDITOR_BAD_REQUEST');
      E.terms.push('Ксіомі');
      E.revision++;
      return ok(res, { revision: E.revision, term: 'Ксіомі' });
    }
    case '/editor/v1/suggestions/mute': {
      const id =
        typeof b.id === 'string'
          ? b.id
          : `ai:${String(b.key)}:${String(b.lang)}:${String(b.text)}`;
      E.muted.add(id);
      return ok(res, { id });
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
