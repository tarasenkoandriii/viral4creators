/**
 * Стенд приёмки Э6-бис (б) «Голосовое управление — режим Админка» — поверх
 * стенда Э8 (настоящий Postgres, гварды, сессии employee-JWT, коннекторы и
 * предложения «Да», мемо АМ-N) плюс:
 *  - модуль голосового управления «Админкой» (кабинет, план, мастер);
 *  - фейк-модель плана «Админки» (`uiModel`: ответ на команду — шаги,
 *    `api` или «не команда»; «злая» модель предлагает что угодно — код
 *    обязан отказать);
 *  - фейк Soniox (распознавание и уборка у провайдера);
 *  - снимок страницы админки — как его прислал бы загрузчик `admin-act.js`.
 */
import * as request from 'supertest';
import { ADMIN_SESSION_HEADER, WIDGET_VOICE_TEST_PARAM } from '../../brand';
import { signEmployeeJwt } from '../../modules/assist-admin-mode/identity-jwt';
import { AdminSonioxStt } from '../../modules/assist-admin-voice/admin-stt';
import { AdminUiPlanService } from '../../modules/assist-admin-voice/admin-ui-plan.service';
import { AdminVoiceInputService } from '../../modules/assist-admin-voice/admin-voice-input.service';
import { AdminVoiceNotifier } from '../../modules/assist-admin-voice/admin-voice-notifier';
import { AdminVoiceSettingsService } from '../../modules/assist-admin-voice/admin-voice-settings.service';
import { AssistAdminVoiceModule } from '../../modules/assist-admin-voice/assist-admin-voice.module';
import { ADMIN_VC_RISKS_VERSION } from '../../modules/assist-admin-voice/admin-voice-rules';
import { FakeSoniox } from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import { resetVoiceControlPlatformCache } from '../../common/voice-control-platform';
import type {
  GenerateRequest,
  GenerateResult,
} from '../../modules/site-ai/text-model';
import type { E7Site } from '../e7/e7-stack';
import { E8Stack, FakeE8Text, ShopApi, actionsSpec } from '../e8/e8-stack';

export { describeE8 as describeE6bAdmin } from '../e8/e8-stack';

/** Ответ фейк-модели плана «Админки». */
export type UiModelAnswer =
  | { command: false }
  | { api: string }
  | { steps: Array<Record<string, unknown>> };

export class FakeVoiceText extends FakeE8Text {
  readonly uiCalls: GenerateRequest[] = [];
  uiModel: (command: string, user: string) => UiModelAnswer = () => ({
    steps: [],
  });

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (/команду СОТРУДНИКА/.test(req.system)) {
      this.uiCalls.push(req);
      const cmd =
        /<command lang="[a-z]+">"((?:[^"\\]|\\.)*)"<\/command>/.exec(
          req.user,
        )?.[1] ?? '';
      const a = this.uiModel(JSON.parse(`"${cmd}"`) as string, req.user);
      return {
        model: 'gemini-3.6-flash',
        inputTokens: 1200,
        cachedInputTokens: 0,
        outputTokens: 60,
        text: JSON.stringify(
          'command' in a
            ? { command: false, steps: [] }
            : 'api' in a
              ? { command: true, api: a.api, steps: [] }
              : { command: true, api: null, steps: a.steps },
        ),
      };
    }
    return super.generate(req);
  }
}

export class AdminVoiceStack extends E8Stack {
  override readonly text = new FakeVoiceText();
  readonly soniox = new FakeSoniox();

  protected override extraModules() {
    return [AssistAdminVoiceModule];
  }

  override async init(): Promise<this> {
    await super.init();
    const env = {
      ...process.env,
      SONIOX_API_KEY: 'test-soniox-key',
      ASSIST_VOICE_ENABLED: 'true',
    };
    this.app.get(AdminVoiceSettingsService).env = env;
    this.app.get(AdminUiPlanService).env = env;
    this.app.get(AdminVoiceInputService).env = env;
    const stt = this.app.get(AdminSonioxStt);
    stt.env = env;
    stt.fetch = this.soniox.fetch;
    stt.pollDelayMs = 0;
    stt.cleanupGraceMs = 0;
    resetVoiceControlPlatformCache();
    return this;
  }

  notifier(): AdminVoiceNotifier {
    return this.app.get(AdminVoiceNotifier);
  }
}

export interface Ready {
  S: E7Site;
  secret: string;
  ops: Record<string, string>;
  connectorId: string;
}

const data = (r: request.Response) => r.body.data ?? r.body;

/**
 * Сайт Pro: режим «Админка» со встраиванием (verified-хост админки),
 * секрет подписи, коннектор магазина (getOrder/updateOrderStatus/
 * cancelOrder/deleteOrder/createRefund — роль `orders`).
 */
