import { claimStatus, isClaimId } from './claims';
import { fmt } from './format';
import { getDictionary } from './get-dictionary';
import type { Locale } from './i18n';
import { formatNumber, formatUsd, PLANS } from './plans';

/**
 * Вопросы FAQ локали — уже отфильтрованные реестром (`hidden` нет вовсе,
 * §3.0: «в FAQ — тексты только для live/soon») и с подставленными числами
 * тарифов из снимка (цены в словари не пишутся, §3.8).
 */
export interface FaqGroupView {
  title: string;
  items: Array<{ q: string; a: string; claim: string; soon: boolean }>;
}

export function priceVars(locale: Locale): Record<string, string> {
  const start = PLANS.plans.find((p) => p.id === 'start')!;
  const trial = PLANS.plans.find((p) => p.id === 'trial')!;
  return {
    startPrice: formatUsd(start.priceUsdMonthly, locale),
    startDialogs: formatNumber(start.dialogsPerMonth, locale),
    trialDays: String(trial.trialDays ?? 0),
    minOverage: formatUsd(PLANS.minOveragePerDialogUsd, locale),
  };
}

export function faqGroups(locale: Locale): FaqGroupView[] {
  const dict = getDictionary(locale);
  const vars = priceVars(locale);
  return dict.faq.groups
    .map((g) => ({
      title: g.title,
      items: g.items.flatMap((item) => {
        if (!isClaimId(item.claim)) throw new Error(`FAQ: неизвестное утверждение «${item.claim}»`);
        const status = claimStatus(item.claim);
        if (status === 'hidden') return [];
        return [{ q: fmt(item.q, vars), a: fmt(item.a, vars), claim: item.claim, soon: status === 'soon' }];
      }),
    }))
    .filter((g) => g.items.length > 0);
}
