/**
 * Приёмка Э-С Ш3 — браузерный воркер (очередь, канал воркера, связки
 * продуктов) на РЕАЛЬНОМ Postgres, по HTTP с настоящими гвардами.
 *
 *  1. Канал воркера: свой секрет и вызывающий, 503 без секрета или при
 *     совпадении с секретом обучалки, подпись/повтор/окно времени/чужой
 *     вызывающий — 401, потолок тела по маршруту, строгий JSON.
 *  2. Выключатель `BROWSER_WORKER_ENABLED` (по умолчанию выкл.): ничего не
 *     ставится, «Админка» — `waiting_worker` как в Э7, claim пуст.
 *  3. «Снимок» Э6-тер: права, только публичный verified-хост, задание без
 *     секретов, аренда (один воркер), артефакт (сигнатура, потолок),
 *     строгий результат (хост вне замка — 400), двойная сдача — 409,
 *     маска ПД, подписанная ссылка ≤ 15 мин, элементы — в карту Ш4 (`qa`).
 *  4. Аренда: повтор по коду (сервер решает), пауза, истёкшая аренда —
 *     переотдача с новым токеном (старый — 409), справедливость по
 *     кабинетам, отзыв хоста пока ждали — `host_not_verified`, kill-switch.
 *  5. Обход «Админки» за логином: продукт `assist-admin`, конверт под ключ
 *     воркера (открытого текста в ответе нет), один раз на попытку, журнал
 *     Ш2, страницы — в `assist_admin_pages` (маска ПД), в очереди — сводка.
 *  6. Сверка карты (`assist-voice-map-check`, Т-3): отчёт «нашлась / нет».
 *  7. Кадры обучалки по каналу генератора: только режим A, ссылки.
 *  8. Тенант, триггер «секретов в параметрах нет», роль `assist_public`,
 *     ретенция (Blob и строки).
 */
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { serializeQueueTests } from '../../modules/browser-jobs/testing/jobs-db.testing';
import { WORKER_ROUTES } from '../../modules/browser-jobs/protocol';
import { openSealed, sealAad } from '../../modules/browser-jobs/worker-seal';
import { SiteCredentialsService } from '../../modules/site-credentials/site-credentials.service';
import { Sh3Stack, body, errCode, type Sh3Site } from './sh3-stack';

jest.setTimeout(180_000);

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  randomBytes(64),
]).toString('base64');

