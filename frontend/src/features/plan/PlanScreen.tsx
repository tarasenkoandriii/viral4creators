/**
 * PlanScreen (#/plan) — выбор режима сервиса: Lite / Standard / Premium
 * (ТЗ §23, этап 29; оплата — ТЗ §41, этап 62).
 *
 * Экран рисуется ИЗ МАТРИЦЫ, пришедшей с сервера (`GET /me/plan`), а не из
 * своей копии: названия, описания и список возможностей у каждого режима —
 * это `state.plans`. Поэтому сдвиг границы пакета правится в
 * `backend/src/common/plans.ts` и сразу виден здесь, без правки интерфейса.
 *
 * Пока `billingEnabled=false`, все три режима бесплатны и переключаются
 * самостоятельно. Когда оплата включена, `PATCH /me/plan` меняет поведение
 * (`plan.service.ts` на бэкенде, решение 4 этапа 62): LITE — запрос отмены
 * текущей подписки (доступ остаётся до конца оплаченного периода, поэтому
 * кнопка на карточке Lite здесь ведёт себя как «Отменить подписку», а не
 * как обычное переключение), STANDARD/PREMIUM — покупка через Stars или
 * WayForPay (`services/billing-api.ts`), а не самостоятельный выбор.
 */

import { useEffect, useState } from 'react';
import {
  Check,
  Coins,
  CreditCard,
  Info,
  Lock,
  Megaphone,
  Sparkles,
  Youtube,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Spinner,
} from '../../components/ui';
import {
  errorMessage,
  isUnauthorized,
  setPlan,
} from '../../services/projects-api';
import {
  pollPlanState,
  startSubscriptionCheckout,
  submitWayForPayForm,
} from '../../services/billing-api';
import {
  acceptMarketingConsent,
  getMarketingConsent,
  revokeMarketingConsent,
} from '../../services/marketing-api';
import { openStarsInvoice } from '../../lib/telegram';
import { LoadError } from '../projects/shared';
import { usePlanContext } from '../../lib/plan-context';
import { PLAN_ORDER } from '../../lib/plan';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import type {
  MarketingConsentStatus,
  PaymentMethod,
  PlanFeature,
  PlanId,
} from '../../types';

const FEATURE_ORDER: PlanFeature[] = [
  'library',
  'relevance',
  'audit',
  'publication',
  'brandManifest',
  'referenceAssets',
  'characterReplacement',
  'customAspectRatio',
  'fullQualityVideo',
  // Этап 73 (TODO п.32): клонирование своего голоса через Resemble AI.
  'voiceCloning',
  // Доп. запрос владельца продукта: дубляж — премиальный уровень озвучки.
  'voiceDub',
];

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale);
}

