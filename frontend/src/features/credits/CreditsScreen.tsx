/**
 * CreditsScreen (#/credits) — покупка пакетов кредитов на генерацию
 * (ТЗ §41, этап 62). Отдельный экран от #/plan (не вложен туда): покупка
 * кредитов не зависит от режима — доступна на Lite так же, как на
 * Standard/Premium, и её естественное действие («купить ещё роликов»)
 * отличается от смены режима.
 *
 * Цены (`GET /billing/prices`) — публичный маршрут, читается и анонимно;
 * сама покупка (`POST /billing/checkout/credit-pack`) требует identity —
 * см. `ChannelsScreen`/`PlanScreen` за тем же приёмом обработки 401.
 */

import { useState } from 'react';
import { Coins, CreditCard, Sparkles } from 'lucide-react';
import { Alert, Button, Card, Spinner } from '../../components/ui';
import {
  getBillingPrices,
  pollPlanState,
  startCreditPackCheckout,
  submitWayForPayForm,
} from '../../services/billing-api';
import { openStarsInvoice } from '../../lib/telegram';
import { errorMessage, isUnauthorized } from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { usePlanContext } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import { routes } from '../../lib/router';
import { ScreenHeader, LoadError } from '../projects/shared';
import type { CreditPackDefinition, PaymentMethod } from '../../types';

function wayforpayLabel(pack: CreditPackDefinition): string {
  return `${(pack.wayforpayMinor / 100).toFixed(2)} ${pack.wayforpayCurrency}`;
}

export function CreditsScreen() {
  const { dict } = useI18n();
  const { state, refresh } = usePlanContext();
  const { data, loading, error, reload } = useAsync(getBillingPrices, []);
  const [busy, setBusy] = useState<{
    packId: string;
    method: PaymentMethod;
  } | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const buy = async (pack: CreditPackDefinition, method: PaymentMethod) => {
    setBusy({ packId: pack.id, method });
    setCheckoutError(null);
    setNotice(null);
    setUnauthorized(false);
    const before = state?.credits.balance ?? 0;
    try {
      const result = await startCreditPackCheckout(pack.id, method);
      if (method === 'STARS' && result.starsInvoiceUrl) {
        const status = await openStarsInvoice(result.starsInvoiceUrl);
        // Г-1.3 (аудит round4, этап 64): по API Telegram `pending` значит
        // «счёт оплачен, подтверждение ещё идёт» — не отказ. Раньше это
        // попадало в ветку `else` ниже и показывало «Оплата не прошла»,
        // хотя звёзды с человека уже списаны — он читал это как призыв
        // попробовать снова и платил второй раз. Обрабатываем как `paid`.
        if (status === 'paid' || status === 'pending') {
          setNotice(dict.creditsScreen.checkoutPending);
          await pollPlanState((s) => s.credits.balance > before);
          refresh();
          setNotice(dict.creditsScreen.checkoutSuccess);
        } else if (status === 'cancelled') {
          setNotice(dict.creditsScreen.checkoutCancelled);
        } else {
          setCheckoutError(dict.creditsScreen.checkoutFailed);
        }
      } else if (
        method === 'WAYFORPAY' &&
        result.wayforpayFormUrl &&
        result.wayforpayFields
      ) {
        submitWayForPayForm(result.wayforpayFormUrl, result.wayforpayFields);
      } else {
        setCheckoutError(dict.creditsScreen.checkoutError);
      }
    } catch (e) {
      if (isUnauthorized(e)) setUnauthorized(true);
      else setCheckoutError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.creditsScreen.title}
        hint={dict.creditsScreen.hint}
        back={routes.plan()}
      />

      <Card className="mb-4 p-4">
        <div className="flex items-center gap-2 text-sm">
          <Coins size={16} className="shrink-0 text-accent" />
          <span className="text-silver-400">
            {dict.creditsScreen.balanceLabel}:
          </span>
          <span className="font-bold">{state?.credits.balance ?? 0}</span>
        </div>
      </Card>

      {unauthorized && (
        <Alert tone="info" className="mb-3">
          {dict.creditsScreen.unauthAlert}
        </Alert>
      )}
      {notice && (
        <Alert
          tone="success"
          className="mb-3"
          onDismiss={() => setNotice(null)}
        >
          {notice}
        </Alert>
      )}
      {checkoutError && (
        <Alert
          tone="error"
          className="mb-3"
          onDismiss={() => setCheckoutError(null)}
        >
          {checkoutError}
        </Alert>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size={26} />
        </div>
      )}
      {!loading && error ? <LoadError error={error} onRetry={reload} /> : null}

      {!loading && !error && data && (
        <div className="space-y-2">
          <p className="text-xs text-silver-400">
            {dict.creditsScreen.packsHint}
          </p>
          {data.creditPacks.map((pack) => (
            <Card key={pack.id} className="p-4">
              <p className="mb-3 text-sm font-semibold">{pack.title}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  block
                  size="sm"
                  icon={<Sparkles size={13} />}
                  loading={busy?.packId === pack.id && busy.method === 'STARS'}
                  disabled={busy !== null}
                  onClick={() => void buy(pack, 'STARS')}
                >
                  {dict.creditsScreen.starsButton} · {pack.stars} ⭐
                </Button>
                <Button
                  block
                  size="sm"
                  variant="outline"
                  icon={<CreditCard size={13} />}
                  loading={
                    busy?.packId === pack.id && busy.method === 'WAYFORPAY'
                  }
                  disabled={busy !== null}
                  onClick={() => void buy(pack, 'WAYFORPAY')}
                >
                  {dict.creditsScreen.wayforpayButton} · {wayforpayLabel(pack)}
                </Button>
              </div>
            </Card>
          ))}
          {/* Г-6.4 из аудита round4: экраны оплаты не содержали ни одной
              ссылки на оферту/условия — тот же паттерн, что у TermsGate. */}
          <p className="text-[11px] leading-relaxed text-silver-500 dark:text-silver-400">
            {dict.creditsScreen.legalNotePrefix}{' '}
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
        </div>
      )}
    </div>
  );
}
