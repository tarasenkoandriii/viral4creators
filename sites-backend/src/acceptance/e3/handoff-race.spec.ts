/**
 * Э3-2: «Два оператора жмут „Взять“ одновременно — диалог получает один».
 * 20 операторов одного кабинета параллельно жмут «Взять» (бот и TMA
 * вперемешку) на НАСТОЯЩЕМ Postgres: ровно один `taken`, остальные —
 * `already_taken`; назначен ровно тот, кто получил `taken`. Плюс: вторая
 * открытая передача на диалог невозможна (частичный уникальный индекс) —
 * 10 параллельных «позвать человека» дают одну строку.
 */
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { HandoffStack } from '../../modules/assist-site-handoff/testing/handoff-stack.testing';

jest.setTimeout(90_000);

describeDb('Э3-2 — гонка «Взять» (handoff-race)', () => {
  const st = new HandoffStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });

  it('20 параллельных take → ровно один taken, назначен он же', async () => {
    const s = await st.handoffSite({ operators: 20 });
    const v = await st.visitorWithDialog(s);
    const r = await st.requestHandoff(s, v);
    if (r.mode !== 'human') throw new Error('передача');
    const results = await Promise.all(
      s.operators.map((op, i) =>
        i % 2
          ? st.actions.take(
              { via: 'bot', telegramId: op.telegramId },
              r.handoff.id,
            )
          : st.actions.take(
              {
                via: 'tma',
                membership: {
                  accountId: s.accountId,
                  memberId: op.memberId,
                  telegramId: op.telegramId,
                  role: 'operator',
                  productRoles: {
                    qa: 'none',
                    assist: 'operator',
                    assistAdmin: 'none',
                  },
                },
              },
              r.handoff.id,
            ),
      ),
    );
    const winners = results
      .map((x, i) => ({ x, op: s.operators[i] }))
      .filter((w) => w.x.result === 'taken');
    expect(winners).toHaveLength(1);
    expect(results.filter((x) => x.result === 'already_taken')).toHaveLength(
      19,
    );
    const row = await st.handoffRow(r.handoff.id);
    expect(row.state).toBe('active');
    expect(row.assignedMemberId).toBe(winners[0].op.memberId);
    expect(winners[0].x.handoff.assignedToMe).toBe(true);
  });

  it('10 параллельных «позвать человека» одного диалога → одна открытая передача', async () => {
    const s = await st.handoffSite({ operators: 1 });
    const v = await st.visitorWithDialog(s);
    const out = await Promise.all(
      Array.from({ length: 10 }, () => st.requestHandoff(s, v)),
    );
    const ids = new Set(
      out.map((o) => (o.mode === 'human' ? o.handoff.id : 'lead')),
    );
    expect(ids.size).toBe(1);
    expect(ids.has('lead')).toBe(false);
    expect(
      await st.owner.assistSiteHandoff.count({
        where: { conversationId: v.conversationId },
      }),
    ).toBe(1);
    expect(out.filter((o) => o.mode === 'human' && !o.existing)).toHaveLength(
      1,
    );
  });
});