describeDb('Приёмка Э-С Ш3 — браузерный воркер', () => {
  serializeQueueTests();
  const st = new Sh3Stack();
  let s: Sh3Site;

  beforeAll(async () => {
    await st.init();
    s = await st.site();
  });
  afterAll(async () => {
    await st.close();
  });
  afterEach(() => {
    st.env.BROWSER_WORKER_ENABLED = 'true';
    st.env.SITES_WORKER_SEAL_PUBLIC_KEY = st.keys.publicKey;
    st.jobs.now = () => new Date();
  });

  const claim = async (
    max = 4,
    kinds = [
      'ui-snapshot',
      'admin-crawl',
      'descriptor-resolve',
      'frames-capture',
    ],
  ) =>
    body(
      await st
        .worker(WORKER_ROUTES.claim, { workerId: 'bw-sh3', kinds, max })
        .expect(200),
    );

  /** Всё ожидающее — «вычерпать», чтобы тесты не мешали друг другу. */
  async function drain() {
    await st.prisma.siteBrowserJob.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled' },
    });
  }

  const snapshotResult = (
    host: string,
    extra: Record<string, unknown> = {},
  ) => ({
    finalUrl: `https://${host}/`,
    snapshot: {
      url: `https://${host}/`,
      title: 'Магазин',
      elements: [
        {
          ref: 'e1',
          role: 'button',
          tag: 'button',
          text: 'Пишіть: ivan@example.com',
          hiddenLabel: null,
          assistId: 'buy',
          inputType: null,
          href: null,
          disabled: false,
          checked: null,
          selected: null,
          options: [],
          heading: null,
          submit: false,
          inForm: false,
          confirmZone: false,
          pd: false,
          toggle: false,
          gesture: null,
          inView: true,
          box: { x: 10, y: 20, w: 100, h: 40 },
        },
      ],
    },
    mapElements: [
      {
        tag: 'button',
        label: 'Купити',
        role: 'button',
        assistId: 'buy',
        selector: '#buy-btn',
      },
    ],
    screenshot: 0,
    viewport: { width: 390, height: 844 },
    blockedRequests: 2,
    ...extra,
  });

  // ── 1. канал ────────────────────────────────────────────────────────

  it('канал воркера: свой секрет, вызывающий, окно, повтор, потолок тела', async () => {
    const path = WORKER_ROUTES.claim;
    const ok = { workerId: 'bw-sh3', kinds: ['ui-snapshot'], max: 1 };
    const saved = st.env.SITES_WORKER_HMAC_SECRET;
    delete st.env.SITES_WORKER_HMAC_SECRET;
    expect(errCode(await st.worker(path, ok).expect(503))).toBe(
      'INTERNAL_NOT_CONFIGURED',
    );
    st.env.SITES_WORKER_HMAC_SECRET = st.tutorialSecret;
    expect(
      errCode(
        await st.worker(path, ok, { secret: st.tutorialSecret }).expect(503),
      ),
    ).toBe('INTERNAL_NOT_CONFIGURED');
    st.env.SITES_WORKER_HMAC_SECRET = saved;
    // Аудит Ш3: секрет воркера, совпавший с KEK реестра учёток или
    // секретом кронов, — канал закрыт так же (утечка env воркера не
    // должна открывать расшифровку учёток Ш2 и кроны).
    for (const other of ['ASSIST_SECRETS_KEY', 'CRON_SECRET']) {
      st.env[other] = saved;
      expect(errCode(await st.worker(path, ok).expect(503))).toBe(
        'INTERNAL_NOT_CONFIGURED',
      );
      delete st.env[other];
    }
    const kek = String(st.env.SITE_CREDENTIALS_KEYS).split(':')[1];
    st.env.SITES_WORKER_HMAC_SECRET = kek;
    expect(errCode(await st.worker(path, ok).expect(503))).toBe(
      'INTERNAL_NOT_CONFIGURED',
    );
    st.env.SITES_WORKER_HMAC_SECRET = saved;
    expect(
      errCode(
        await st.worker(path, ok, { secret: st.tutorialSecret }).expect(401),
      ),
    ).toBe('INTERNAL_SIGNATURE_MISMATCH');
    expect(
      errCode(await st.worker(path, ok, { caller: 'qa-flow' }).expect(401)),
    ).toBe('INTERNAL_SIGNATURE_CALLER');
    expect(
      errCode(
        await st
          .worker(path, ok, { at: Math.floor(Date.now() / 1000) - 3600 })
          .expect(401),
      ),
    ).toBe('INTERNAL_SIGNATURE_STALE');
    // Повтор того же подписанного запроса.
    const raw = JSON.stringify(ok);
    const { sitesSignatureHeaders } =
      await import('../../shared/sites-internal-signature');
    const headers = sitesSignatureHeaders(st.workerSecret, {
      caller: 'browser-worker',
      method: 'POST',
      path,
      body: raw,
      unixSeconds: Math.floor(Date.now() / 1000),
      requestId: `replay-${randomBytes(8).toString('hex')}`,
    });
    await request(st.srv())
      .post(path)
      .set(headers)
      .set('content-type', 'application/json')
      .send(raw)
      .expect(200);
    const again = await request(st.srv())
      .post(path)
      .set(headers)
      .set('content-type', 'application/json')
      .send(raw)
      .expect(401);
    expect(errCode(again)).toBe('INTERNAL_REPLAY');
    // Потолок тела claim — 8 КБ; лишнее поле — 400.
    expect(
      errCode(
        await st.worker(path, { ...ok, pad: 'x'.repeat(9000) }).expect(400),
      ),
    ).toBe('WORKER_BAD_BODY');
    expect(
      errCode(await st.worker(path, { ...ok, extra: 1 }).expect(400)),
    ).toBe('WORKER_BAD_BODY');
  });

  // ── 2. выключатель ─────────────────────────────────────────────────

  it('выключатель: задания не ставятся, claim пуст, «Админка» ждёт как в Э7', async () => {
    st.env.BROWSER_WORKER_ENABLED = 'false';
    const r = await request(st.srv())
      .post(`/assist/sites/${s.siteId}/voice-map/site/snapshots`)
      .set(st.as(s.ownerTg))
      .send({ url: `https://${s.shopHost}/` })
      .expect(409);
    expect(errCode(r)).toBe('BROWSER_WORKER_DISABLED');
    const c = await claim();
    expect(c).toEqual({ enabled: false, jobs: [] });
    const v = await request(st.srv())
      .get(`/assist/sites/${s.siteId}/admin-mode/private-crawl`)
      .set(st.as(s.ownerTg))
      .expect(200);
    expect(body(v).worker).toBe('waiting_sh3');
  });

  // ── 3. «Снимок» ─────────────────────────────────────────────────────

  it('«Снимок»: публичный verified-хост, аренда, артефакт, строгий результат, ссылка, карта Ш4', async () => {
    await drain();
    const base = `/assist/sites/${s.siteId}/voice-map/site/snapshots`;
    // Хост «Админки» и чужой хост — нет; оператор — 403.
    await request(st.srv())
      .post(base)
      .set(st.as(s.ownerTg))
      .send({ url: `https://${s.adminHost}/` })
      .expect(422);
    await request(st.srv())
      .post(base)
      .set(st.as(s.ownerTg))
      .send({ url: 'https://evil.example/' })
      .expect(422);
    const op = await st.member(s, 'operator', { assist: 'operator' });
    await request(st.srv())
      .post(base)
      .set(st.as(op))
      .send({ url: `https://${s.shopHost}/` })
      .expect(403);
    const req = body(
      await request(st.srv())
        .post(base)
        .set(st.as(s.ownerTg))
        .send({ url: `https://${s.shopHost}/?utm=1#x` })
        .expect(200),
    );
    const c = await claim();
    expect(c.jobs).toHaveLength(1);
    const j = c.jobs[0];
    expect(j.id).toBe(req.snapshotId);
    expect(j.params).toEqual({
      url: `https://${s.shopHost}/?utm=1`,
      allowedHosts: [s.shopHost],
      viewport: 'mobile',
      screenshot: true,
      mapElements: true,
    });
    expect(JSON.stringify(j.params)).not.toMatch(/password|secret|cookie/i);
    // Второй воркер то же задание не получит.
    expect((await claim()).jobs).toEqual([]);
    const lease = { jobId: j.id, leaseToken: j.leaseToken };
    expect(
      body(await st.worker(WORKER_ROUTES.heartbeat, lease).expect(200)),
    ).toMatchObject({ ok: true, cancel: false });
    // Артефакт: не JPEG — 400; JPEG — ок.
    await st
      .worker(WORKER_ROUTES.artifact, {
        ...lease,
        idx: 0,
        contentType: 'image/jpeg',
        width: 390,
        height: 844,
        data: Buffer.from('<svg/>').toString('base64'),
      })
      .expect(400);
    await st
      .worker(WORKER_ROUTES.artifact, {
        ...lease,
        idx: 0,
        contentType: 'image/jpeg',
        width: 390,
        height: 844,
        data: JPEG,
      })
      .expect(200);
    // Хост вне замка в результате — не принят.
    const bad = await st
      .worker(WORKER_ROUTES.complete, {
        ...lease,
        result: snapshotResult('evil.example'),
      })
      .expect(400);
    expect(errCode(bad)).toBe('WORKER_BAD_RESULT');
    // Ссылка на незагруженный артефакт — не принят.
    await st
      .worker(WORKER_ROUTES.complete, {
        ...lease,
        result: snapshotResult(s.shopHost, { screenshot: 3 }),
      })
      .expect(400);
    await st
      .worker(WORKER_ROUTES.complete, {
        ...lease,
        result: snapshotResult(s.shopHost),
      })
      .expect(200);
    // Двойная сдача — аренды уже нет.
    expect(
      errCode(
        await st
          .worker(WORKER_ROUTES.complete, {
            ...lease,
            result: snapshotResult(s.shopHost),
          })
          .expect(409),
      ),
    ).toBe('WORKER_LEASE_LOST');
    const view = body(
      await request(st.srv())
        .get(`${base}/${j.id}`)
        .set(st.as(s.ownerTg))
        .expect(200),
    );
    expect(view.status).toBe('done');
    expect(view.elements[0].text).not.toContain('ivan@example.com');
    expect(view.elements[0].box).toEqual({ x: 10, y: 20, w: 100, h: 40 });
    expect(view.screenshot.url).toMatch(/^fake-blob:\/\/browser\//);
    const until = Number(/until=(\d+)/.exec(view.screenshot.url)![1]);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000);
    // Элементы — в общую карту Ш4 источником `qa` (вид — мобильный).
    const map = await st.prisma.siteUiMap.findFirst({
      where: { siteId: s.siteId, source: 'qa', path: '/' },
    });
    expect(map?.viewport).toBe('mobile');
  });

  // ── 4. аренда, повтор, справедливость ──────────────────────────────

  it('повтор решает сервер; истёкшая аренда — переотдача с новым токеном; справедливость; kill-switch', async () => {
    await drain();
    const base = `/assist/sites/${s.siteId}/voice-map/site/snapshots`;
    const a = body(
      await request(st.srv())
        .post(base)
        .set(st.as(s.ownerTg))
        .send({ url: `https://${s.shopHost}/a` })
        .expect(200),
    );
    await request(st.srv())
      .post(base)
      .set(st.as(s.ownerTg))
      .send({ url: `https://${s.shopHost}/b` })
      .expect(200);
    // Два задания одного кабинета — за один claim только одно.
    const c1 = await claim(4);
    expect(c1.jobs).toHaveLength(1);
    const j1 = c1.jobs[0];
    // Повторяемый код и попытки есть — назад в очередь с паузой.
    expect(
      body(
        await st
          .worker(WORKER_ROUTES.fail, {
            jobId: j1.id,
            leaseToken: j1.leaseToken,
            code: 'nav_timeout',
          })
          .expect(200),
      ),
    ).toEqual({ ok: true, retry: true });
    // Неповторяемый код — сразу отказ (второе задание).
    const c2 = await claim(4);
    expect(c2.jobs.map((x: { id: string }) => x.id)).not.toContain(j1.id);
    const j2 = c2.jobs[0];
    expect(
      body(
        await st
          .worker(WORKER_ROUTES.fail, {
            jobId: j2.id,
            leaseToken: j2.leaseToken,
            code: 'egress_blocked',
          })
          .expect(200),
      ),
    ).toEqual({ ok: true, retry: false });
    expect(
      (
        await st.prisma.siteBrowserJob.findUniqueOrThrow({
          where: { id: j2.id },
        })
      ).status,
    ).toBe('failed');
    // Пауза повтора прошла — вторая попытка, затем истечение аренды.
    st.jobs.now = () => new Date(Date.now() + 5 * 60_000);
    const c3 = await claim(4);
    expect(c3.jobs[0]).toMatchObject({ id: a.snapshotId, attempt: 2 });
    st.jobs.now = () => new Date(Date.now() + 10 * 60_000);
    // Аренда истекла, попыток (2 из 2) нет — окончательный отказ.
    expect((await claim(4)).jobs).toEqual([]);
    const row = await st.prisma.siteBrowserJob.findUniqueOrThrow({
      where: { id: a.snapshotId },
    });
    expect(row).toMatchObject({ status: 'failed', errorCode: 'job_timeout' });
    expect(
      errCode(
        await st
          .worker(WORKER_ROUTES.heartbeat, {
            jobId: a.snapshotId,
            leaseToken: c3.jobs[0].leaseToken,
          })
          .expect(409),
      ),
    ).toBe('WORKER_LEASE_LOST');
    // Kill-switch: выключили — heartbeat идущего говорит «отменить», claim пуст.
    st.jobs.now = () => new Date();
    const c = body(
      await request(st.srv())
        .post(base)
        .set(st.as(s.ownerTg))
        .send({ url: `https://${s.shopHost}/c` })
        .expect(200),
    );
    const j = (await claim()).jobs[0];
    expect(j.id).toBe(c.snapshotId);
    st.env.BROWSER_WORKER_ENABLED = 'false';
    expect(
      body(
        await st
          .worker(WORKER_ROUTES.heartbeat, {
            jobId: j.id,
            leaseToken: j.leaseToken,
          })
          .expect(200),
      ).cancel,
    ).toBe(true);
    expect((await claim()).jobs).toEqual([]);
  });

  it('аудит Ш3: длинная очередь одного кабинета не морит голодом другой', async () => {
    await drain();
    // Свои кабинеты: суточный лимит сайта `s` остальным тестам не тратим.
    const flood = await st.site();
    const other = await st.site();
    const at = (ms: number) => new Date(Date.now() - ms);
    const row = (site: Sh3Site, n: number, age: number) => ({
      accountId: site.accountId,
      siteId: site.siteId,
      hostId: site.shopHostId,
      kind: 'ui-snapshot',
      origin: 'voice-map-snapshot',
      params: {
        url: `https://${site.shopHost}/p${n}`,
        allowedHosts: [site.shopHost],
        viewport: 'mobile',
        screenshot: false,
        mapElements: false,
      },
      priority: 10,
      availableAt: at(age),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // 60 старых ожидающих кабинета flood — больше окна выборки (50).
    await st.prisma.siteBrowserJob.createMany({
      data: Array.from({ length: 60 }, (_, n) => row(flood, n, 600_000 - n)),
    });
    const lone = await st.prisma.siteBrowserJob.create({
      data: row(other, 0, 1_000),
    });
    const got: string[] = [];
    for (let k = 0; k < 3; k++) {
      for (const j of (await claim(4, ['ui-snapshot'])).jobs) got.push(j.id);
    }
    // flood — не больше RUNNING_PER_ACCOUNT идущих; задание другого выдано.
    expect(got).toContain(lone.id);
    expect(got.filter((id) => id !== lone.id).length).toBeLessThanOrEqual(2);
    await drain();
  });

  it('истёкшая аренда с попытками — переотдача; хост отозван, пока ждали, — host_not_verified', async () => {
    await drain();
    const base = `/assist/sites/${s.siteId}/voice-map/site/snapshots`;
    const a = body(
      await request(st.srv())
        .post(base)
        .set(st.as(s.ownerTg))
        .send({ url: `https://${s.shopHost}/lease` })
        .expect(200),
    );
    const first = (await claim()).jobs[0];
    st.jobs.now = () => new Date(Date.now() + 2 * 60_000);
    // Аренда истекла (heartbeat не было) — пауза повтора, потом переотдача.
    expect((await claim()).jobs).toEqual([]);
    st.jobs.now = () => new Date(Date.now() + 10 * 60_000);
    const second = (await claim()).jobs[0];
    expect(second).toMatchObject({ id: a.snapshotId, attempt: 2 });
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(
      errCode(
        await st
          .worker(WORKER_ROUTES.heartbeat, {
            jobId: first.id,
            leaseToken: first.leaseToken,
          })
          .expect(409),
      ),
    ).toBe('WORKER_LEASE_LOST');
    await st
      .worker(WORKER_ROUTES.fail, {
        jobId: second.id,
        leaseToken: second.leaseToken,
        code: 'nav_failed',
      })
      .expect(200);
    st.jobs.now = () => new Date();
    // Отзыв подтверждения, пока задание ждало, — воркер его не получит.
    const b = body(
      await request(st.srv())
        .post(base)
        .set(st.as(s.ownerTg))
        .send({ url: `https://${s.shopHost}/revoked` })
        .expect(200),
    );
    await st.prisma.siteHost.update({
      where: { id: s.shopHostId },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    try {
      expect((await claim()).jobs).toEqual([]);
      const row = await st.prisma.siteBrowserJob.findUniqueOrThrow({
        where: { id: b.snapshotId },
      });
      expect(row).toMatchObject({
        status: 'failed',
        errorCode: 'host_not_verified',
      });
    } finally {
      await st.prisma.siteHost.update({
        where: { id: s.shopHostId },
        data: { status: 'verified', revokedAt: null },
      });
    }
  });

  // ── 5. обход «Админки» за логином ───────────────────────────────────

  it('обход «Админки»: продукт assist-admin, конверт под ключ воркера, один раз на попытку, страницы с маской', async () => {
    await drain();
    const creds = st.app.get(SiteCredentialsService);
    const PASSWORD = ['Sh3', 'adm', 'pw', randomBytes(4).toString('hex')].join(
      '-',
    );
    const qaOnly = await creds.create(
      s.accountId,
      s.siteId,
      {
        label: 'QA',
        hostIds: [s.adminHostId],
        products: ['qa'],
        confirmedTestAccount: true,
        username: 'qa',
      },
      'tma:test',
    );
    const crawlPath = `/assist/sites/${s.siteId}/admin-mode/private-crawl`;
    const r409 = await request(st.srv())
      .put(crawlPath)
      .set(st.as(s.ownerTg))
      .send({
        enabled: true,
        hostId: s.adminHostId,
        testAccountId: qaOnly.id,
        startPath: '/admin',
      })
      .expect(409);
    expect(JSON.stringify(r409.body)).toContain('Помощник: Админка');
    const acc = await creds.create(
      s.accountId,
      s.siteId,
      {
        label: 'Менеджер',
        hostIds: [s.adminHostId],
        products: ['assist-admin'],
        confirmedTestAccount: true,
        username: 'manager',
        password: PASSWORD,
      },
      'tma:test',
    );
    const v = body(
      await request(st.srv())
        .put(crawlPath)
        .set(st.as(s.ownerTg))
        .send({
          enabled: true,
          hostId: s.adminHostId,
          testAccountId: acc.id,
          startPath: '/admin',
        })
        .expect(200),
    );
    expect(v.worker).toBe('ready');
    const run = body(
      await request(st.srv())
        .post(`${crawlPath}/run`)
        .set(st.as(s.ownerTg))
        .expect(200),
    );
    expect(run.status).toBe('queued');
    // Без открытого ключа конверта обход не выдаётся воркеру вовсе.
    delete st.env.SITES_WORKER_SEAL_PUBLIC_KEY;
    expect((await claim()).jobs).toEqual([]);
    st.env.SITES_WORKER_SEAL_PUBLIC_KEY = st.keys.publicKey;
    const j = (await claim()).jobs[0];
    expect(j).toMatchObject({ kind: 'admin-crawl', needsCredentials: true });
    expect(JSON.stringify(j)).not.toContain(PASSWORD);
    expect(
      (
        await st.prisma.assistAdminCrawlJob.findUniqueOrThrow({
          where: { id: run.jobId },
        })
      ).status,
    ).toBe('running');
    const lease = { jobId: j.id, leaseToken: j.leaseToken };
    const cr = await st.worker(WORKER_ROUTES.credentials, lease).expect(200);
    expect(cr.text).not.toContain(PASSWORD);
    const plain = openSealed(
      st.keys.privateKey,
      body(cr).sealed,
      sealAad(j.id, j.attempt),
    ).toString('utf8');
    expect(JSON.parse(plain)).toMatchObject({
      username: 'manager',
      password: PASSWORD,
    });
    // Один раз на попытку.
    expect(
      errCode(await st.worker(WORKER_ROUTES.credentials, lease).expect(409)),
    ).toBe('WORKER_CREDENTIALS_USED');
    // Журнал Ш2: аренда и погашение от имени воркера.
    const audit = await st.prisma.siteCredentialAudit.findMany({
      where: { accountId: s.accountId, actor: 'browser-worker' },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((a) => `${a.action}:${a.result}`)).toEqual([
      'lease:ok',
      'redeem:ok',
    ]);
    expect(audit[0].runRef).toBe(`bjob:${j.id}`);
    // Сдача: страницы — в assist_admin_pages (маска ПД), в очереди — сводка.
    const pages = [
      {
        url: `https://${s.adminHost}/admin`,
        title: 'Адмінка',
        text: '# Панель\nкнопка: Експорт\nконтакт: boss@example.com',
      },
      {
        url: `https://${s.adminHost}/admin/orders`,
        title: 'Замовлення',
        text: '# Замовлення\nколонка: Клієнт',
      },
    ];
    await st
      .worker(WORKER_ROUTES.complete, {
        ...lease,
        result: { loggedIn: true, pages, refusedClicks: 2, skippedLinks: 3 },
      })
      .expect(200);
    const rows = await st.prisma.assistAdminPage.findMany({
      where: { siteId: s.siteId },
      orderBy: { url: 'asc' },
    });
    expect(rows.map((r) => r.url)).toEqual(pages.map((p) => p.url));
    expect(rows[0].text).not.toContain('boss@example.com');
    expect(rows[0].crawlJobId).toBe(run.jobId);
    const job = await st.prisma.siteBrowserJob.findUniqueOrThrow({
      where: { id: j.id },
    });
    expect(job.result).toEqual({
      loggedIn: true,
      pages: 2,
      refusedClicks: 2,
      skippedLinks: 3,
    });
    expect(
      (
        await st.prisma.assistAdminCrawlJob.findUniqueOrThrow({
          where: { id: run.jobId },
        })
      ).status,
    ).toBe('done');
  });

  it('обход: продукт сняли за время аренды — учётка не выдаётся, обход failed с понятной причиной', async () => {
    await drain();
    const creds = st.app.get(SiteCredentialsService);
    const acc = await creds.create(
      s.accountId,
      s.siteId,
      {
        label: 'Менеджер-2',
        hostIds: [s.adminHostId],
        products: ['assist-admin'],
        confirmedTestAccount: true,
        username: 'm2',
        password: 'pw-2-xxxx',
      },
      'tma:test',
    );
    const crawlPath = `/assist/sites/${s.siteId}/admin-mode/private-crawl`;
    await request(st.srv())
      .put(crawlPath)
      .set(st.as(s.ownerTg))
      .send({ enabled: true, hostId: s.adminHostId, testAccountId: acc.id })
      .expect(200);
    const run = body(
      await request(st.srv())
        .post(`${crawlPath}/run`)
        .set(st.as(s.ownerTg))
        .expect(200),
    );
    const j = (await claim()).jobs[0];
    await st.prisma.siteTestAccount.update({
      where: { id: acc.id },
      data: { products: ['qa'] },
    });
    const lease = { jobId: j.id, leaseToken: j.leaseToken };
    expect(
      errCode(await st.worker(WORKER_ROUTES.credentials, lease).expect(403)),
    ).toBe('WORKER_CREDENTIALS_DENIED');
    await st
      .worker(WORKER_ROUTES.fail, { ...lease, code: 'credentials_unavailable' })
      .expect(200);
    const cj = await st.prisma.assistAdminCrawlJob.findUniqueOrThrow({
      where: { id: run.jobId },
    });
    expect(cj.status).toBe('failed');
    expect(cj.note).toContain('учётка не выдана');
  });

  it('канал генератора не ставит и не снимает продукт assist-admin (О-Э7-1)', async () => {
    const creds = st.app.get(SiteCredentialsService);
    const acc = await creds.create(
      s.accountId,
      s.siteId,
      {
        label: 'Общая',
        hostIds: [s.shopHostId],
        products: ['tutorial', 'assist-admin'],
        confirmedTestAccount: true,
      },
      'tma:test',
    );
    const path = '/internal/sites/credentials/test-accounts/upsert';
    const tg = s.ownerTg.toString();
    const deny = await st
      .tutorial(path, {
        telegramId: tg,
        hostId: s.shopHostId,
        testAccountId: acc.id,
        account: { products: ['assist-admin'] },
      })
      .expect(400);
    expect(errCode(deny)).toBe('TEST_ACCOUNT_INVALID');
    await st
      .tutorial(path, {
        telegramId: tg,
        hostId: s.shopHostId,
        testAccountId: acc.id,
        account: { products: ['qa'] },
      })
      .expect(200);
    const row = await st.prisma.siteTestAccount.findUniqueOrThrow({
      where: { id: acc.id },
    });
    expect(row.products.sort()).toEqual(['assist-admin', 'qa']);
  });

  // ── 6. сверка карты (Т-3) ──────────────────────────────────────────

  it('сверка голосовой карты: отчёт «нашлась / потерялась» и устойчивость', async () => {
    await drain();
    const d = (extra: Record<string, unknown>) => ({
      tag: 'button',
      role: 'button',
      unique: true,
      ...extra,
    });
    await st.prisma.assistSiteVoiceMapVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: 1,
        status: 'held',
        contentHash: 'x',
        requestedBy: 'm',
        requestedVia: 'tma',
        content: {
          schemaVersion: 1,
          templates: [],
          terms: [],
          targets: [
            {
              key: 'buy',
              scope: 'page',
              pagePath: '/',
              descriptor: d({ text: 'Купити', assistId: 'buy' }),
            },
            {
              key: 'gone',
              scope: 'page',
              pagePath: '/',
              descriptor: d({ text: 'Старе', elId: 'old-btn' }),
            },
            {
              key: 'cart',
              scope: 'page',
              pagePath: '/catalog',
              descriptor: d({ text: 'Кошик' }),
            },
          ],
        },
      },
    });
    const req = body(
      await request(st.srv())
        .post(
          `/assist/sites/${s.siteId}/voice-map/site/versions/1/worker-check`,
        )
        .set(st.as(s.ownerTg))
        .expect(200),
    );
    const j = (await claim()).jobs[0];
    expect(j.id).toBe(req.checkId);
    expect(j.params.pages).toEqual([
      `https://${s.shopHost}/`,
      `https://${s.shopHost}/catalog`,
    ]);
    expect(j.params.targets).toEqual([
      { key: 'buy', selectors: ['[data-assist-id="buy"]'] },
      { key: 'gone', selectors: ['#old-btn'] },
      { key: 'cart', selectors: [] },
    ]);
    const el = (ref: string, text: string) => ({
      ref,
      role: 'button',
      tag: 'button',
      text,
      hiddenLabel: null,
      assistId: null,
      inputType: null,
      href: null,
      disabled: false,
      checked: null,
      selected: null,
      options: [],
      heading: null,
      submit: false,
      inForm: false,
      confirmZone: false,
      pd: false,
      toggle: false,
      gesture: null,
      inView: true,
      box: null,
    });
    const result = {
      pages: [
        {
          url: `https://${s.shopHost}/`,
          ok: true,
          error: null,
          counts: { buy: [1], gone: [0], cart: [] },
          snapshot: {
            url: `https://${s.shopHost}/`,
            title: 'Г',
            elements: [el('e1', 'Купити')],
          },
        },
        {
          url: `https://${s.shopHost}/catalog`,
          ok: true,
          error: null,
          counts: { buy: [1], gone: [0], cart: [] },
          snapshot: {
            url: `https://${s.shopHost}/catalog`,
            title: 'К',
            elements: [el('e1', 'Кошик')],
          },
        },
      ],
    };
    await st
      .worker(WORKER_ROUTES.complete, {
        jobId: j.id,
        leaseToken: j.leaseToken,
        result,
      })
      .expect(200);
    const rep = body(
      await request(st.srv())
        .get(`/assist/sites/${s.siteId}/voice-map/site/versions/1/worker-check`)
        .set(st.as(s.ownerTg))
        .expect(200),
    );
    expect(rep.status).toBe('done');
    const by = Object.fromEntries(
      (rep.report.targets as Array<{ key: string }>).map((t) => [t.key, t]),
    );
    expect(by.buy).toMatchObject({
      lost: false,
      samples: [{ path: '/', found: 1 }],
      stability: 'strong',
    });
    expect(by.gone).toMatchObject({ lost: true, stability: 'fragile' });
    expect(by.cart).toMatchObject({
      lost: false,
      samples: [{ path: '/catalog', found: 1 }],
    });
    expect(rep.report.lost).toBe(1);
  });

  // ── 7. кадры обучалки по каналу генератора ─────────────────────────

  it('кадры обучалки: только режим A на точном хосте; ссылки со сроком', async () => {
    await drain();
    const bad = await st.tutorial('/internal/sites/tutorial/frames/request', {
      telegramId: s.ownerTg.toString(),
      url: 'https://unknown-sh3.example.com/',
    });
    if (bad.status !== 409) throw new Error(JSON.stringify(bad.body));
    expect(errCode(bad)).toBe('TUTORIAL_FRAMES_MODE_A');
    const r = body(
      await st
        .tutorial('/internal/sites/tutorial/frames/request', {
          telegramId: s.ownerTg.toString(),
          url: `https://${s.shopHost}/promo`,
          frames: 2,
        })
        .expect(200),
    );
    const j = (await claim()).jobs[0];
    expect(j).toMatchObject({ id: r.jobId, kind: 'frames-capture' });
    for (const idx of [0, 1]) {
      await st
        .worker(WORKER_ROUTES.artifact, {
          jobId: j.id,
          leaseToken: j.leaseToken,
          idx,
          contentType: 'image/jpeg',
          width: 390,
          height: 844,
          data: JPEG,
        })
        .expect(200);
    }
    await st
      .worker(WORKER_ROUTES.complete, {
        jobId: j.id,
        leaseToken: j.leaseToken,
        result: {
          finalUrl: `https://${s.shopHost}/promo`,
          frames: [
            { artifact: 0, scrollY: 0 },
            { artifact: 1, scrollY: 675 },
          ],
        },
      })
      .expect(200);
    const stt = body(
      await st
        .tutorial('/internal/sites/tutorial/frames/status', {
          telegramId: s.ownerTg.toString(),
          jobId: j.id,
        })
        .expect(200),
    );
    expect(stt.status).toBe('done');
    expect(stt.frames.map((f: { scrollY: number }) => f.scrollY)).toEqual([
      0, 675,
    ]);
    expect(stt.frames[0].url).toMatch(/^fake-blob:/);
    // Чужой telegramId задание не видит.
    const stranger = await st
      .tutorial('/internal/sites/tutorial/frames/status', {
        telegramId: '777000111',
        jobId: j.id,
      })
      .expect(404);
    expect(errCode(stranger)).toBe('TUTORIAL_FRAMES_NOT_FOUND');
  });

  // ── 8. тенант, триггер, роль, ретенция ──────────────────────────────

  it('тенант: задание чужого кабинета не видно; снимок чужого сайта — 404', async () => {
    const other = await st.site();
    const job = await st.prisma.siteBrowserJob.findFirstOrThrow({
      where: { accountId: s.accountId, origin: 'voice-map-snapshot' },
    });
    expect(await st.jobs.view(other.accountId, job.id)).toBeNull();
    await request(st.srv())
      .get(`/assist/sites/${other.siteId}/voice-map/site/snapshots/${job.id}`)
      .set(st.as(other.ownerTg))
      .expect(404);
    await request(st.srv())
      .get(`/assist/sites/${s.siteId}/voice-map/site/snapshots/${job.id}`)
      .set(st.as(other.ownerTg))
      .expect(404);
  });

  it('триггер: секреты в параметрах задания и неизвестный вид — отказ базы', async () => {
    const base = {
      accountId: s.accountId,
      siteId: s.siteId,
      hostId: s.adminHostId,
      origin: 'assist-admin-crawl',
      expiresAt: new Date(Date.now() + 60_000),
    };
    await expect(
      st.prisma.siteBrowserJob.create({
        data: {
          ...base,
          kind: 'admin-crawl',
          params: { startUrl: 'x', password: 'p' },
        },
      }),
    ).rejects.toThrow(/секреты/);
    await expect(
      st.prisma.siteBrowserJob.create({
        data: { ...base, kind: 'shell', params: {} },
      }),
    ).rejects.toThrow(/неизвестный вид/);
  });

  it('аудит Ш3: хост задания и артефакт — только того же кабинета (составные FK)', async () => {
    const other = await st.site();
    const params = {
      url: `https://${s.shopHost}/fk`,
      allowedHosts: [s.shopHost],
      viewport: 'mobile',
      screenshot: false,
      mapElements: false,
    };
    // Хост чужого кабинета под заданием этого — отказ базы.
    await expect(
      st.prisma.siteBrowserJob.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          hostId: other.shopHostId,
          kind: 'ui-snapshot',
          origin: 'voice-map-snapshot',
          params,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/foreign key|Foreign key/);
    const job = await st.prisma.siteBrowserJob.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        hostId: s.shopHostId,
        kind: 'ui-snapshot',
        origin: 'voice-map-snapshot',
        params,
        status: 'cancelled',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    // Артефакт с кабинетом, отличным от кабинета задания, — отказ базы.
    await expect(
      st.prisma.siteBrowserArtifact.create({
        data: {
          accountId: other.accountId,
          jobId: job.id,
          idx: 0,
          pathname: `browser/${other.accountId}/${job.id}/0-x.jpg`,
          contentType: 'image/jpeg',
          bytes: 1,
          sha256: '0'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/foreign key|Foreign key/);
  });

  it('роль assist_public: на очередь и артефакты прав нет', async () => {
    const rows = await st.prisma.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT table_name AS t FROM information_schema.table_privileges
        WHERE grantee = 'assist_public' AND table_name IN ('site_browser_jobs', 'site_browser_artifacts')`,
    );
    expect(rows).toEqual([]);
  });

  it('ретенция: артефакты — из Blob и из базы, задания — по сроку', async () => {
    const before = st.storage.files.size;
    expect(before).toBeGreaterThan(0);
    const res = await st.jobs.runRetention(
      new Date(Date.now() + 30 * 86_400_000),
      { accountIds: st.accounts },
    );
    expect(res.artifactsPurged).toBeGreaterThanOrEqual(before);
    expect(st.storage.files.size).toBe(0);
    expect(
      await st.prisma.siteBrowserArtifact.count({
        where: { accountId: s.accountId },
      }),
    ).toBe(0);
    expect(
      await st.prisma.siteBrowserJob.count({
        where: { accountId: s.accountId, status: { not: 'running' } },
      }),
    ).toBe(0);
  });
});