export async function readySite(
  st: AdminVoiceStack,
  shop: ShopApi,
  opts: { plan?: 'business' | 'pro'; enableOps?: boolean } = {},
): Promise<Ready> {
  const S = await st.site({ plan: opts.plan ?? 'pro' });
  st.net.site(S.apiHost, {
    '/openapi.json': {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: actionsSpec(S.apiHost),
    },
    ...shop.routes(),
  });
  await request(st.srv())
    .patch(`/assist/sites/${S.siteId}/admin-mode`)
    .set(st.as(S.ownerTg))
    .send({
      enabled: true,
      access: 'both',
      adminHostIds: [S.adminHostId],
      roleMap: { manager: 'orders', intern: 'readers' },
    })
    .expect(200);
  const secret = data(
    await request(st.srv())
      .post(`/assist/sites/${S.siteId}/admin-mode/identity-secret`)
      .set(st.as(S.ownerTg))
      .expect(200),
  ).secret as string;
  const ops: Record<string, string> = {};
  let connectorId = '';
  if (opts.enableOps !== false) {
    const c = data(
      await request(st.srv())
        .post(`/assist/sites/${S.siteId}/connectors`)
        .set(st.as(S.ownerTg))
        .send({ name: 'shop', specUrl: `https://${S.apiHost}/openapi.json` })
        .expect(201),
    );
    connectorId = c.id;
    for (const o of c.operations) ops[o.operationId] = o.id;
    const patch = (op: string, b: Record<string, unknown>) =>
      request(st.srv())
        .patch(`/assist/sites/${S.siteId}/connectors/${c.id}/operations/${op}`)
        .set(st.as(S.ownerTg))
        .send(b);
    await patch('getOrder', { enabled: true, roles: ['orders', 'readers'] });
    await patch('updateOrderStatus', { enabled: true, roles: ['orders'] });
    await patch('cancelOrder', { enabled: true, roles: ['orders'] });
  }
  return { S, secret, ops, connectorId };
}

export async function employeeSession(
  st: AdminVoiceStack,
  r: Ready,
  sub: string,
  role = 'manager',
): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const jwt = signEmployeeJwt(
    { sub, role, name: sub, aud: r.S.siteId, iat: t, exp: t + 600 },
    r.secret,
  );
  const res = await request(st.srv())
    .post('/assist-admin/v1/session')
    .send({ pk: r.S.pk, jwt })
    .expect(200);
  return data(res).session as string;
}

/** Владелец: принять риски (с именем сайта) и включить состояние. */
export async function setState(
  st: AdminVoiceStack,
  r: Ready,
  state: 'off' | 'test' | 'on' | 'degraded',
  extra: Record<string, unknown> = {},
): Promise<request.Response> {
  const site = await st.prisma.site.findFirstOrThrow({
    where: { id: r.S.siteId },
    select: { name: true },
  });
  return request(st.srv())
    .patch(`/assist/sites/${r.S.siteId}/admin-mode/voice-control`)
    .set(st.as(r.S.ownerTg))
    .send({
      state,
      risksVersion: ADMIN_VC_RISKS_VERSION,
      siteName: site.name,
      ...extra,
    });
}

