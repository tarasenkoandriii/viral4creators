/**
 * Ш5 (4) / Ш6 (8): внутренний тенант платформы (`ASSIST_INTERNAL_SITE_IDS`)
 * на реальном Postgres, конвейер ответа — под ролью assist_public:
 *  - пробный истёк и единиц периода «потрачено» больше лимита любого тарифа —
 *    мягкого стопа нет, модель отвечает, конфиг виджета — active;
 *  - денежный потолок СОХРАНЯЕТСЯ: суточный $-потолок сайта (по тарифу
 *    `INTERNAL_PLAN_ID`) выбран — отказ без модели, конфиг — lead_only;
 *  - оплата и автодокупка внутреннему тенанту — 409 `INTERNAL_PLAN`;
 *  - чужой кабинет (сайт не из списка) — обычный тариф и мягкий стоп.
 */
import { WidgetPublicConfigService } from '../../modules/assist-widget/widget-config.service';
import type { HandoffIntake } from '../../modules/assist-site-handoff/public/handoff-intake.service';
import type { GoalIntake } from '../../modules/assist-analytics/public/goal-intake.service';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { utcDay } from '../../modules/assist-site-chat/budget';
import {
  claimUnits,
  isInternalAccount,
  readState,
} from '../../modules/assist-billing/public/entitlements';
import { siteDailyCapFromPlan } from '../../modules/assist-billing/plans';
import {
  INTERNAL_PLAN_ID,
  INTERNAL_SITE_IDS_ENV,
} from '../../modules/assist-billing/subscription-state';
import {
  seedUsage,
  usageOf,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import {
  billingServices,
  type BillingServices,
} from '../../modules/assist-billing/testing/billing-stack.testing';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
} from '../../modules/site-core/account/roles';

jest.setTimeout(180_000);

const DAY = 86_400_000;

