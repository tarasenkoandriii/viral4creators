/**
 * «Тариф и оплата» (Э4; ТЗ §3.10, §7.1, §3.1, №49): текущий тариф и счётчик
 * периода, предупреждения 80/100%, тарифы с ценой в гривне и Stars,
 * оплата (Stars — `openInvoice` бота Помощника, карта — форма WayForPay),
 * докупка, автодокупка с потолком, отмена автопродления, Условия и DPA.
 * Сумма к оплате считается сервером — клиент выбирает только что купить.
 */
import { useEffect, useState } from 'react';
import {
  ApiError,
  fmt,
  formatDate,
  getTelegramWebApp,
  useAsync,
  useKit,
} from '../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../kit/ui';
import {
  PAID_PLAN_IDS,
  clampPacks,
  createPayer,
  planAlert,
  submitWayForPay,
  uahAmount,
  usageLevel,
  type BillingOverview,
  type CheckoutRequest,
  type InvoiceStatus,
  type PaidPlanId,
  type PayDeps,
  type PaymentMethod,
} from '../lib/billing-api';
import { useAssist } from '../lib/assist-context';
import { openExternal } from '../lib/open-link';
import { LoadError, NoticeBar, type Notice } from './knowledge/parts';

type WebAppInvoice = {
  openInvoice?: (url: string, cb?: (status: InvoiceStatus) => void) => void;
  openTelegramLink?: (url: string) => void;
};

function invoiceOpener(): PayDeps['openInvoice'] {
  const tg = getTelegramWebApp() as WebAppInvoice | null | undefined;
  const open = tg?.openInvoice;
  return open ? (url, cb) => open.call(tg, url, cb) : null;
}

/** Счёт Stars — ссылка t.me: в TMA — `openTelegramLink`, в вебе — вкладка. */
function openTelegramLink(url: string): void {
  const tg = getTelegramWebApp() as WebAppInvoice | null | undefined;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else openExternal(url);
}

