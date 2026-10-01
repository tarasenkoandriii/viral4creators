import { useKit } from '../kit';
import { useAssist } from './assist-context';
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
