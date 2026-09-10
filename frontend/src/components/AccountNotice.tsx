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
 */

import { Alert } from './ui';
import { usePlanState } from '../lib/plan-context';
import { useI18n } from '../lib/i18n-context';

export function AccountNotice() {
  const state = usePlanState();
  const { dict } = useI18n();
  if (!state) return null;

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

  if (state.budget.exhausted) {
    return (
      <Alert tone="warning" title={dict.accountNotice.exhaustedTitle}>
        <span>{dict.accountNotice.exhaustedBody}</span>
      </Alert>
    );
  }

  if (state.budget.nearlyExhausted) {
    return (
      <Alert tone="info">
        <span>{dict.accountNotice.nearlyExhaustedBody}</span>
      </Alert>
    );
  }

  return null;
}
