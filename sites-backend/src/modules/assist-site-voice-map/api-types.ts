/**
 * Формы ответов голосовой карты «Сайта» (Э6-тер, ТЗ §5-кватер.13) — кабинет
 * (TMA) и панель редактора (iframe `we.`). Повторы — `assist/src/lib/voice-map-api.ts`
 * (сверка — `assist/scripts/voice-map-api.test.ts`) и
 * `widget/src/editor-panel/api.ts`.
 */
import type { MemoImportReport } from './memo-io';
import type {
  MapGateReport,
  MapOpIssue,
  VoiceMapContent,
  VoiceMapTarget,
  VoiceMapTemplate,
} from '../assist-ui-core/voice-map';
import type { UiPlanNote, UiPlanStep } from '../assist-ui-core/types';

export type VoiceMapErrorCode =
  | 'VOICE_MAP_CONFLICT'
  | 'VOICE_MAP_INVALID'
  | 'VOICE_MAP_HOST_REQUIRED'
  | 'VOICE_MAP_VERSION_NOT_FOUND'
  | 'VOICE_MAP_VERSION_STATE'
  | 'VOICE_MAP_HELD'
  | 'VOICE_MAP_PHRASE_TAKEN'
  | 'VOICE_MAP_IMPORT_KIND'
  | 'VOICE_MAP_IMPORT_FORMAT'
  | 'EDITOR_LINK_INVALID'
  | 'EDITOR_SESSION_EXPIRED'
  | 'EDITOR_PUBLISH_FORBIDDEN'
  | 'EDITOR_TRY_LIMIT'
  | 'EDITOR_PUBLISH_LIMIT'
  | 'EDITOR_BAD_REQUEST'
  // Э-С Ш3: «Снимок» и сверка карты браузерным воркером.
  | 'VOICE_MAP_SNAPSHOT_NOT_FOUND'
  | 'VOICE_MAP_CHECK_NOT_FOUND'
  // Заход 9: отчёт для разработчика по ссылке и голос «Сказать сейчас».
  | 'VOICE_MAP_DEV_REPORT_NOT_FOUND'
  | 'EDITOR_VOICE_UNAVAILABLE'
  | 'EDITOR_VOICE_BUDGET'
  | 'EDITOR_VOICE_AUDIO_INVALID'
  | 'EDITOR_VOICE_NOT_HEARD'
  | 'EDITOR_VOICE_UPSTREAM'
  // Заход 10 (№113): ИИ-синонимы цели в панели редактора.
  | 'EDITOR_SUGGEST_NEVER'
  | 'EDITOR_SUGGEST_LIMIT'
  | 'EDITOR_SUGGEST_BUDGET'
  | 'EDITOR_SUGGEST_UNAVAILABLE';

export interface VoiceMapVersionSummary {
  number: number;
  status: string;
  requestedVia: string;
  rollbackOf: number | null;
  createdAt: string;
  publishedAt: string | null;
  ok: boolean;
  problems: number;
  warnings: number;
  diff: { added: number; changed: number; removed: number };
}

export interface VoiceMapSummaryView {
  siteId: string;
  publishedVersion: number;
  draftRevision: number;
  targets: number;
  denylisted: number;
  templates: number;
  fragile: number;
  /** Ворота черновика «как если бы собрали сейчас». */
  draftGates: MapGateReport;
  /** Черновик отличается от опубликованной версии. */
  draftDirty: boolean;
  versions: VoiceMapVersionSummary[];
  activeSessions: number;
  /** Предложения шаблонов по страницам сайта (кластеры URL). */
  templateSuggestions: Array<{
    pathPattern: string;
    pages: number;
    samplePages: string[];
  }>;
  hosts: string[];
}

export interface VoiceMapDraftView {
  revision: number;
  publishedVersion: number;
  content: VoiceMapContent;
  gates: MapGateReport;
}

export interface VoiceMapPatchView {
  revision: number;
  applied: number;
}

/** 422 `VOICE_MAP_INVALID`: `error.details.errors` — `{ path: 'ops.N[.поле]', code: MapOpIssue['code'] }`. */
export type VoiceMapIssueCode = MapOpIssue['code'];

export interface VoiceMapVersionView extends VoiceMapVersionSummary {
  gateReport: MapGateReport | null;
  content: VoiceMapContent;
  diffKeys: { added: string[]; changed: string[]; removed: string[] };
}

export interface EditorLinkView {
  url: string;
  expiresAt: string;
  host: string;
}

export interface EditorSessionSummary {
  id: string;
  host: string;
  pagePath: string;
  memberId: string;
  createdAt: string;
  exchangedAt: string | null;
  expiresAt: string | null;
  lastSeenAt: string | null;
}

export interface VoiceMapImportView {
  revision: number;
  accepted: number;
  rejected: Array<{ index: number; key: string | null; code: string }>;
  signed: boolean;
  /**
   * (Э6-тер (к)) Мемо файла: созданные черновики (новые номера) и отказы с
   * причиной — опасный шаг (`never_step`, `two_pnr`, `const_in_pii`…),
   * формат, имя занято, лимит тарифа (`limit`).
   */
  memos: MemoImportReport;
}

export interface VoiceMapExportView {
  name: string;
  file: Record<string, unknown>;
}

// ── панель редактора (iframe `we.`) ──

export interface EditorSessionView {
  session: string;
  expiresAt: string;
  absoluteExpiresAt: string;
  pagePath: string;
  focusKey: string | null;
  host: string;
}

export interface EditorMapView {
  revision: number;
  publishedVersion: number;
  path: string;
  template: VoiceMapTemplate | null;
  templates: VoiceMapTemplate[];
  /** Цели, действующие на этой странице (весь сайт + шаблон + страница). */
  targets: VoiceMapTarget[];
  /** Все ключи карты — для проверки «ключ занят» в карточке. */
  keys: string[];
  gates: MapGateReport;
  hosts: string[];
}

export interface EditorTryView {
  heard: string;
  via: 'map' | 'direct' | 'model_needed' | 'none';
  key: string | null;
  phrase: string | null;
  steps: UiPlanStep[];
  notes: UiPlanNote[];
  /** Проверок «Сказать сейчас» осталось сегодня. */
  left: number;
}
