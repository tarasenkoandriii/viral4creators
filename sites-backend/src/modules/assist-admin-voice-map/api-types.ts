/**
 * Формы ответов голосовой карты «Админки» (заход 11, №117; ТЗ §5-кватер.9,
 * §5-кватер.13) — кабинет TMA (`…/admin-mode/voice-map/*`, только
 * assistAdmin: owner) и панель редактора в iframe `wa.`
 * (`/assist-admin/v1/editor/*`). Повтор — `assist/src/lib/admin-voice-map-api.ts`
 * (сверка — `assist/scripts/admin-voice-map-api.test.ts`). Вид версии и
 * её строки — общие с «Сайтом» (`assist-ui-core/voice-map-service-core.ts`).
 */
import type {
  MapGateReport,
  VoiceMapContent,
  VoiceMapTarget,
  VoiceMapTemplate,
} from '../assist-ui-core/voice-map';
import type {
  MapVersionDetailView,
  MapVersionSummaryView,
} from '../assist-ui-core/voice-map-service-core';
import type { UiPlanNote, UiPlanStep } from '../assist-ui-core/types';

export type AdminVoiceMapErrorCode =
  // Общие с картой «Сайта» (тот же смысл, тот же текст в TMA/панели).
  | 'VOICE_MAP_CONFLICT'
  | 'VOICE_MAP_INVALID'
  | 'VOICE_MAP_VERSION_NOT_FOUND'
  | 'VOICE_MAP_VERSION_STATE'
  | 'VOICE_MAP_HELD'
  | 'VOICE_MAP_PHRASE_TAKEN'
  | 'VOICE_MAP_IMPORT_KIND'
  | 'VOICE_MAP_IMPORT_FORMAT'
  // Только «Админка»: тариф Pro (В-55) и хост самой админки.
  | 'ADMIN_VOICE_MAP_PLAN_REQUIRED'
  | 'ADMIN_VOICE_MAP_HOST_REQUIRED'
  // Раунд исправлений захода 11: роль владельца у заказчика (карта ролей → owner).
  | 'ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED'
  | 'EDITOR_OWNER_REQUIRED'
  // Панель редактора `wa.` (те же коды, что у панели `we.`).
  | 'EDITOR_LINK_INVALID'
  | 'EDITOR_SESSION_EXPIRED'
  | 'EDITOR_PUBLISH_FORBIDDEN'
  | 'EDITOR_TRY_LIMIT'
  | 'EDITOR_PUBLISH_LIMIT'
  | 'EDITOR_BAD_REQUEST';

export type AdminVoiceMapVersionSummary = MapVersionSummaryView;
export type AdminVoiceMapVersionView = MapVersionDetailView;

export interface AdminVoiceMapSummaryView {
  siteId: string;
  publishedVersion: number;
  draftRevision: number;
  targets: number;
  denylisted: number;
  templates: number;
  fragile: number;
  /** Ворота черновика «как если бы собрали сейчас». */
  draftGates: MapGateReport;
  draftDirty: boolean;
  versions: AdminVoiceMapVersionSummary[];
  activeSessions: number;
  /** Подтверждённые хосты САМОЙ админки (там открывается редактор). */
  hosts: string[];
  /** Тариф даёт «Админка: действия» (Pro, В-55): без него — только чтение. */
  planAllows: boolean;
}

export interface AdminVoiceMapDraftView {
  revision: number;
  publishedVersion: number;
  content: VoiceMapContent;
  gates: MapGateReport;
}

export interface AdminVoiceMapPatchView {
  revision: number;
  applied: number;
}

export interface AdminEditorLinkView {
  url: string;
  expiresAt: string;
  host: string;
}

export interface AdminEditorSessionSummary {
  id: string;
  host: string;
  pagePath: string;
  memberId: string;
  /** `jwt:<sub>` сотрудника `wa.`, с чьей сессией обменяна ссылка. */
  employeeRef: string | null;
  createdAt: string;
  exchangedAt: string | null;
  expiresAt: string | null;
  lastSeenAt: string | null;
}

export interface AdminVoiceMapImportView {
  revision: number;
  accepted: number;
  rejected: Array<{ index: number; key: string | null; code: string }>;
  signed: boolean;
}

export interface AdminVoiceMapExportView {
  name: string;
  file: Record<string, unknown>;
}

// ── панель редактора (iframe `wa.`) ──

export interface AdminEditorSessionView {
  session: string;
  expiresAt: string;
  absoluteExpiresAt: string;
  pagePath: string;
  focusKey: string | null;
  host: string;
  /** Контур карты — панель `wa.` рисует ту же карточку с этим `kind`. */
  kind: 'admin';
}

export interface AdminEditorMapView {
  revision: number;
  publishedVersion: number;
  path: string;
  template: VoiceMapTemplate | null;
  templates: VoiceMapTemplate[];
  targets: VoiceMapTarget[];
  keys: string[];
  gates: MapGateReport;
  hosts: string[];
  /**
   * Зоны владельца из правил голосового управления «Админки» (как у боевого
   * снимка `admin-act.js`): пикер снимает «Сказать сейчас» с ними (аудит P2-2).
   */
  denySelectors: string[];
  allowSelectors: string[];
}

export interface AdminEditorTryView {
  heard: string;
  via: 'map' | 'direct' | 'model_needed' | 'none';
  key: string | null;
  phrase: string | null;
  steps: UiPlanStep[];
  notes: UiPlanNote[];
  left: number;
}
