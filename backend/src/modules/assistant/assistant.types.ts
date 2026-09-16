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

/** §5.4 — формат `actions` в ответе модели. `video` — этап 99
 * (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.8): в отличие от
 * остальных пяти (все ссылаются на СТАТИЧЕСКИЕ, известные заранее
 * каталоги), доступность видео ДИНАМИЧЕСКАЯ — зависит от того, что уже
 * отснято и одобрено в `TutorialVideoAsset`. */
export type AssistantActionKind =
  | 'step'
  | 'open-app'
  | 'plan'
  | 'faq'
  | 'legal'
  | 'video';

export interface AssistantAction {
  kind: AssistantActionKind;
  stepId?: number;
  planId?: string;
  faqIndex?: number;
  slug?: string;
  /** Только у kind:'video'. Модель называет ТОЛЬКО это поле — `url`/
   * `title` резолвятся и подставляются сервером (`AssistantService.
   * resolveVideoActions`), никогда не берутся из текста модели (см.
   * `actions.ts`'s `isValidAction`/`parseActions`). */
  subjectKey?: string;
  /** Подставляется сервером — см. `subjectKey`. */
  url?: string;
  /** Подставляется сервером — см. `subjectKey`. */
  title?: string;
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