export function PlanScreen() {
  const { dict, locale } = useI18n();
  const { state, error: loadError, refresh } = usePlanContext();
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState<{
    plan: Extract<PlanId, 'STANDARD' | 'PREMIUM'>;
    method: PaymentMethod;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Согласие на рассылку подборки роликов (ТЗ §42, этап 63) — статус
  // грузится отдельно от `state.plans`: он не влияет ни на один режим и
  // не приходит в `GET /me/plan`, потому что вообще не про режим.
  const [consent, setConsent] = useState<MarketingConsentStatus | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  useEffect(() => {
    getMarketingConsent()
      .then(setConsent)
      .catch(() => {
        // Анонимный пользователь или сбой сети — карточка просто не
        // покажет переключатель (см. рендер ниже), это не блокирующая
        // ошибка экрана режимов.
      });
  }, []);

  const toggleConsent = async () => {
    setConsentBusy(true);
    setConsentError(null);
    try {
      const next = consent?.consented
        ? await revokeMarketingConsent()
        : await acceptMarketingConsent();
      setConsent(next);
    } catch (e) {
      setConsentError(
        isUnauthorized(e)
          ? dict.marketingConsent.unauthorizedError
          : errorMessage(e)
      );
    } finally {
      setConsentBusy(false);
    }
  };

  if (!state) {
    // Сбой загрузки и «ещё грузится» — разные экраны (этап 119, В-5.6).
    // Раньше это был один спиннер без выхода: единственный повтор
    // (`refresh`) находится ниже по коду, то есть ЗА этим самым
    // возвратом, и добраться до него было нельзя — экран висел до
    // перезапуска приложения.
    if (loadError) {
      return (
        <div className="space-y-4 py-4">
          <LoadError error={loadError} onRetry={refresh} />
        </div>
      );
    }
    return (
      <div className="flex justify-center py-10">
        <Spinner size={24} />
      </div>
    );
  }

  const switchTo = async (id: PlanId) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await setPlan(id);
      refresh();
    } catch (e) {
      setError(
        isUnauthorized(e) ? dict.planScreen.unauthorizedError : errorMessage(e)
      );
    } finally {
      setBusy(null);
    }
  };

  const cancelSubscription = (id: Extract<PlanId, 'LITE'>) => {
    if (
      !window.confirm(
        dict.planScreen.cancelSubscriptionConfirm
          .replace('{{plan}}', state.plans[state.plan]?.title ?? state.plan)
          .replace(
            '{{date}}',
            state.subscription
              ? formatDate(state.subscription.currentPeriodEnd, locale)
              : ''
          )
      )
    ) {
      return;
    }
    void switchTo(id);
  };

  const buy = async (
    plan: Extract<PlanId, 'STANDARD' | 'PREMIUM'>,
    method: PaymentMethod
  ) => {
    setCheckoutBusy({ plan, method });
    setError(null);
    setNotice(null);
    try {
      const result = await startSubscriptionCheckout(plan, method);
      if (method === 'STARS' && result.starsInvoiceUrl) {
        const status = await openStarsInvoice(result.starsInvoiceUrl);
        // Г-1.3 (аудит round4, этап 64): `pending` по API Telegram —
        // «счёт оплачен, подтверждение ещё идёт», не отказ. Раньше это
        // считалось отказом и предлагало заплатить снова, хотя звёзды уже
        // списаны — обрабатываем как `paid` (тот же pollPlanState).
        if (status === 'paid' || status === 'pending') {
          setNotice(dict.planScreen.checkoutPending);
          await pollPlanState((s) => s.plan === plan);
          refresh();
          setNotice(dict.planScreen.checkoutSuccess);
        } else if (status === 'cancelled') {
          setNotice(dict.planScreen.checkoutCancelled);
        } else {
          setError(dict.planScreen.checkoutFailed);
        }
      } else if (
        method === 'WAYFORPAY' &&
        result.wayforpayFormUrl &&
        result.wayforpayFields
      ) {
        // Уводит со страницы (форма WayForPay) — опрос состояния после
        // возврата делает App.tsx при следующей загрузке /me/plan.
        submitWayForPayForm(result.wayforpayFormUrl, result.wayforpayFields);
      } else {
        setError(dict.planScreen.checkoutError);
      }
    } catch (e) {
      setError(
        isUnauthorized(e) ? dict.planScreen.unauthorizedError : errorMessage(e)
      );
    } finally {
      setCheckoutBusy(null);
    }
  };

  return (
    <div className="space-y-4 animate-fadeIn">
      <Card className="p-5">
        <CardHeader
          icon={<Sparkles size={18} className="text-accent" />}
          title={dict.planScreen.title}
          hint={dict.planScreen.hint}
        />
        {state.billingEnabled ? (
          <Alert tone="info">{dict.planScreen.billingAlert}</Alert>
        ) : (
          <Alert tone="success">
            {dict.planScreen.freeAlertPrefix}
            <b>{dict.planScreen.freeAlertBold}</b>
            {dict.planScreen.freeAlertSuffix}
          </Alert>
        )}

        {/* Кредиты (§41.1) — счётные генерации отдельно от режима, не
            сгорают. Баланс виден всегда, даже когда оплата ещё выключена
            (тогда он просто всегда 0 — покупать негде). */}
        <button
          type="button"
          onClick={() => navigate(routes.credits())}
          className="mt-3 flex w-full items-center justify-between gap-2 rounded-xl border border-dashed border-silver-300 p-2.5 text-left text-[11px] text-silver-500 transition-colors hover:border-accent dark:border-silver-700 dark:text-silver-300"
        >
          <span className="flex items-center gap-1.5">
            <Coins size={12} className="shrink-0 text-accent" />
            {dict.planScreen.creditsBadge.replace(
              '{{n}}',
              String(state.credits.balance)
            )}
          </span>
          <span className="text-accent">{dict.planScreen.buyCreditsLink}</span>
        </button>
        <p className="mt-1.5 text-[11px] text-silver-400">
          {dict.planScreen.creditsHint}
        </p>

        {notice && (
          <Alert
            tone="success"
            className="mt-3"
            onDismiss={() => setNotice(null)}
          >
            {notice}
          </Alert>
        )}
        {error && (
          <Alert tone="error" className="mt-3" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
      </Card>

      {PLAN_ORDER.map((id) => {
        const plan = state.plans[id];
        if (!plan) return null;
        const current = state.plan === id;
        const paidPlan = id === 'STANDARD' || id === 'PREMIUM';
        return (
          <Card
            key={id}
            className={`p-5 ${current ? 'ring-1 ring-accent' : ''}`}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold tracking-tight">
                {plan.title}
              </h3>
              {id === 'LITE' && <Badge>{dict.planScreen.defaultBadge}</Badge>}
              {current ? (
                <Badge tone="accent">
                  <Check size={9} /> {dict.planScreen.currentBadge}
                </Badge>
              ) : (
                !state.billingEnabled && (
                  <Badge tone="success">{dict.planScreen.freeBadge}</Badge>
                )
              )}
            </div>
            <p className="text-xs leading-relaxed text-silver-500 dark:text-silver-300">
              {plan.summary}
            </p>

            {plan.aspectRatios.length > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-silver-400">
                <Info size={11} className="mt-0.5 shrink-0" />
                <span>
                  {dict.planScreen.aspectRatioPrefix}{' '}
                  <span className="font-mono tabular">
                    {plan.aspectRatios.join(
                      ` ${dict.planScreen.aspectRatioJoiner} `
                    )}
                  </span>
                  {dict.planScreen.aspectRatioSuffix}
                </span>
              </p>
            )}

            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {FEATURE_ORDER.map((f) => {
                const on = plan.features[f];
                return (
                  <li
                    key={f}
                    className={`flex items-center gap-1.5 text-[11px] ${
                      on ? '' : 'text-silver-400'
                    }`}
                  >
                    {on ? (
                      <Check size={12} className="shrink-0 text-emerald-500" />
                    ) : (
                      <Lock size={12} className="shrink-0" />
                    )}
                    <span
                      className={
                        on ? '' : 'line-through decoration-silver-400/50'
                      }
                    >
                      {dict.planScreen.featureLabels[f]}
                    </span>
                  </li>
                );
              })}
            </ul>

            {id === 'LITE' && (
              <p className="mt-3 inline-flex items-start gap-1.5 rounded-xl border border-dashed border-silver-300 p-2.5 text-[11px] text-silver-400 dark:border-silver-700">
                <Youtube size={12} className="mt-0.5 shrink-0" />
                <span>{dict.planScreen.liteHint}</span>
              </p>
            )}

            {/* Статус подписки (§41.4) — только на карточке текущего
                оплаченного режима, чтобы не дублировать одну и ту же
                информацию на трёх карточках сразу. */}
            {current && state.billingEnabled && state.subscription && (
              <p className="mt-3 text-[11px] text-silver-400">
                {state.subscription.status === 'PAST_DUE'
                  ? dict.planScreen.subscriptionPastDue
                  : state.subscription.cancelAtPeriodEnd
                    ? dict.planScreen.subscriptionCanceling.replace(
                        '{{date}}',
                        formatDate(state.subscription.currentPeriodEnd, locale)
                      )
                    : dict.planScreen.subscriptionActiveUntil.replace(
                        '{{date}}',
                        formatDate(state.subscription.currentPeriodEnd, locale)
                      )}
              </p>
            )}

            <div className="mt-4">
              {current ? (
                paidPlan &&
                state.billingEnabled &&
                state.subscription &&
                !state.subscription.cancelAtPeriodEnd ? (
                  <Button
                    block
                    variant="outline"
                    loading={busy === 'LITE'}
                    disabled={busy !== null}
                    onClick={() => cancelSubscription('LITE')}
                  >
                    {dict.planScreen.cancelSubscription}
                  </Button>
                ) : (
                  <Button block variant="outline" disabled>
                    {dict.planScreen.alreadyActive}
                  </Button>
                )
              ) : !state.billingEnabled ? (
                <Button
                  block
                  loading={busy === id}
                  disabled={busy !== null}
                  onClick={() => void switchTo(id)}
                >
                  {dict.planScreen.switchTo.replace('{{plan}}', plan.title)}
                </Button>
              ) : id === 'LITE' ? (
                <Button
                  block
                  variant="outline"
                  loading={busy === 'LITE'}
                  disabled={busy !== null || !state.subscription}
                  onClick={() => cancelSubscription('LITE')}
                >
                  {dict.planScreen.cancelSubscription}
                </Button>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    block
                    icon={<Sparkles size={14} />}
                    loading={
                      checkoutBusy?.plan === id &&
                      checkoutBusy.method === 'STARS'
                    }
                    disabled={checkoutBusy !== null}
                    onClick={() => void buy(id, 'STARS')}
                  >
                    {dict.planScreen.buyViaStars}
                  </Button>
                  <Button
                    block
                    variant="outline"
                    icon={<CreditCard size={14} />}
                    loading={
                      checkoutBusy?.plan === id &&
                      checkoutBusy.method === 'WAYFORPAY'
                    }
                    disabled={checkoutBusy !== null}
                    onClick={() => void buy(id, 'WAYFORPAY')}
                  >
                    {dict.planScreen.buyViaWayForPay}
                  </Button>
                </div>
              )}
              {id !== 'LITE' && (
                // Г-6.4 из аудита round4: экраны оплаты не содержали ни
                // одной ссылки на оферту/условия — тот же паттерн ссылок,
                // что у TermsGate.tsx.
                <p className="mt-2 text-[11px] leading-relaxed text-silver-500 dark:text-silver-400">
                  {dict.planScreen.legalNotePrefix}{' '}
                  <a
                    href={`#${routes.legal('offer')}`}
                    className="text-accent underline"
                  >
                    {dict.termsGate.offerLink}
                  </a>{' '}
                  {dict.termsGate.and}{' '}
                  <a
                    href={`#${routes.legal('terms-of-use')}`}
                    className="text-accent underline"
                  >
                    {dict.termsGate.termsLink}
                  </a>
                </p>
              )}
            </div>
          </Card>
        );
      })}

      {/* Рекламный канал (ТЗ §42, этап 63) — добровольная подписка на
          подборку удачных роликов через Telegram-бота, полностью
          отдельная от режимов выше. Карточка появляется только у
          идентифицированного пользователя (consent === null у
          анонимного или при сбое загрузки — см. эффект выше). */}
      {consent && (
        <Card className="p-5">
          <CardHeader
            icon={<Megaphone size={18} className="text-accent" />}
            title={dict.marketingConsent.title}
            hint={dict.marketingConsent.hint}
          />
          <p className="mt-1 text-[11px] text-silver-400">
            {consent.consented
              ? dict.marketingConsent.subscribedNotice
              : dict.marketingConsent.notSubscribedNotice}
          </p>
          {consentError && (
            <Alert
              tone="error"
              className="mt-3"
              onDismiss={() => setConsentError(null)}
            >
              {consentError}
            </Alert>
          )}
          <div className="mt-3">
            <Button
              block
              variant={consent.consented ? 'outline' : undefined}
              loading={consentBusy}
              disabled={consentBusy}
              onClick={() => {
                if (
                  consent.consented &&
                  !window.confirm(dict.marketingConsent.unsubscribeConfirm)
                ) {
                  return;
                }
                void toggleConsent();
              }}
            >
              {consent.consented
                ? dict.marketingConsent.unsubscribeButton
                : dict.marketingConsent.subscribeButton}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