describeDb('Ш5 (4) / Ш6 (8) — внутренний тенант без мягкого стопа', () => {
  const st = new ChatStack();
  let b: BillingServices;
  let widget: WidgetPublicConfigService;
  const saved = process.env[INTERNAL_SITE_IDS_ENV];

  beforeAll(async () => {
    await st.init();
    b = billingServices(st.owner);
    widget = new WidgetPublicConfigService(
      st.publicDb,
      {} as HandoffIntake,
      {} as GoalIntake,
    );
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env[INTERNAL_SITE_IDS_ENV];
    else process.env[INTERNAL_SITE_IDS_ENV] = saved;
    await st.close();
  });
  beforeEach(() => {
    st.model.mode = 'honest';
    st.model.delayMs = 0;
    st.model.calls.length = 0;
  });

  const owner = (s: ChatSite): AccountMembership => ({
    accountId: s.accountId,
    memberId: 'm',
    telegramId: BigInt(s.ownerTelegramId),
    role: 'owner',
    productRoles: OWNER_PRODUCT_ROLES,
  });

  /** Пробный истёк: первый сайт кабинета — 30 дней назад. */
  async function expireTrial(s: ChatSite): Promise<void> {
    const old = new Date(Date.now() - 30 * DAY);
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { createdAt: old },
    });
    await st.owner.site.update({
      where: { id: s.siteId },
      data: { createdAt: old },
    });
  }

  it('пробный истёк и единиц больше любого лимита — ответ модели, active; единицы считаются', async () => {
    const s = await st.stand('saas');
    const other = await st.stand('shop');
    await expireTrial(s);
    await expireTrial(other);
    // Обычный кабинет с истёкшим пробным — мягкий стоп (контроль).
    process.env[INTERNAL_SITE_IDS_ENV] = `${s.siteId} not-a-site`;
    expect(
      (await readState(st.publicDb, other.accountId, new Date())).planId,
    ).toBeNull();
    const denied = await st.ask(other, 'Сколько стоит доставка?');
    expect(denied.error).toMatchObject({ code: 'site_quota' });
    expect(st.model.calls).toHaveLength(0);

    const state = await readState(st.publicDb, s.accountId, new Date());
    expect(state).toMatchObject({
      planId: INTERNAL_PLAN_ID,
      method: 'internal',
      status: 'active',
      internal: true,
    });
    // Больше, чем лимит самого дорогого тарифа (pro — 3000).
    await seedUsage(st.owner, s.accountId, { units: 5_000 });
    expect(await widget.spentOut(s)).toBe(false);
    const ok = await st.ask(s, 'Сколько стоит тариф Старт?');
    expect(ok.error).toBeNull();
    expect(st.model.calls).toHaveLength(1);
    await st.chat.idle();
    expect((await usageOf(st.owner, s.accountId))!.units).toBeGreaterThan(
      5_000,
    );
    // Прямой захват под assist_public — тоже без стопа, единицы учтены.
    const before = (await usageOf(st.owner, s.accountId))!.units;
    await expect(
      claimUnits(st.publicDb, {
        accountId: s.accountId,
        state,
        units: 3,
        dialogs: 1,
      }),
    ).resolves.toBe(true);
    expect((await usageOf(st.owner, s.accountId))!.units).toBe(before + 3);
    const u = await st.owner.assistAccountUsage.findFirstOrThrow({
      where: { accountId: s.accountId, periodKey: state.periodKey! },
    });
    expect(u.exhaustedAt).toBeNull();

    // Список пуст — тот же кабинет снова обычный (пробный истёк → стоп).
    delete process.env[INTERNAL_SITE_IDS_ENV];
    expect(await isInternalAccount(st.publicDb, s.accountId)).toBe(false);
    expect(await widget.spentOut(s)).toBe(true);
  });

  it('денежный потолок сохраняется: суточный $-потолок сайта по тарифу выбран → отказ без модели, lead_only', async () => {
    const s = await st.stand('services');
    process.env[INTERNAL_SITE_IDS_ENV] = s.siteId;
    expect(await widget.spentOut(s)).toBe(false);
    const cap = siteDailyCapFromPlan(INTERNAL_PLAN_ID);
    expect(cap).toBeGreaterThan(0);
    await st.owner.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_budget_days" ("scope","key","day","spentMicroUsd","reservedMicroUsd","updatedAt")
       VALUES ('site', $1, $2, $3, 0, now())`,
      s.siteId,
      utcDay(new Date()),
      BigInt(cap),
    );
    expect(await widget.spentOut(s)).toBe(true);
    const r = await st.ask(s, 'Скільки коштує діагностика ноутбука?');
    expect(r.error).toMatchObject({ code: 'site_quota' });
    expect(st.model.calls).toHaveLength(0);
    // Потолок платформы (env) — тоже действует на внутреннего.
    await st.owner.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_budget_days" WHERE "scope" = 'site' AND "key" = $1`,
      s.siteId,
    );
    expect(await widget.spentOut(s)).toBe(false);
    const prev = process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD;
    process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD = '0';
    try {
      expect(await widget.spentOut(s)).toBe(true);
    } finally {
      if (prev === undefined)
        delete process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD;
      else process.env.ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD = prev;
    }
  });

  it('оплата и автодокупка внутреннему тенанту — 409 INTERNAL_PLAN; обычному — как раньше', async () => {
    const s = await st.stand('saas');
    const other = await st.stand('shop');
    process.env[INTERNAL_SITE_IDS_ENV] = s.siteId;
    b.billing.env = { ...b.billing.env, [INTERNAL_SITE_IDS_ENV]: s.siteId };
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: { getResponse?: () => { code?: string } }) =>
          e.getResponse?.().code ?? String(e),
      );
    expect(
      await code(
        b.billing.checkout(owner(s), {
          kind: 'subscription',
          planId: 'start',
          method: 'wayforpay',
        }),
      ),
    ).toBe('INTERNAL_PLAN');
    expect(
      await code(
        b.billing.setAutoTopUp(owner(s), { enabled: true, capUsd: 10 }),
      ),
    ).toBe('INTERNAL_PLAN');
    // Обычный кабинет — прежняя проверка (сначала Условия и DPA).
    expect(
      await code(
        b.billing.checkout(owner(other), {
          kind: 'subscription',
          planId: 'start',
          method: 'wayforpay',
        }),
      ),
    ).toBe('LEGAL_REQUIRED');
    const view = await b.billing.overview(owner(s));
    expect(view.plan).toMatchObject({
      id: INTERNAL_PLAN_ID,
      method: 'internal',
      renews: false,
    });
  });
});
