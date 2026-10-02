import { useKit } from '../kit';
import { useAssist } from './assist-context';
import { e3ErrorNotice, e3ErrorText } from './e3-errors';
import { knowledgeErrorText } from './knowledge-errors';
import { setupErrorText } from './setup-errors';

/** Текст ошибки экранов знаний и песочницы (коды Э1 + коды кита). */
export function useErrorText(): (e: unknown) => string {
  const { dict } = useKit();
  const { appDict } = useAssist();
  return (e) => knowledgeErrorText(e, appDict, dict);
}

/** Текст ошибки экранов виджета, персоны и мастера (коды Э2 + Э1 + кита). */
export function useSetupErrorText(): (e: unknown) => string {
  const { dict } = useKit();
  const { appDict } = useAssist();
  return (e) => setupErrorText(e, appDict, dict);
}

/** Текст ошибки экранов Э3 (коды H/L/A/T + Э2 + Э1 + кита). */
export function useE3ErrorText(): (e: unknown) => string {
  const { dict } = useKit();
  const { appDict } = useAssist();
  return (e) => e3ErrorText(e, appDict, dict);
}

/** Ошибка формы Э3: текст + строки `details.errors[]` (для NoticeBar). */
export function useE3ErrorNotice(): (
  e: unknown
) => ReturnType<typeof e3ErrorNotice> {
  const { dict } = useKit();
  const { appDict } = useAssist();
  return (e) => e3ErrorNotice(e, appDict, dict);
}
