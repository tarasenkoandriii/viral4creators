/**
 * AT-CORE-07 (P-D, проектный документ §7.4, §6.5; ТЗ §10): квалификация и
 * причины. Менеджер квалифицирует обращение выбранного сегмента (с
 * подтверждением интереса и шифрованной заметкой) и отклоняет заявку
 * поставщика с кодом причины; неизвестный бюджет — не отказ; две задачи
 * одного prospect остаются двумя заявками, но считаются одним
 * потенциальным клиентом; AI статус не меняет (маршрута нет, граф);
 * переходы — только по машине §7.4 и только ролями SA/PO.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import { LeadEnrichJob } from '../../modules/publisher/leads/lead-enrich.job';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postLead,
  randomIp,
  syntheticPerson,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import { addKyivCalendarDays } from '../../modules/publisher/core/kyiv-time';
import {
  seedMembers,
  type SeededMembers,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe('[AT-CORE-07] Квалификация и причины', () => {
  let s: CoreStack;
  let w: IntakeWorld;
  let team: SeededMembers;
  let restore: Array<() => void>;
  const srv = () => s.app!.getHttpServer();
  const sa = () => asMember(team.sales.telegramId, w.account.accountId);
  const leads: Record<string, string> = {};

  const submit = async (tag: string, over: Record<string, unknown>) => {
    const body = leadBody(w.product.publicKey, over);
    const r = await postLead(s, body, { origin: w.origin, ip: randomIp() });
    expect(r.status).toBe(201);
    const lead = await s.prisma.pubLead.findFirstOrThrow({
      where: { submissionKey: body.submissionKey },
    });
    leads[tag] = lead.id;
    return lead.id;
  };
  const card = async (id: string) =>
    (
      await request(srv())
        .get(`/publisher/products/${w.product.id}/leads/${id}`)
        .set(sa())
    ).body.data;
  const transition = (id: string, body: Record<string, unknown>, as = sa()) =>
    request(srv())
      .post(`/publisher/products/${w.product.id}/leads/${id}/transition`)
      .set(as)
      .send({ opKey: randomUUID(), ...body });

  beforeAll(async () => {
    restore = [useTestSecrets(), trustLocalProxy()];
    s = await leadsStack({ http: true });
    w = await intakeProduct(s, { kind: 'working' });
    team = await seedMembers(s.prisma, w.product, w.account.owner);
    // TD-06: квалифицируемая (бюджет неизвестен), поставщик, спам, две
    // задачи одного человека, другой внешний клиент, сотрудник команды.
    const same = syntheticPerson();
    await submit('qualifiable', { budgetRange: 'unknown' });
    await submit('vendor', { task: 'Пропонуємо послуги SEO-агенції' });
    await submit('spam', { task: 'Buy cheap links now' });
    await submit('taskA', {
      contact: same.email,
      name: same.name,
      task: 'Задача А',
    });
    await submit('taskB', {
      contact: same.email,
      name: same.name,
      task: 'Задача Б',
    });
    await submit('other', {});
    await submit('team', {});
    await s.mod.get(LeadEnrichJob).run({
      now: new Date(),
      scope: { siteIds: [w.account.siteId] },
      deadline: new Date(Date.now() + 30_000),
    });
  });
  afterAll(async () => {
    await s.close();
    restore.forEach((r) => r());
  });

  it('обогащение: две задачи одного контакта — один проспект (intake_exact_match), разные люди — разные проспекты', async () => {
    const a = await card(leads.taskA);
    const b = await card(leads.taskB);
    expect(a.prospectId).toBeTruthy();
    expect(b.prospectId).toBe(a.prospectId);
    expect(b.prospectLinks.at(-1).reason).toBe('intake_exact_match');
    expect(b.possibleDuplicates).toContain(leads.taskA);
    const o = await card(leads.other);
    expect(o.prospectId).not.toBe(a.prospectId);
    expect(o.prospectLinks.at(-1).reason).toBe('new');
  });

  it('квалификация: нужна дата подтверждения интереса; заметка — только в шифр, ответ её не возвращает; неизвестный бюджет — не отказ', async () => {
    const before = await card(leads.qualifiable);
    expect(before.budgetRange).toBe('unknown');
    const noDate = await transition(leads.qualifiable, {
      to: 'qualified',
      expectedRevision: before.revision,
    });
    expect(noDate.status).toBe(400);
    expect(noDate.body.error.details.fields).toEqual([
      { field: 'confirmedInterestAt', code: 'required' },
    ]);
    const note = `Підтвердив інтерес телефоном ${syntheticPerson().phone}`;
    const ok = await transition(leads.qualifiable, {
      to: 'qualified',
      confirmedInterestAt: new Date().toISOString(),
      note,
      expectedRevision: before.revision,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('qualified');
    expect(JSON.stringify(ok.body)).not.toContain(note);
    const d = ok.body.data.decisions.at(-1);
    expect(d).toMatchObject({
      fromStatus: 'new',
      toStatus: 'qualified',
      hasNote: true,
      decidedBy: `member:${team.sales.memberId}`,
    });
    const row = await s.prisma.pubLeadDecision.findFirstOrThrow({
      where: { id: d.id },
    });
    expect(row.noteEnc).toMatch(/^v1\./);
    expect(row.noteEnc).not.toContain('телефоном');
  });

  it('отказ поставщику — только с кодом причины; закрытие ставит closedAt и пересмотр через 90 дней', async () => {
    const c = await card(leads.vendor);
    const noReason = await transition(leads.vendor, {
      to: 'rejected',
      expectedRevision: c.revision,
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.fields).toEqual([
      { field: 'reasonCode', code: 'required' },
    ]);
    const badReason = await transition(leads.vendor, {
      to: 'rejected',
      reasonCode: 'не подходит',
      expectedRevision: c.revision,
    });
    expect(badReason.status).toBe(400);
    const ok = await transition(leads.vendor, {
      to: 'rejected',
      reasonCode: 'vendor_offer',
      note: 'Пропозиція SEO-агенції',
      expectedRevision: c.revision,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'rejected' });
    expect(ok.body.data.closedAt).toBeTruthy();
    const closedAt = new Date(ok.body.data.closedAt);
    expect(new Date(ok.body.data.reviewDueAt).toISOString()).toBe(
      addKyivCalendarDays(closedAt, 90).toISOString(),
    );
    expect(ok.body.data.decisions.at(-1)).toMatchObject({
      toStatus: 'rejected',
      reasonCode: 'vendor_offer',
      hasNote: true,
    });
  });

  it('спам — отказ с кодом spam; пересмотр отказа (reopen) — новое решение с причиной, история сохраняется', async () => {
    const c = await card(leads.spam);
    const r = await transition(leads.spam, {
      to: 'rejected',
      reasonCode: 'spam',
      expectedRevision: c.revision,
    });
    expect(r.status).toBe(200);
    const back = await transition(leads.spam, {
      to: 'contacted',
      reasonCode: 'other',
      expectedRevision: r.body.data.revision,
    });
    expect(back.status).toBe(200);
    expect(back.body.data.status).toBe('contacted');
    expect(back.body.data.closedAt).toBeNull();
    const ds = back.body.data.decisions;
    expect(ds.map((x: { toStatus: string }) => x.toStatus)).toEqual([
      'rejected',
      'contacted',
    ]);
    expect(ds[1].supersedesId).toBe(ds[0].id);
  });

  it('две задачи одного prospect: обе в реестре, после квалификации — один потенциальный клиент в паспорте', async () => {
    for (const k of ['taskA', 'taskB', 'other']) {
      const c = await card(leads[k]);
      const r = await transition(leads[k], {
        to: 'qualified',
        confirmedInterestAt: new Date().toISOString(),
        expectedRevision: c.revision,
      });
      expect(r.status).toBe(200);
    }
    const passport = await request(srv())
      .get(`/publisher/products/${w.product.id}/traffic/passport`)
      .set(asMember(team.product_owner.telegramId, w.account.accountId));
    expect(passport.status).toBe(200);
    // qualifiable + (taskA ≡ taskB) + other = три уникальных проспекта.
    expect(passport.body.data.qualified.allExternal).toBe(3);
    expect(
      await s.prisma.pubLead.count({
        where: { id: { in: [leads.taskA, leads.taskB] } },
      }),
    ).toBe(2);
  });

  it('сотрудник команды (проспект isTeamOrPartner) не квалифицируется — 400 not_external', async () => {
    const c = await card(leads.team);
    const p = await request(srv())
      .patch(`/publisher/products/${w.product.id}/prospects/${c.prospectId}`)
      .set(sa())
      .send({
        opKey: randomUUID(),
        isTeamOrPartner: true,
        expectedRevision: 1,
      });
    expect(p.status).toBe(200);
    expect(p.body.data.isTeamOrPartner).toBe(true);
    const r = await transition(leads.team, {
      to: 'qualified',
      confirmedInterestAt: new Date().toISOString(),
      expectedRevision: c.revision,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.fields).toEqual([
      { field: 'prospect', code: 'not_external' },
    ]);
  });

  it('переходы — только по машине §7.4 (new → won → 409) и только SA/PO (аналитик, оператор, наблюдатель — 403)', async () => {
    const id = await submit('machine', {});
    const c = await card(id);
    const won = await transition(id, {
      to: 'won',
      expectedRevision: c.revision,
    });
    expect(won.status).toBe(409);
    expect(won.body.error.code).toBe('PUB_TRANSITION_INVALID');
    for (const who of ['analyst', 'operator', 'viewer', 'editor'] as const) {
      const r = await transition(
        id,
        { to: 'contacted', expectedRevision: c.revision },
        asMember(team[who].telegramId, w.account.accountId),
      );
      expect(r.status).toBe(403);
    }
    const po = await transition(
      id,
      { to: 'contacted', expectedRevision: c.revision },
      asMember(team.product_owner.telegramId, w.account.accountId),
    );
    expect(po.status).toBe(200);
  });

  it('устаревшая ревизия → 409 PUB_CONFLICT; повтор того же opKey — тот же ответ, одно решение', async () => {
    const id = await submit('cas', {});
    const c = await card(id);
    const opKey = randomUUID();
    const body = { opKey, to: 'contacted', expectedRevision: c.revision };
    const a = await request(srv())
      .post(`/publisher/products/${w.product.id}/leads/${id}/transition`)
      .set(sa())
      .send(body);
    const b = await request(srv())
      .post(`/publisher/products/${w.product.id}/leads/${id}/transition`)
      .set(sa())
      .send(body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.data.revision).toBe(a.body.data.revision);
    expect(
      await s.prisma.pubLeadDecision.count({ where: { leadId: id } }),
    ).toBe(1);
    const stale = await transition(id, {
      to: 'qualified',
      confirmedInterestAt: new Date().toISOString(),
      expectedRevision: c.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PUB_CONFLICT');
  });

  it('AI не меняет статус: код publisher/ai/** не импортирует заявки и не пишет pub_leads/pub_lead_decisions', () => {
    const root = path.join(__dirname, '../../modules/publisher/ai');
    const files: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts')) files.push(f);
      }
    };
    walk(root);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect({ f, leadsImport: /from\s+'[^']*\/leads\//.test(src) }).toEqual({
        f,
        leadsImport: false,
      });
      expect({
        f,
        writes:
          /pubLead(Decision)?\s*\.\s*(create|update|upsert)|pub_lead(s|_decisions)"?\s+SET|INSERT INTO\s+"?sites"?\."?pub_lead/.test(
            src,
          ),
      }).toEqual({ f, writes: false });
    }
  });
});
