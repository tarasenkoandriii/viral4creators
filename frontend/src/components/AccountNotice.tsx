/**
 * AccountNotice — состояние аккаунта, о котором пользователь должен знать
 * ЗАРАНЕЕ, а не в момент нажатия кнопки (ТЗ §25.3, §26.4, этап 32).
 *
 * До этого этапа заблокированный пользователь узнавал о блокировке из
 * красной ошибки после того, как выбрал референс и дождался начала
 * разбора. Это худший момент для такой новости: человек уже потратил
 * время и не понимает, что произошло. Уведомление показывается сверху,
 * спокойным тоном, и говорит, что именно осталось доступным.
 *
 * Сумм здесь нет намеренно: наружу приходят только признаки
 * (`exhausted` / `nearlyExhausted`), потому что «вы потратили $1.20 из
 * $2.00» — это наша бухгалтерия, а не ответ на вопрос пользователя.
 *
 * Зелёная плашка тестового доступа (TODO §III п.37) живёт здесь же и по
 * той же причине: человек должен знать своё состояние заранее и на
 * любом экране. Без неё тестировщик не отличает бесплатный проход от
 * сломанного биллинга — это прямо записано в задаче как отдельный
 * пункт.
 */

import { Alert } from './ui';
import { usePlanState } from '../lib/plan-context';
import { useI18n } from '../lib/i18n-context';
import { showsTestAccess, testScenarioLabels } from '../lib/test-access';

export function AccountNotice() {
  const state = usePlanState();
  const { dict } = useI18n();
  if (!state) return null;

  const t = dict.accountNotice.testAccess;
  const scenarios = testScenarioLabels(
    state.testAccess?.freeScenarios ?? [],
    t.scenarios
  );

  /**
   * Блокировка отменяет всё остальное, включая благодарность.
   * Заблокированному тестировщику ничего не доступно, и зелёная плашка
   * «спасибо, проходите бесплатно» над красным запретом — издевательство
   * и дезинформация одновременно.
   */
  if (state.blocked.isBlocked) {
    return (
      <Alert tone="error" title={dict.accountNotice.blockedTitle}>
        <span>
          {state.blocked.reason
            ? dict.accountNotice.blockedReason.replace(
                '{{reason}}',
                state.blocked.reason
              )
            : dict.accountNotice.blockedContactSupport}{' '}
          {dict.accountNotice.blockedBody}
        </span>
      </Alert>
    );
  }

  const testBanner = showsTestAccess(state.testAccess ?? null, t.scenarios) ? (
    <Alert tone="success" title={t.title}>
      <span>{t.body}</span>
      <div className="mt-2">
        <span className="font-medium">{t.scenariosLabel}:</span>
        <ul className="mt-1 list-disc pl-5">
          {scenarios.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </div>
      {/* Про потолок — в самой плашке: «бесплатно» без этой строчки
          обещает безлимит, которого нет, и первый же отказ выглядит
          обманом. */}
      <div className="mt-2 opacity-80">{t.capNote}</div>
    </Alert>
  ) : null;

  const budgetNotice = state.budget.exhausted ? (
    <Alert tone="warning" title={dict.accountNotice.exhaustedTitle}>
      <span>{dict.accountNotice.exhaustedBody}</span>
    </Alert>
  ) : state.budget.nearlyExhausted ? (
    <Alert tone="info">
      <span>{dict.accountNotice.nearlyExhaustedBody}</span>
    </Alert>
  ) : null;

  if (!testBanner && !budgetNotice) return null;

  // Благодарность сверху, предупреждение о потолке под ней: сначала
  // «почему вам сейчас бесплатно», потом «и где у этого край».
  return (
    <div className="space-y-3">
      {testBanner}
      {budgetNotice}
    </div>
  );
}
