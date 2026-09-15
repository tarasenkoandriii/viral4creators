/**
 * Общие типы ИИ-консультанта на лендинге
 * (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md).
 */
import { SupportedLocale } from '../../common/locale';

export type AssistantPage = 'home' | 'how-it-works';

export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** §5.4 — формат `actions` в ответе модели. */
export type AssistantActionKind =
  | 'step'
  | 'open-app'
  | 'plan'
  | 'faq'
  | 'legal';

export interface AssistantAction {
  kind: AssistantActionKind;
  stepId?: number;
  planId?: string;
  faqIndex?: number;
  slug?: string;
}

export interface AssistantChatRequest {
  locale: SupportedLocale;
  stepId?: number;
  page: AssistantPage;
  messages: AssistantChatMessage[];
  /** 'user' — обычное открытие; 'proactive' — по клику на сигнал (§6.6, §10). */
  triggeredBy?: 'user' | 'proactive';
}

export type AssistantErrorCode =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'disabled'
  | 'upstream';

export interface AssistantUsageSummary {
  in: number;
  out: number;
  cached: number;
}
