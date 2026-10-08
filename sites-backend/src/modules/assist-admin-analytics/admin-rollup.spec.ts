/**
 * Заход 10, №57: суточная свёртка «Админки» — только агрегаты по ролям
 * (§5-тер.13), итог `*`, роль диалога, начатого раньше, «≈ минут сэкономлено».
 */
import { ROLE_TOTAL, rollupDay } from './admin-rollup.service';

describe('№57 — rollupDay', () => {
  it('роли и итог; сообщения диалога вчерашнего дня — по роли диалога', () => {
    const rows = rollupDay({
      convs: [
        { id: 'c1', employeeRole: 'manager' },
        { id: 'c2', employeeRole: null },
      ],
      convRole: new Map([
        ['c1', 'manager'],
        ['c2', null],
        ['old', 'support'],
      ]),
      msgs: [
        {
          conversationId: 'c1',
          role: 'employee',
          answerPath: null,
          rating: null,
          costMicroUsd: 0,
        },
        {
          conversationId: 'c1',
          role: 'assistant',
          answerPath: 'refused',
          rating: -1,
          costMicroUsd: 100,
        },
        {
          conversationId: 'old',
          role: 'employee',
          answerPath: null,
          rating: null,
          costMicroUsd: 0,
        },
      ],
      labels: [
        {
          employeeRole: 'manager',
          taskType: 'order_status',
          answerFound: 'yes',
          toolError: true,
          status: 'ok',
        },
      ],
      proposals: [
        { conversationId: 'c1', status: 'done', attempts: 1 },
        { conversationId: 'c1', status: 'failed', attempts: 1 },
        { conversationId: 'c1', status: 'rejected', attempts: 0 },
      ],
      minutes: { order_status: 4 },
      usageCostMicroUsd: 50,
    });
    const total = rows.find((r) => r.role === ROLE_TOTAL)!;
    const manager = rows.find((r) => r.role === 'manager')!;
    const none = rows.find((r) => r.role === '—')!;
    const support = rows.find((r) => r.role === 'support')!;
    expect(total).toMatchObject({
      conversations: 2,
      questions: 2,
      refused: 1,
      thumbsDown: 1,
      labeled: 1,
      answerYes: 1,
      toolErrors: 1,
      proposed: 3,
      confirmed: 2,
      actionsFailed: 1,
      minutesSaved: 4,
      taskTypes: { order_status: 1 },
      costMicroUsd: 150,
    });
    expect(manager).toMatchObject({ conversations: 1, questions: 1 });
    expect(manager.costMicroUsd).toBe(100);
    expect(none.conversations).toBe(1);
    expect(support).toMatchObject({ conversations: 0, questions: 1 });
    // Разреза по сотруднику в свёртке нет — только роли.
    expect(Object.keys(total)).not.toContain('employee');
  });
});