/** Прямо в базе: `on` с «годным отчётом» (для тестов исполнения плана). */
export async function forceOn(st: AdminVoiceStack, r: Ready): Promise<void> {
  const t = await st.prisma.assistAdminVoiceTest.create({
    data: {
      accountId: r.S.accountId,
      siteId: r.S.siteId,
      hostId: r.S.adminHostId,
      host: r.S.adminHost,
      origin: `https://${r.S.adminHost}`,
      startedBy: `tg:${r.S.ownerTg}`,
      tokenHash: `seed-${r.S.siteId}-${Date.now()}`,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  // Вставка — только чистой ссылкой (триггер); отчёт — UPDATE'ом, как сервис.
  await st.prisma.assistAdminVoiceTest.update({
    where: { id: t.id },
    data: {
      usedAt: new Date(),
      result: 'pass',
      reportedAt: new Date(),
      validUntil: new Date(Date.now() + 86_400_000),
      report: { v: 1, seeded: true },
    },
  });
  await st.prisma.assistAdminSettings.updateMany({
    where: { siteId: r.S.siteId },
    data: {
      voiceControlAdminState: 'on',
      voiceControlAdminRisksVersion: ADMIN_VC_RISKS_VERSION,
      voiceControlAdminEnabledBy: `tg:${r.S.ownerTg}`,
      voiceControlAdminTestId: t.id,
      voiceControlAdminStateAt: new Date(),
      voiceControlAdminStateBy: 'owner',
    },
  });
}

/** Элемент снимка страницы админки (как прислал бы загрузчик). */
export function el(
  ref: string,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const tag =
    role === 'link'
      ? 'a'
      : role === 'textbox' || role === 'searchbox'
        ? 'input'
        : role === 'combobox'
          ? 'select'
          : 'button';
  return { ref, role, tag, text, inView: true, ...extra };
}

/** Снимок страницы «Замовлення 1042» админки магазина. */
export function orderPage(
  adminHost: string,
  path = '/admin/orders/1042',
): Record<string, unknown> {
  const base = `https://${adminHost}`;
  return {
    url: `${base}${path}`,
    title: 'Замовлення 1042 — адмінка',
    elements: [
      el('e1', 'link', 'Замовлення', { href: `${base}/admin/orders` }),
      el('e2', 'link', 'Клієнти', { href: `${base}/admin/customers` }),
      el('e3', 'searchbox', 'Пошук замовлень', { inputType: 'search' }),
      el('e4', 'textbox', 'Коментар', { inputType: 'text', inForm: true }),
      el('e5', 'combobox', 'Статус', {
        inForm: true,
        options: ['Новий', 'Оплачено', 'Відправлено'],
        selected: 'Оплачено',
      }),
      el('e6', 'button', 'Зберегти', { submit: true, inForm: true }),
      el('e7', 'button', 'Видалити замовлення'),
      el('e8', 'button', 'Скасувати замовлення'),
      el('e9', 'button', 'Повернення коштів'),
      el('e10', 'button', 'Вибрати все'),
      el('e11', 'textbox', 'Телефон клієнта', {
        inputType: 'tel',
        inForm: true,
        pd: true,
      }),
      el('e12', 'textbox', 'Трек-номер', { inputType: 'text' }),
      el('e13', 'tab', 'Історія', { toggle: true }),
      el('e14', 'button', 'В кошик', { assistId: 'add-to-cart' }),
      el('e15', 'link', 'Документація', {
        href: 'https://docs.other.example/help',
      }),
    ],
  };
}

export function api(st: AdminVoiceStack, sess: string) {
  const post = (path: string, body: unknown) =>
    request(st.srv())
      .post(path)
      .set(ADMIN_SESSION_HEADER, sess)
      .send(body as object);
  return {
    plan: (body: Record<string, unknown>) =>
      post('/assist-admin/v1/ui-plan', { source: 'typed', ...body }),
    confirm: (id: string, body: Record<string, unknown>) =>
      post(`/assist-admin/v1/ui-plan/${id}/confirm`, body),
    step: (id: string, body: Record<string, unknown>) =>
      post(`/assist-admin/v1/ui-plan/${id}/step`, body),
    stop: (id: string, body: Record<string, unknown> = {}) =>
      post(`/assist-admin/v1/ui-plan/${id}/stop`, body),
    resume: (id: string, body: Record<string, unknown>) =>
      post(`/assist-admin/v1/ui-plan/${id}/resume`, body),
    undo: (id: string, body: Record<string, unknown>) =>
      post(`/assist-admin/v1/ui-plan/${id}/undo`, body),
    undoReport: (id: string, body: Record<string, unknown>) =>
      post(`/assist-admin/v1/ui-plan/${id}/undo-report`, body),
    active: () =>
      request(st.srv())
        .get('/assist-admin/v1/ui-plan/active')
        .set(ADMIN_SESSION_HEADER, sess),
    config: () =>
      request(st.srv())
        .get('/assist-admin/v1/voice-control')
        .set(ADMIN_SESSION_HEADER, sess),
    chat: (text: string) => post('/assist-admin/v1/chat', { text }),
    state: () =>
      request(st.srv())
        .get('/assist-admin/v1/state')
        .set(ADMIN_SESSION_HEADER, sess),
  };
}

/**
 * Сухой прогон мемо АМ-N (аудит 06.10, §5-бис.17 п.7) — как в браузере
 * владельца: «Прогнать» в TMA → ссылка мастера → обмен сессией сотрудника
 * `wa.` → итог каждой страницы образца → отчёт (вердикт считает сервер).
 */
export async function dryRunMemo(
  st: E8Stack,
  site: { siteId: string; ownerTg: bigint },
  n: number,
  sess: string,
  snapshots: Array<Record<string, unknown>> = [],
): Promise<{ result: string; report: Record<string, unknown> }> {
  const tok = data(
    await request(st.srv())
      .post(`/assist/sites/${site.siteId}/admin-mode/memos/${n}/check-token`)
      .set(st.as(site.ownerTg))
      .send({})
      .expect(200),
  ) as { url: string };
  const token = new URL(tok.url).searchParams.get(WIDGET_VOICE_TEST_PARAM);
  const ex = data(
    await request(st.srv())
      .post('/assist-admin/v1/voice-test/session')
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ token })
      .expect(200),
  ) as { testId: string; memo?: unknown };
  if (!ex.memo) throw new Error('ссылка — не прогон мемо');
  for (const snapshot of snapshots)
    await request(st.srv())
      .post(`/assist-admin/v1/voice-test/${ex.testId}/memo-page`)
      .set(ADMIN_SESSION_HEADER, sess)
      .send({ snapshot })
      .expect(200);
  return data(
    await request(st.srv())
      .post(`/assist-admin/v1/voice-test/${ex.testId}/memo-report`)
      .set(ADMIN_SESSION_HEADER, sess)
      .expect(200),
  );
}

export { data };
