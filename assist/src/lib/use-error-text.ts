import { useKit } from '../kit';
import { useAssist } from './assist-context';
import { knowledgeErrorText } from './knowledge-errors';

/** Текст ошибки экранов знаний и песочницы (коды Э1 + коды кита). */
export function useErrorText(): (e: unknown) => string {
  const { dict } = useKit();
  const { appDict } = useAssist();
  return (e) => knowledgeErrorText(e, appDict, dict);
}