export function BillingScreen({ plan }: { plan: string | null }) {
  const { locale, dict } = useKit();
  const { appDict, billing } = useAssist();
  const t = appDict.billing;
  const data = useAsync(() => billing.overview(), [billing]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [ov, setOv] = useState<BillingOverview | null>(null);
  useEffect(() => {
    if (data.data) setOv(data.data);
  }, [data.data]);
  // Один замок на экран: повторное нажатие не создаёт второй счёт.
  const [payer] = useState(() =>
    createPayer({
      checkout: (req) => billing.checkout(req),
      openInvoice: invoiceOpener(),
      openTelegramLink,
      submitWayForPay,
    })
  );

  if (data.loading && !ov) return <Spinner label={dict.common.loading} />;
  if (!ov) return <LoadError error={data.error} onRetry={data.reload} />;

  const err = (e: unknown) => {
    const msg =
      e instanceof ApiError && e.code === 'LEGAL_REQUIRED'
        ? t.legal.needed
        : e instanceof ApiError && e.code === 'PAYMENT_METHOD_UNAVAILABLE'
          ? t.noMethods
          : e instanceof Error && e.message
            ? e.message
            : t.failed;
    setNotice({ tone: 'danger', text: msg });
  };

  /** После оплаты — опрос статуса платежа, затем свежая сводка. */
  const follow = async (paymentId: string) => {
    setNotice({ tone: 'warning', text: t.pending });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await billing.payment(paymentId).catch(() => null);
      if (s?.status === 'succeeded') {
        setNotice({ tone: 'success', text: t.paid });
        const fresh = await billing.overview().catch(() => null);
        if (fresh) setOv(fresh);
        return;
      }
      if (s?.status === 'failed') {
        setNotice({ tone: 'danger', text: t.failed });
        return;
      }
    }
  };

  const pay = async (req: CheckoutRequest) => {
    if (payer.isLocked()) return;
    setBusy(true);
    setNotice(null);
    let keepBusy = false;
    try {
      const out = await payer.pay(req);
      if (out.kind === 'follow') {
        try {
          await follow(out.paymentId);
        } finally {
          payer.release();
        }
      } else if (out.kind === 'redirected' || out.kind === 'busy') {
        keepBusy = out.kind === 'redirected';
      } else if (out.kind === 'failed') {
        setNotice({ tone: 'danger', text: t.failed });
      } else if (out.kind === 'closed') {
        setNotice({ tone: 'warning', text: t.invoiceClosed });
      } else {
        setNotice({ tone: 'danger', text: t.noMethods });
      }
    } catch (e) {
      err(e);
    } finally {
      if (!keepBusy) setBusy(false);
    }
  };

  const legalOk = ov.legal.terms.accepted && ov.legal.dpa.accepted;
  const lvl = usageLevel(ov.usage);
  const alert = planAlert(ov);
  const planName = (id: string | null) =>
    id ? (t.plans[id as keyof typeof t.plans] ?? id) : '—';

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <NoticeBar notice={notice} />

      <Card className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <div className="font-semibold flex-1">
            {fmt(t.current, { plan: planName(ov.plan.id) })}
          </div>
          <Badge
            tone={
              ov.plan.status === 'expired'
                ? 'danger'
                : ov.plan.status === 'grace'
                  ? 'warning'
                  : ov.plan.status === 'none'
                    ? 'neutral'
                    : 'success'
            }
          >
            {t.status[ov.plan.status]}
          </Badge>
        </div>
        {ov.plan.periodStart && ov.plan.periodEnd && (
          <div className="text-silver-500">
            {fmt(t.period, {
              from: formatDate(ov.plan.periodStart, locale),
              to: formatDate(ov.plan.periodEnd, locale),
            })}
          </div>
        )}
        {ov.plan.paidThrough && ov.plan.id !== 'trial' && (
          <div className="text-silver-500">
            {fmt(t.paidThrough, {
              date: formatDate(ov.plan.paidThrough, locale),
            })}{' '}
            {ov.plan.renews
              ? fmt(t.renews, {
                  method:
                    t.methods[ov.plan.method as keyof typeof t.methods] ??
                    ov.plan.method,
                })
              : t.noRenew}
          </div>
        )}
        <div>
          {fmt(t.usage, {
            used: String(ov.usage.units),
            limit: String(ov.usage.limit),
          })}
          {ov.usage.extraUnits > 0 &&
            ` (${fmt(t.usageExtra, { extra: String(ov.usage.extraUnits) })})`}
        </div>
        <div className="h-2 rounded bg-silver-200 dark:bg-silver-800 overflow-hidden">
          <div
            className={`h-2 ${lvl.level === 'full' ? 'bg-red-500' : lvl.level === 'warn' ? 'bg-amber-500' : 'bg-accent'}`}
            style={{ width: `${Math.min(100, Math.round(lvl.share * 100))}%` }}
          />
        </div>
        {alert === 'expired' && <Alert tone="danger">{t.expired}</Alert>}
        {alert === 'full' && <Alert tone="danger">{t.full}</Alert>}
        {alert === 'grace' && <Alert tone="warning">{t.grace}</Alert>}
        {alert === 'warn' && <Alert tone="warning">{t.warn80}</Alert>}
        <p className="text-xs text-silver-500">
          {fmt(t.weights, {
            voice: String(ov.dialogWeights.voice),
            admin: String(ov.dialogWeights.admin),
          })}
        </p>
        {ov.canPay && ov.plan.renews && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              billing
                .setCancel(true)
                .then((v) => {
                  setOv(v);
                  setNotice({
                    tone: 'success',
                    text: fmt(t.canceled, {
                      date: formatDate(v.plan.paidThrough, locale),
                    }),
                  });
                })
                .catch(err)
                .finally(() => setBusy(false));
            }}
          >
            {t.cancel}
          </Button>
        )}
        {ov.canPay && ov.plan.cancelAtPeriodEnd && ov.plan.id && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              billing
                .setCancel(false)
                .then(setOv)
                .catch(err)
                .finally(() => setBusy(false));
            }}
          >
            {t.resume}
          </Button>
        )}
      </Card>

      {!ov.canPay && <Alert tone="warning">{t.ownerOnly}</Alert>}

      {ov.canPay && <LegalCard ov={ov} onDone={setOv} onError={err} />}

      <h2 className="font-semibold">{t.choose}</h2>
      {ov.plans.map((p) => {
        const current = p.id === ov.plan.id;
        const chosen = plan === p.id;
        return (
          <Card
            key={p.id}
            className={`space-y-2 text-sm ${chosen ? 'ring-2 ring-accent' : ''}`}
          >
            <div className="flex items-center gap-2">
              <div className="font-semibold flex-1">{planName(p.id)}</div>
              {current && <Badge tone="accent">{t.currentPlan}</Badge>}
            </div>
            <div>
              {p.price
                ? fmt(t.perMonth, { price: String(p.priceUsdMonthly) })
                : fmt(t.free, { days: '14' })}
            </div>
            <ul className="text-silver-500 list-disc pl-5">
              <li>
                {fmt(t.features.dialogs, { n: String(p.dialogsPerMonth) })}
              </li>
              <li>{fmt(t.features.sites, { n: String(p.sites) })}</li>
              <li>{fmt(t.features.pages, { n: String(p.knowledgePages) })}</li>
              <li>
                {fmt(t.features.operators, { n: String(p.telegramOperators) })}
              </li>
              <li>
                {fmt(t.features.retention, { n: String(p.retentionDays) })}
              </li>
              <li>
                {p.overageUsdPer100 === null
                  ? t.features.noOverage
                  : fmt(t.features.overage, {
                      price: String(p.overageUsdPer100),
                    })}
              </li>
              {p.voice && <li>{t.features.voice}</li>}
              {p.removePoweredBy && <li>{t.features.removePoweredBy}</li>}
              {p.adminRead && <li>{t.features.adminRead}</li>}
            </ul>
            {ov.canPay &&
              p.price &&
              (PAID_PLAN_IDS as readonly string[]).includes(p.id) && (
                <div className="flex flex-wrap gap-2">
                  {ov.methods.stars && (
                    <Button
                      disabled={busy || !legalOk}
                      onClick={() =>
                        void pay({
                          kind: 'subscription',
                          planId: p.id as PaidPlanId,
                          method: 'stars',
                        })
                      }
                    >
                      {fmt(t.payStars, { stars: String(p.price.stars) })}
                    </Button>
                  )}
                  {ov.methods.wayforpay && (
                    <Button
                      variant="outline"
                      disabled={busy || !legalOk}
                      onClick={() =>
                        void pay({
                          kind: 'subscription',
                          planId: p.id as PaidPlanId,
                          method: 'wayforpay',
                        })
                      }
                    >
                      {fmt(t.payCard, { uah: uahAmount(p.price.uahMinor) })}
                    </Button>
                  )}
                </div>
              )}
          </Card>
        );
      })}
      {ov.canPay && <p className="text-xs text-silver-500">{t.changeNote}</p>}

      {ov.canPay && (
        <TopupCard
          ov={ov}
          busy={busy || !legalOk}
          onPay={(packs, method) => void pay({ kind: 'topup', packs, method })}
        />
      )}
      {ov.canPay && <AutoTopUpCard ov={ov} onDone={setOv} onError={err} />}

      {ov.canPay && ov.payments.length > 0 && (
        <Card className="space-y-1 text-sm">
          <div className="font-semibold">{t.payments}</div>
          {ov.payments.map((p) => (
            <div key={p.id} className="flex gap-2">
              <span className="text-silver-500">
                {formatDate(p.createdAt, locale)}
              </span>
              <span className="flex-1">
                {t.kinds[p.kind as keyof typeof t.kinds] ?? p.kind}
                {p.planId ? ` · ${planName(p.planId)}` : ''}
              </span>
              <span>
                {p.currency === 'XTR'
                  ? `${p.amountMinor} ⭐`
                  : `${uahAmount(p.amountMinor)} ${p.currency}`}
              </span>
              <span className="text-silver-500">
                {t.paymentStatus[p.status as keyof typeof t.paymentStatus] ??
                  p.status}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function LegalCard({
  ov,
  onDone,
  onError,
}: {
  ov: BillingOverview;
  onDone: (v: BillingOverview) => void;
  onError: (e: unknown) => void;
}) {
  const { appDict, billing } = useAssist();
  const t = appDict.billing.legal;
  const [consent, setConsent] = useState(ov.legal.evalConsent);
  const [busy, setBusy] = useState(false);
  const accepted = ov.legal.terms.accepted && ov.legal.dpa.accepted;
  const doc = (label: string, d: { url: string | null; version: string }) => (
    <li>
      {d.url ? (
        <button
          type="button"
          className="text-accent underline"
          onClick={() => openExternal(d.url as string)}
        >
          {label}
        </button>
      ) : (
        label
      )}{' '}
      <span className="text-silver-500">
        ({fmt(t.version, { v: d.version })})
      </span>
    </li>
  );
  return (
    <Card className="space-y-2 text-sm">
      <div className="font-semibold">{t.title}</div>
      <p className="text-silver-500">{t.text}</p>
      <ul className="list-disc pl-5">
        {doc(t.terms, ov.legal.terms)}
        {doc(t.dpa, ov.legal.dpa)}
      </ul>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>{t.evalConsent}</span>
      </label>
      {accepted && consent === ov.legal.evalConsent ? (
        <Alert tone="success">{t.accepted}</Alert>
      ) : (
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            billing
              .acceptLegal(consent)
              .then(() => billing.overview())
              .then(onDone)
              .catch(onError)
              .finally(() => setBusy(false));
          }}
        >
          {t.accept}
        </Button>
      )}
    </Card>
  );
}

function TopupCard({
  ov,
  busy,
  onPay,
}: {
  ov: BillingOverview;
  busy: boolean;
  onPay: (packs: number, method: PaymentMethod) => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.billing.topup;
  const [packs, setPacks] = useState<string>('1');
  if (!ov.topup) {
    return <p className="text-xs text-silver-500">{t.unavailable}</p>;
  }
  const n = clampPacks(packs, ov.topup.maxPacks);
  return (
    <Card className="space-y-2 text-sm">
      <div className="font-semibold">{t.title}</div>
      <label className="block">
        <span className="block text-xs text-silver-500 mb-1">
          {fmt(t.packs, { units: String(ov.topup.packUnits) })}
        </span>
        <input
          type="number"
          min={1}
          max={ov.topup.maxPacks}
          value={packs}
          onChange={(e) => setPacks(e.target.value)}
          onBlur={() => setPacks(String(n))}
          className={inputClass}
        />
      </label>
      <div>
        {fmt(t.price, {
          usd: String(Math.round(ov.topup.priceUsdPer100 * n * 100) / 100),
          uah: uahAmount(ov.topup.pricePerPack.uahMinor * n),
          stars: String(ov.topup.pricePerPack.stars * n),
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {ov.methods.stars && (
          <Button disabled={busy} onClick={() => onPay(n, 'stars')}>
            {fmt(appDict.billing.payStars, {
              stars: String(ov.topup.pricePerPack.stars * n),
            })}
          </Button>
        )}
        {ov.methods.wayforpay && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onPay(n, 'wayforpay')}
          >
            {fmt(appDict.billing.payCard, {
              uah: uahAmount(ov.topup.pricePerPack.uahMinor * n),
            })}
          </Button>
        )}
      </div>
    </Card>
  );
}

function AutoTopUpCard({
  ov,
  onDone,
  onError,
}: {
  ov: BillingOverview;
  onDone: (v: BillingOverview) => void;
  onError: (e: unknown) => void;
}) {
  const { appDict, billing } = useAssist();
  const t = appDict.billing.auto;
  const [enabled, setEnabled] = useState(ov.autoTopUp.enabled);
  const [cap, setCap] = useState(String(ov.autoTopUp.capUsd || ''));
  const [busy, setBusy] = useState(false);
  if (!ov.autoTopUp.available && !ov.autoTopUp.enabled) {
    return (
      <p className="text-xs text-silver-500">{`${t.title}: ${t.unavailable}`}</p>
    );
  }
  return (
    <Card className="space-y-2 text-sm">
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t.title}
      </label>
      <p className="text-silver-500">{t.text}</p>
      <label className="block">
        <span className="block text-xs text-silver-500 mb-1">{t.cap}</span>
        <input
          type="number"
          min={0}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className={inputClass}
        />
      </label>
      <div className="text-silver-500">
        {fmt(t.spent, { usd: String(ov.autoTopUp.spentUsd) })}
      </div>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          billing
            .setAutoTopUp(enabled, Number(cap) || 0)
            .then(onDone)
            .catch(onError)
            .finally(() => setBusy(false));
        }}
      >
        {t.save}
      </Button>
    </Card>
  );
}

/** Счётчик в шапке кабинета (§3.10 «всегда виден»): единицы периода / лимит. */
export function UsageChip() {
  const { appDict, billing } = useAssist();
  const data = useAsync(() => billing.overview(), [billing]);
  if (!data.data) return null;
  const u = data.data.usage;
  const lvl = usageLevel(u);
  return (
    <a
      href="#/billing"
      title={appDict.billing.chipLabel}
      aria-label={appDict.billing.chipLabel}
      className={`text-xs rounded-full px-2 py-1 border ${
        lvl.level === 'full'
          ? 'border-red-500 text-red-600'
          : lvl.level === 'warn'
            ? 'border-amber-500 text-amber-600'
            : 'border-silver-300 text-silver-500'
      }`}
    >
      {fmt(appDict.billing.chip, {
        used: String(u.units),
        limit: String(u.limit),
      })}
    </a>
  );
}
