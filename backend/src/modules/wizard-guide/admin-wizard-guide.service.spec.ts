/**
 * Настройки советника в админке — «Тонкая красная линия» §5.8, §10.
 *
 * Проверяется ровно то, что ломается молча: частичное сохранение (не
 * переписать соседнее поле), разбор мусора (не выключить фичу нулём) и
 * нормализация (ноль — законное значение, отрицательное — нет).
 */

import { AdminWizardGuideService } from './admin-wizard-guide.service';
import {
  AI_GUIDE_BUDGET_KEY,
  AI_GUIDE_ENABLED_KEY,
  AI_GUIDE_PERSONAL_LIMIT_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  DEFAULT_PERSONAL_LIMIT,
} from './guide-settings';

function build(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const settings = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  return {
    svc: new AdminWizardGuideService(settings as never),
    settings,
    store,
  };
}

describe('AdminWizardGuideService', () => {
  it('без настроек отдаёт умолчания, а не нули', async () => {
    // Ноль бюджета означает «сегодня не тратим» — это другое состояние,
    // и подставлять его вместо «не настроено» значило бы выключить
    // фичу молча.
    const { svc } = build();
    expect(await svc.get()).toEqual({
      enabled: false,
      dailyBudgetMicroUsd: DEFAULT_DAILY_BUDGET_MICRO_USD,
      personalLimit: DEFAULT_PERSONAL_LIMIT,
    });
  });

  it('мусор в настройке не выключает фичу', async () => {
    const { svc } = build({
      [AI_GUIDE_BUDGET_KEY]: 'много',
      [AI_GUIDE_PERSONAL_LIMIT_KEY]: '-5',
    });
    const view = await svc.get();
    expect(view.dailyBudgetMicroUsd).toBe(DEFAULT_DAILY_BUDGET_MICRO_USD);
    expect(view.personalLimit).toBe(DEFAULT_PERSONAL_LIMIT);
  });

  it('ноль сохраняется и читается как ноль', async () => {
    const { svc } = build();
    const view = await svc.set({ dailyBudgetMicroUsd: 0 });
    expect(view.dailyBudgetMicroUsd).toBe(0);
  });

  it('сохранение бюджета не трогает рубильник', async () => {
    // Карточка правит поля по одному. Если `set` писал бы все ключи,
    // сохранение бюджета возвращало бы рубильник к тому значению,
    // которое лежало на экране в момент загрузки.
    const { svc, settings } = build({ [AI_GUIDE_ENABLED_KEY]: 'true' });
    await svc.set({ dailyBudgetMicroUsd: 5_000_000 });
    const keys = settings.set.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([AI_GUIDE_BUDGET_KEY]);
    expect((await svc.get()).enabled).toBe(true);
  });

  it('рубильник пишется строкой, которую читает сам сервис', async () => {
    // `available()` сравнивает с 'true' буквально: `String(false)` и
    // 'false' здесь обязаны совпадать, иначе выключение «сработает»
    // на экране и не сработает в мастере.
    const { svc, store } = build();
    await svc.set({ enabled: true });
    expect(store.get(AI_GUIDE_ENABLED_KEY)).toBe('true');
    await svc.set({ enabled: false });
    expect(store.get(AI_GUIDE_ENABLED_KEY)).toBe('false');
  });

  it('отрицательный лимит не уезжает в хранилище', async () => {
    const { svc, store } = build();
    await svc.set({ personalLimit: -3 });
    expect(store.get(AI_GUIDE_PERSONAL_LIMIT_KEY)).toBe('0');
  });
});
