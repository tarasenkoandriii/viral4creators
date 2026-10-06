/**
 * Голосовая карта сайта — визуальный редактор голосового управления
 * (Э6-тер, ТЗ помощника §5-кватер; Р-51…Р-54, решения Э6-тер Р-73…Р-82) —
 * ЧИСТАЯ часть без базы (правило графа `ui-core-no-db`): форма карты,
 * строгий разбор дескриптора от пикера (данные НЕДОВЕРЕННЫЕ — окно пикера
 * делит любой скрипт страницы), устойчивость, расчёт риска КОДОМ, операции
 * черновика, ворота публикации, шаблоны страниц, разрешение целей по
 * снимку в бою, прямой путь по карте, экспорт/импорт.
 *
 * Главный принцип (Р-51): карта — подсказка для поиска цели, а не
 * разрешение. Риск шага в бою считает код по живой цели; риск карты —
 * только НИЖНЯЯ граница (итог = max). Владелец может только ужесточить
 * (`riskOwner ≥ riskComputed`, иначе 422 `risk_lowering_forbidden`);
 * цель класса «никогда» может быть только в denylist (без имён и
 * синонимов). Имена и синонимы — доверенный, но проверяемый ввод (§5-кватер.11
 * п.6): те же правила, что у текстов мемо (`memoTextProblem`).
 */
import {
  candidateStability,
  isGeneratedToken,
  type UiSelectorCandidate,
  type UiStability,
} from '../site-core/ui-map/ui-map-model';
import { STANDARD_UNDO_PAIRS } from './decisions';
import { MEMO_LANGS, memoTextProblem, phraseNorm, type MemoLang } from './memo';
import { normText, overlaps } from './normalize';
import { judgeStep, type RawStep, type TargetFacts } from './plan-checks';
import { defaultVoiceControlRules, pathMatches, PATH_MASK_RE } from './rules';
import { ASSIST_ID_RE, cleanText, maskLabel, maskPagePath } from './snapshot';
import {
  UI_GESTURES,
  UI_ROLES,
  type UiGesture,
  type UiRisk,
  type UiRole,
  type UiSnapElement,
  type UiSnapshot,
} from './types';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const VOICE_MAP_LANGS = MEMO_LANGS;
export type VoiceMapLang = MemoLang;

export const VOICE_MAP_LIMITS = {
  nameChars: 60,
  synonymChars: 40,
  synonymsPerLang: 20,
  /** ≤ 500 целей на карту (§5-кватер.11 п.6, ПРОВЕРИТЬ на крупных каталогах). */
  targets: 500,
  templates: 50,
  samplePages: 5,
  /** Образцов устойчивости на цель (пикер отмечает «нашёл/не нашёл/несколько»). */
  samplesPerTarget: 5,
  opsPerPatch: 50,
  /** Ключ цели — `[a-z0-9-]{2,40}` (фрагмент разметки `data-assist-id`). */
  keyRe: /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
  /** Версий карты — последние 20; метаданные и журнал — 180 дней. */
  versionsKept: 20,
  historyMs: 180 * DAY,
  /** Ссылка редактора — 10 мин на открытие, один обмен. */
  linkTtlMs: 10 * MINUTE,
  /** Сессия редактора — 30 мин скользящих, ≤ 4 ч абсолютных. */
  sessionIdleMs: 30 * MINUTE,
  sessionAbsMs: 4 * 60 * MINUTE,
  /** Ворота: > 30% целей не найдены на образцах — `held`. */
  notFoundHeldShare: 0.3,
  /** «Сказать сейчас»: проверок на сайт в сутки (§5-кватер.6, ПРОВЕРИТЬ). */
  tryPerDay: 100,
  /**
   * Запрос публикации из сессии редактора (аудит Э6-тер (2)): каждый —
   * версия и сообщение в бот, поэтому не чаще 1 в минуту на сессию и не
   * больше 10 в сутки (UTC) на сайт; TMA — без этих потолков.
   */
  publishRequestsPerDay: 10,
  publishRequestIntervalMs: MINUTE,
  textChars: 80,
  /** Отклонённое предложение той же пары не показывается 30 дней. */
  suggestionMuteMs: 30 * DAY,
} as const;

/** Семантический тип цели — закрытый список (§5-кватер.4). */
export const SEMANTIC_TYPES = [
  'nav',
  'search',
  'filter',
  'sort',
  'quantity',
  'option',
  'add-to-cart',
  'favorite',
  'compare',
  'open',
  'close',
  'form-field',
  'submit',
  'other',
] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

/** Риск карты: «можно сразу» / «с подтверждением» / «никогда». */
export const MAP_RISKS = ['now', 'confirm', 'never'] as const;
export type MapRisk = (typeof MAP_RISKS)[number];
const MAP_RANK: Record<MapRisk, number> = { now: 0, confirm: 1, never: 2 };

export function mapRiskMax(a: MapRisk, b: MapRisk | null | undefined): MapRisk {
  return b && MAP_RANK[b] > MAP_RANK[a] ? b : a;
}
export function mapRiskBelow(a: MapRisk, b: MapRisk): boolean {
  return MAP_RANK[a] < MAP_RANK[b];
}
/** Риск карты → нижняя граница риска шага в бою (Р-51). */
export function mapFloor(r: MapRisk): UiRisk {
  return r === 'now' ? 'auto' : r === 'confirm' ? 'confirm' : 'never';
}

/** Привязка цели: эта страница / шаблон страниц / весь сайт. */
export const MAP_SCOPES = ['page', 'template', 'site'] as const;
export type MapScope = (typeof MAP_SCOPES)[number];

export const SYNONYM_ORIGINS = [
  'owner',
  'suggested',
  'queue',
  'template',
  'import',
] as const;
export type SynonymOrigin = (typeof SYNONYM_ORIGINS)[number];

export const TARGET_ORIGINS = [
  'owner',
  'template',
  'suggestion',
  'import',
] as const;
export type TargetOrigin = (typeof TARGET_ORIGINS)[number];

export const MAP_CHANGE_SOURCES = [
  'editor',
  'tma',
  'import',
  'template',
  'suggestion',
  'rollback',
] as const;
export type MapChangeSource = (typeof MAP_CHANGE_SOURCES)[number];

export const MAP_VERSION_STATUSES = [
  'building',
  'checking',
  'published',
  'held',
  'discarded',
] as const;
export type MapVersionStatus = (typeof MAP_VERSION_STATUSES)[number];

// ── дескриптор (то, что прислал пикер) ───────────────────────────────────

const TAGS = ['a', 'button', 'input', 'select', 'textarea', 'other'] as const;
type Tag = (typeof TAGS)[number];
const LANDMARKS = [
  'main',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'section',
  'dialog',
] as const;

/**
 * Дескриптор цели (§5-кватер.4 «Привязка»): набор признаков, разрешаемый
 * в порядке надёжности — `data-assist-id` → тестовый атрибут/id → роль +
 * видимый текст + якорь → позиция. Значений полей, HTML и скриншотов нет
 * (§5-кватер.11 п.7): подпись маскирована ещё в пикере и ещё раз здесь.
 */
export interface VoiceMapDescriptor {
  tag: Tag;
  role: UiRole | null;
  /** Видимый текст (маска ПД), ≤ 80. */
  text: string;
  /** Доступное имя, если расходится с видимым (для команд не засчитывается). */
  hiddenLabel: string | null;
  assistId: string | null;
  /** Значение `data-testid`/`data-test`. */
  testId: string | null;
  /** Атрибут `id` (если не похож на сгенерированный — кандидат «надёжно»). */
  elId: string | null;
  /** Путь ссылки (без query) и её хост; хост не из хостов сайта — «никогда». */
  hrefPath: string | null;
  hrefHost: string | null;
  offHost: boolean;
  heading: string | null;
  landmark: (typeof LANDMARKS)[number] | null;
  formName: string | null;
  inputType: string | null;
  submit: boolean;
  inForm: boolean;
  pd: boolean;
  toggle: boolean;
  gesture: UiGesture | null;
  /** `data-assist="never"` на элементе или предке. */
  neverAttr: boolean;
  confirmZone: boolean;
  /** Кликабельный `div` без роли / `contenteditable` / в закрытом shadow-корне. */
  clickableDiv: boolean;
  editable: boolean;
  closedShadow: boolean;
  /** Лучший кандидат единственен на странице снятия (пикер проверил). */
  unique: boolean;
  /** Позиционный css-путь (запасной, хрупкий). */
  css: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const CSS_RE = /^[A-Za-z0-9\s#.:()[\]="'_*^$|~+>,-]{1,200}$/;
const INPUT_TYPE_RE = /^[a-z-]{1,20}$/;
const SENSITIVE_INPUT = new Set(['password', 'file', 'hidden']);

/**
 * Строгий разбор дескриптора от пикера: мусор — null; подписи — маска ПД;
 * поля пароля/файла — отказ (их нет и в снимке, §5-бис.5).
 */
export function parseDescriptor(raw: unknown): VoiceMapDescriptor | null {
  if (!isObj(raw)) return null;
  const tag = (TAGS as readonly string[]).includes(raw.tag as string)
    ? (raw.tag as Tag)
    : 'other';
  const role =
    typeof raw.role === 'string' &&
    (UI_ROLES as readonly string[]).includes(raw.role)
      ? (raw.role as UiRole)
      : null;
  const inputType =
    typeof raw.inputType === 'string' && INPUT_TYPE_RE.test(raw.inputType)
      ? raw.inputType
      : null;
  if (inputType && SENSITIVE_INPUT.has(inputType)) return null;
  const text = maskLabel(cleanText(raw.text, VOICE_MAP_LIMITS.textChars) ?? '');
  const hiddenRaw = cleanText(raw.hiddenLabel, VOICE_MAP_LIMITS.textChars);
  const hiddenLabel = hiddenRaw ? maskLabel(hiddenRaw) : null;
  const tok = (v: unknown) =>
    typeof v === 'string' && TOKEN_RE.test(v) ? v : null;
  const assistId =
    typeof raw.assistId === 'string' && ASSIST_ID_RE.test(raw.assistId)
      ? raw.assistId
      : null;
  const hrefPath =
    typeof raw.hrefPath === 'string' &&
    raw.hrefPath.length <= 300 &&
    PATH_MASK_RE.test(raw.hrefPath) &&
    !raw.hrefPath.includes('*')
      ? // ПД в пути ссылки (`/u/ivan@example.com`, номер заказа) — маской,
        // как у подписи: дескриптор уходит в черновик, версии и экспорт.
        maskPagePath(raw.hrefPath)
      : null;
  const landmark = (LANDMARKS as readonly string[]).includes(
    raw.landmark as string,
  )
    ? (raw.landmark as VoiceMapDescriptor['landmark'])
    : null;
  const gesture =
    typeof raw.gesture === 'string' &&
    (UI_GESTURES as readonly string[]).includes(raw.gesture)
      ? (raw.gesture as UiGesture)
      : null;
  const css =
    typeof raw.css === 'string' && CSS_RE.test(raw.css) ? raw.css : null;
  const d: VoiceMapDescriptor = {
    tag,
    role,
    text,
    hiddenLabel: hiddenLabel && hiddenLabel !== text ? hiddenLabel : null,
    assistId,
    testId: tok(raw.testId),
    elId: tok(raw.elId),
    hrefPath,
    hrefHost:
      hrefPath &&
      typeof raw.hrefHost === 'string' &&
      /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(raw.hrefHost)
        ? raw.hrefHost
        : null,
    offHost: raw.offHost === true,
    heading: (() => {
      const h = cleanText(raw.heading, VOICE_MAP_LIMITS.textChars);
      return h ? maskLabel(h) : null;
    })(),
    landmark,
    formName: tok(raw.formName),
    inputType,
    submit: raw.submit === true,
    inForm: raw.inForm === true,
    pd: raw.pd === true,
    toggle: raw.toggle === true,
    gesture,
    neverAttr: raw.neverAttr === true,
    confirmZone: raw.confirmZone === true,
    clickableDiv: raw.clickableDiv === true,
    editable: raw.editable === true,
    closedShadow: raw.closedShadow === true,
    unique: raw.unique === true,
    css,
  };
  // Совсем без признаков — нечего искать (ни разметки, ни текста, ни пути).
  if (
    !d.assistId &&
    !d.testId &&
    !d.elId &&
    !d.text &&
    !d.hiddenLabel &&
    !d.hrefPath &&
    !d.css
  )
    return null;
  return d;
}

const quote = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Кандидаты селектора в форме Ш4 (`site_ui_elements`) — лучший первым. */
export function descriptorCandidates(
  d: VoiceMapDescriptor,
): UiSelectorCandidate[] {
  const out: UiSelectorCandidate[] = [];
  if (d.assistId)
    out.push({
      kind: 'assist-id',
      selector: `[data-assist-id="${quote(d.assistId)}"]`,
    });
  if (d.testId)
    out.push({
      kind: 'test-id',
      selector: `${d.tag === 'other' ? 'div' : d.tag}[data-testid="${quote(d.testId)}"]`,
    });
  if (d.elId) out.push({ kind: 'id', selector: `#${d.elId}` });
  if (d.role && d.text)
    out.push({ kind: 'role-name', role: d.role, name: d.text });
  if (d.text) out.push({ kind: 'text', name: d.text });
  if (d.css) out.push({ kind: 'css', selector: d.css });
  return out.slice(0, 5);
}

/** Образец устойчивости: на странице шаблона цель нашлась 0 / 1 / N раз. */
export interface StabilitySample {
  path: string;
  found: number;
}

/**
 * Оценка устойчивости (§5-кватер.4 «Проверка устойчивости»): разметка —
 * `strong`; тестовый атрибут/несгенерированный id и единственный —
 * `strong`; роль + видимый текст, единственный, без цены/чисел — `medium`;
 * иначе `fragile`. Образцы шаблона: не нашлась/нашлась несколько хоть на
 * одном — `fragile` (список — в отчёте).
 */
export function descriptorStability(
  d: VoiceMapDescriptor,
  samples: readonly StabilitySample[] = [],
): UiStability {
  if (samples.some((s) => s.found !== 1)) return 'fragile';
  if (d.assistId) return 'strong';
  if (!d.unique) return 'fragile';
  if (d.testId) return 'strong';
  if (d.elId && !isGeneratedToken(d.elId)) return 'strong';
  if (d.role && d.text) {
    const c = candidateStability({
      kind: 'role-name',
      role: d.role,
      name: d.text,
    });
    return c === 'strong' ? 'medium' : c;
  }
  if (d.hrefPath && d.tag === 'a') return 'medium';
  return 'fragile';
}

// ── риск: расчёт кода, «только вверх» ────────────────────────────────────

/** Факты о цели из дескриптора — для тех же правил, что в бою. */
export function descriptorFacts(
  d: VoiceMapDescriptor,
  hosts: readonly string[],
): TargetFacts {
  return {
    text: d.text,
    hiddenLabel: d.hiddenLabel,
    assistId: d.assistId,
    role: d.role,
    tag: d.tag,
    href: d.offHost
      ? 'https://offhost.invalid/'
      : d.hrefPath
        ? `https://${d.hrefHost ?? hosts[0] ?? 'offhost.invalid'}${d.hrefPath}`
        : null,
    submit: d.submit,
    inForm: d.inForm,
    confirmZone: d.confirmZone,
    pd: d.pd,
    toggle: d.toggle,
    gesture: d.gesture,
    inputType: d.inputType,
    disabled: false,
    heading: d.heading,
    options: [],
  };
}

export type RiskReason =
  | 'never_attr'
  | 'danger'
  | 'payment'
  | 'sensitive_field'
  | 'offhost'
  | 'gesture'
  | 'unsupported'
  | 'fragile'
  | 'submit'
  | 'confirm_default'
  | null;

/**
 * Риск, который КОД даёт цели (§5-кватер.4 «Риск»): стоп-лист по видимому
 * тексту, словарь действий, признаки поля, цель ссылки, `data-assist="never"`,
 * жест — те же `judgeStep`, что в бою, для команды, называющей цель её
 * видимым текстом (самый мягкий честный случай); хрупкая цель не бывает
 * «сразу». Карта может только поднять этот риск (владелец, тип).
 */
export function computeTargetRisk(
  d: VoiceMapDescriptor,
  hosts: readonly string[],
  stability: UiStability = descriptorStability(d),
): { risk: MapRisk; reason: RiskReason } {
  if (d.neverAttr) return { risk: 'never', reason: 'never_attr' };
  if (d.editable || d.closedShadow)
    return { risk: 'never', reason: 'unsupported' };
  const facts = descriptorFacts(d, hosts);
  const rules = defaultVoiceControlRules();
  const name = d.text || (d.assistId ?? '');
  const field =
    d.tag === 'textarea' ||
    (d.tag === 'input' &&
      d.role !== 'checkbox' &&
      d.role !== 'radio' &&
      d.role !== 'switch' &&
      d.inputType !== 'submit' &&
      d.inputType !== 'button');
  const kind =
    d.tag === 'select' || d.role === 'combobox'
      ? 'select'
      : d.role === 'checkbox' || d.role === 'radio' || d.role === 'switch'
        ? 'check'
        : field || d.role === 'textbox' || d.role === 'searchbox'
          ? 'fill'
          : 'click';
  const value = kind === 'fill' || kind === 'select' ? 'v4cprobe' : null;
  const j = judgeStep(kind, facts, value, {
    transcript: `${name} v4cprobe`,
    rules,
    hosts: [...hosts],
    pagePath: null,
    state: 'on',
  });
  if (j.risk === null) {
    const r = j.reason;
    return {
      risk: 'never',
      reason:
        r === 'sensitive_field' || r === 'payment' || r === 'danger'
          ? r
          : 'unsupported',
    };
  }
  if (j.risk === 'never')
    return {
      risk: 'never',
      reason: j.reason === 'payment' ? 'payment' : 'danger',
    };
  if (j.risk === 'manual')
    return {
      risk: 'never',
      reason: j.reason === 'gesture' ? 'gesture' : 'offhost',
    };
  if (j.risk === 'confirm')
    return {
      risk: 'confirm',
      reason: d.submit ? 'submit' : 'confirm_default',
    };
  if (stability === 'fragile') return { risk: 'confirm', reason: 'fragile' };
  return { risk: 'now', reason: null };
}

/** Нижняя граница от семантического типа (тип — только поднимает). */
export function typeFloor(t: SemanticType | null): MapRisk {
  return t === 'submit' ? 'confirm' : 'now';
}

// ── цель, шаблон, содержимое ─────────────────────────────────────────────

export interface MapSynonym {
  text: string;
  origin: SynonymOrigin;
}

/** Объявленная компенсация «Как отменить» (Э6-тер (и), §5-бис.15 п.6). */
export interface MapUndo {
  /** `data-assist-id` обратного элемента (в строке того же товара). */
  assistId: string;
  /** Страница отмены на том же хосте (`data-assist-undo-at`). */
  at: string | null;
}

export interface VoiceMapTarget {
  key: string;
  scope: MapScope;
  templateId: string | null;
  pagePath: string | null;
  descriptor: VoiceMapDescriptor;
  stability: UiStability;
  samples: StabilitySample[];
  names: Partial<Record<VoiceMapLang, string>>;
  synonyms: Partial<Record<VoiceMapLang, MapSynonym[]>>;
  semanticType: SemanticType | null;
  riskComputed: MapRisk;
  riskReason: RiskReason;
  riskOwner: MapRisk | null;
  denylisted: boolean;
  control: boolean;
  undo: MapUndo | null;
  origin: TargetOrigin;
  status: 'active' | 'removed';
}

export interface VoiceMapTemplate {
  id: string;
  name: string;
  pathPattern: string;
  samplePages: string[];
  status: 'suggested' | 'active' | 'removed';
}

export interface VoiceMapContent {
  schemaVersion: 1;
  targets: VoiceMapTarget[];
  templates: VoiceMapTemplate[];
  terms: string[];
}

export function emptyVoiceMap(): VoiceMapContent {
  return { schemaVersion: 1, targets: [], templates: [], terms: [] };
}

/** Итоговый риск цели карты: max(код, владелец, тип). */
export function effectiveRisk(t: VoiceMapTarget): MapRisk {
  return mapRiskMax(
    mapRiskMax(t.riskComputed, t.riskOwner),
    typeFloor(t.semanticType),
  );
}

/** Все фразы цели (имена и принятые синонимы) с нормой. */
export function targetPhrases(
  t: VoiceMapTarget,
  opts: { withSuggested?: boolean } = {},
): Array<{ lang: VoiceMapLang; text: string; norm: string; kind: string }> {
  const out: Array<{
    lang: VoiceMapLang;
    text: string;
    norm: string;
    kind: string;
  }> = [];
  for (const lang of VOICE_MAP_LANGS) {
    const n = t.names[lang];
    if (n)
      out.push({ lang, text: n, norm: phraseNorm(n), kind: 'target-name' });
    for (const s of t.synonyms[lang] ?? []) {
      if (s.origin === 'suggested' && !opts.withSuggested) continue;
      out.push({
        lang,
        text: s.text,
        norm: phraseNorm(s.text),
        kind: 'target-synonym',
      });
    }
  }
  return out.filter((p) => p.norm);
}

/** Строгий разбор содержимого (черновик/версия из базы — тоже данные). */
export function parseVoiceMapContent(raw: unknown): VoiceMapContent {
  const out = emptyVoiceMap();
  if (!isObj(raw)) return out;
  if (Array.isArray(raw.templates))
    for (const t of raw.templates.slice(0, VOICE_MAP_LIMITS.templates)) {
      if (!isObj(t)) continue;
      const tpl = cleanTemplate(t);
      if (tpl && typeof t.id === 'string' && /^[a-z0-9-]{1,40}$/.test(t.id))
        out.templates.push({
          ...tpl,
          id: t.id,
          status:
            t.status === 'suggested' || t.status === 'removed'
              ? t.status
              : 'active',
        });
    }
  if (Array.isArray(raw.targets))
    for (const t of raw.targets.slice(0, VOICE_MAP_LIMITS.targets)) {
      const parsed = parseTarget(t, out.templates);
      if (parsed) out.targets.push(parsed);
    }
  if (Array.isArray(raw.terms))
    out.terms = raw.terms
      .filter(
        (x): x is string =>
          typeof x === 'string' &&
          memoTextProblem(x, VOICE_MAP_LIMITS.synonymChars) === null,
      )
      .slice(0, 100);
  return out;
}

function parseTarget(
  raw: unknown,
  templates: readonly VoiceMapTemplate[],
): VoiceMapTarget | null {
  if (!isObj(raw)) return null;
  if (typeof raw.key !== 'string' || !VOICE_MAP_LIMITS.keyRe.test(raw.key))
    return null;
  const d = parseDescriptor(raw.descriptor);
  if (!d) return null;
  const scope = (MAP_SCOPES as readonly string[]).includes(raw.scope as string)
    ? (raw.scope as MapScope)
    : 'page';
  const templateId =
    scope === 'template' &&
    typeof raw.templateId === 'string' &&
    templates.some((t) => t.id === raw.templateId)
      ? raw.templateId
      : null;
  if (scope === 'template' && !templateId) return null;
  const pagePath =
    scope === 'page' &&
    typeof raw.pagePath === 'string' &&
    PATH_MASK_RE.test(raw.pagePath) &&
    !raw.pagePath.includes('*')
      ? raw.pagePath
      : null;
  if (scope === 'page' && !pagePath) return null;
  const samples = Array.isArray(raw.samples)
    ? raw.samples
        .filter(
          (s): s is StabilitySample =>
            isObj(s) &&
            typeof s.path === 'string' &&
            PATH_MASK_RE.test(s.path) &&
            typeof s.found === 'number' &&
            Number.isInteger(s.found) &&
            s.found >= 0 &&
            s.found <= 99,
        )
        .slice(0, VOICE_MAP_LIMITS.samplesPerTarget)
        .map((s) => ({ path: s.path, found: s.found }))
    : [];
  const names: Partial<Record<VoiceMapLang, string>> = {};
  const synonyms: Partial<Record<VoiceMapLang, MapSynonym[]>> = {};
  if (isObj(raw.names))
    for (const l of VOICE_MAP_LANGS) {
      const n = raw.names[l];
      if (
        typeof n === 'string' &&
        memoTextProblem(n, VOICE_MAP_LIMITS.nameChars) === null
      )
        names[l] = n.trim();
    }
  if (isObj(raw.synonyms))
    for (const l of VOICE_MAP_LANGS) {
      const list = raw.synonyms[l];
      if (!Array.isArray(list)) continue;
      const clean: MapSynonym[] = [];
      for (const s of list.slice(0, VOICE_MAP_LIMITS.synonymsPerLang)) {
        if (!isObj(s) || typeof s.text !== 'string') continue;
        if (memoTextProblem(s.text, VOICE_MAP_LIMITS.synonymChars) !== null)
          continue;
        const origin = (SYNONYM_ORIGINS as readonly string[]).includes(
          s.origin as string,
        )
          ? (s.origin as SynonymOrigin)
          : 'owner';
        clean.push({ text: s.text.trim(), origin });
      }
      if (clean.length) synonyms[l] = clean;
    }
  const stability = descriptorStability(d, samples);
  // Без хостов сайта ссылка считается чужой («никогда») — консервативно;
  // операции черновика пересчитывают риск с настоящими хостами.
  const computed = computeTargetRisk(d, [], stability);
  const riskOwner = (MAP_RISKS as readonly string[]).includes(
    raw.riskOwner as string,
  )
    ? (raw.riskOwner as MapRisk)
    : null;
  // Записанный риск кода (посчитан операцией с хостами сайта) — если есть;
  // но не ниже пересчёта по самому дескриптору, кроме ссылок (без хостов
  // сайта ссылка здесь выглядит чужой).
  const stored = (MAP_RISKS as readonly string[]).includes(
    raw.riskComputed as string,
  )
    ? (raw.riskComputed as MapRisk)
    : null;
  const riskComputed = stored
    ? d.hrefPath && computed.reason === 'offhost'
      ? stored
      : mapRiskMax(computed.risk, stored)
    : computed.risk;
  return {
    key: raw.key,
    scope,
    templateId,
    pagePath,
    descriptor: d,
    stability,
    samples,
    names,
    synonyms,
    semanticType: (SEMANTIC_TYPES as readonly string[]).includes(
      raw.semanticType as string,
    )
      ? (raw.semanticType as SemanticType)
      : null,
    riskComputed,
    riskReason: riskComputed === computed.risk ? computed.reason : null,
    riskOwner,
    denylisted: raw.denylisted === true,
    control: raw.control === true,
    undo: parseUndo(raw.undo),
    origin: (TARGET_ORIGINS as readonly string[]).includes(raw.origin as string)
      ? (raw.origin as TargetOrigin)
      : 'owner',
    status: raw.status === 'removed' ? 'removed' : 'active',
  };
}

function parseUndo(raw: unknown): MapUndo | null {
  if (!isObj(raw)) return null;
  if (typeof raw.assistId !== 'string' || !ASSIST_ID_RE.test(raw.assistId))
    return null;
  const at =
    typeof raw.at === 'string' &&
    PATH_MASK_RE.test(raw.at) &&
    !raw.at.includes('*') &&
    raw.at.length <= 200
      ? raw.at
      : null;
  return { assistId: raw.assistId, at };
}

function cleanTemplate(
  raw: Record<string, unknown>,
): Omit<VoiceMapTemplate, 'id' | 'status'> | null {
  if (
    typeof raw.name !== 'string' ||
    memoTextProblem(raw.name, VOICE_MAP_LIMITS.nameChars) !== null
  )
    return null;
  if (
    typeof raw.pathPattern !== 'string' ||
    raw.pathPattern.length > 200 ||
    !PATH_MASK_RE.test(raw.pathPattern) ||
    // `*` — только в конце (маска как у правил кабинета).
    raw.pathPattern.slice(0, -1).includes('*')
  )
    return null;
  const samplePages = Array.isArray(raw.samplePages)
    ? raw.samplePages
        .filter(
          (p): p is string =>
            typeof p === 'string' &&
            PATH_MASK_RE.test(p) &&
            !p.includes('*') &&
            pathMatches(p, raw.pathPattern as string),
        )
        .slice(0, VOICE_MAP_LIMITS.samplePages)
    : [];
  return { name: raw.name.trim(), pathPattern: raw.pathPattern, samplePages };
}

// ── операции черновика (§5-кватер.9, §5-кватер.12 «Отмена») ──────────────

export type MapOp =
  | { op: 'upsert-target'; target: unknown }
  | { op: 'remove-target'; key: string }
  | { op: 'restore-target'; key: string }
  | { op: 'rebind-target'; key: string; descriptor: unknown }
  | { op: 'add-synonym'; key: string; lang: string; text: string }
  | { op: 'sample'; key: string; path: string; found: number }
  | { op: 'upsert-template'; template: unknown }
  | { op: 'remove-template'; id: string }
  | { op: 'set-terms'; terms: unknown };

export interface MapOpIssue {
  index: number;
  code:
    | 'bad_op'
    | 'bad_target'
    | 'bad_key'
    | 'not_found'
    | 'risk_lowering_forbidden'
    | 'never_target_named'
    | 'never_attr_denylist_only'
    | 'text_invalid'
    | 'limit'
    | 'bad_template'
    | 'key_taken';
  path?: string;
  detail?: string;
}

export interface MapOpsResult {
  content: VoiceMapContent;
  issues: MapOpIssue[];
  /** Сжатые записи для журнала изменений (без подписей страницы). */
  changes: Array<Record<string, unknown>>;
}

function textIssues(
  t: {
    names: Partial<Record<VoiceMapLang, unknown>>;
    synonyms: Partial<Record<VoiceMapLang, unknown>>;
  },
  index: number,
): MapOpIssue[] {
  const out: MapOpIssue[] = [];
  for (const l of VOICE_MAP_LANGS) {
    const n = t.names[l];
    if (n !== undefined && n !== null && n !== '') {
      const p =
        typeof n === 'string'
          ? memoTextProblem(n, VOICE_MAP_LIMITS.nameChars)
          : 'type';
      if (p)
        out.push({
          index,
          code: 'text_invalid',
          path: `names.${l}`,
          detail: p,
        });
    }
    const list = t.synonyms[l];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      out.push({ index, code: 'text_invalid', path: `synonyms.${l}` });
      continue;
    }
    if (list.length > VOICE_MAP_LIMITS.synonymsPerLang)
      out.push({ index, code: 'limit', path: `synonyms.${l}` });
    list.forEach((s: unknown, k: number) => {
      const text = isObj(s) ? s.text : s;
      const p =
        typeof text === 'string'
          ? memoTextProblem(text, VOICE_MAP_LIMITS.synonymChars)
          : 'type';
      if (p)
        out.push({
          index,
          code: 'text_invalid',
          path: `synonyms.${l}.${k}`,
          detail: p,
        });
    });
  }
  return out;
}

/** Есть ли у цели имена/синонимы (у «никогда» их быть не должно). */
function named(t: Pick<VoiceMapTarget, 'names' | 'synonyms'>): boolean {
  return (
    VOICE_MAP_LANGS.some((l) => !!t.names[l]) ||
    VOICE_MAP_LANGS.some((l) => (t.synonyms[l] ?? []).length > 0)
  );
}

/**
 * Проверка одной цели на правила «только вверх» (§5-кватер.11 п.1, второе
 * из трёх мест): понижение риска ниже расчёта кода — 422; имена/синонимы у
 * цели класса «никогда» — 422 (такая цель — только denylist); элемент под
 * `data-assist="never"` — только в denylist.
 */
export function targetRuleIssues(
  t: VoiceMapTarget,
  index: number,
): MapOpIssue[] {
  const out: MapOpIssue[] = [];
  if (t.riskOwner && mapRiskBelow(t.riskOwner, t.riskComputed))
    out.push({ index, code: 'risk_lowering_forbidden', path: 'riskOwner' });
  if (t.descriptor.neverAttr && !t.denylisted)
    out.push({ index, code: 'never_attr_denylist_only', path: 'denylisted' });
  if (effectiveRisk(t) === 'never' && named(t))
    out.push({ index, code: 'never_target_named', path: 'names' });
  return out;
}

/**
 * Применить пакет операций к черновику. Ошибочная операция не применяется
 * и попадает в `issues` (сервис отвечает 422 на весь пакет — черновик не
 * меняется частично). `hosts` — подтверждённые хосты сайта (риск ссылок:
 * чужой хост — «никогда»); `newId` — генератор id шаблонов.
 */
export function applyMapOps(
  base: VoiceMapContent,
  ops: unknown,
  ctx: {
    hosts: readonly string[];
    newId: () => string;
    source: MapChangeSource;
  },
): MapOpsResult {
  const content: VoiceMapContent = JSON.parse(
    JSON.stringify(base),
  ) as VoiceMapContent;
  const issues: MapOpIssue[] = [];
  const changes: Array<Record<string, unknown>> = [];
  if (!Array.isArray(ops) || ops.length === 0) {
    issues.push({ index: -1, code: 'bad_op' });
    return { content, issues, changes };
  }
  if (ops.length > VOICE_MAP_LIMITS.opsPerPatch) {
    issues.push({ index: -1, code: 'limit' });
    return { content, issues, changes };
  }
  const find = (key: unknown) =>
    typeof key === 'string'
      ? content.targets.find((t) => t.key === key)
      : undefined;
  ops.forEach((raw, index) => {
    if (!isObj(raw) || typeof raw.op !== 'string') {
      issues.push({ index, code: 'bad_op' });
      return;
    }
    switch (raw.op) {
      case 'upsert-target': {
        const input = isObj(raw.target) ? raw.target : null;
        if (!input) {
          issues.push({ index, code: 'bad_target' });
          return;
        }
        const ti = textIssues(
          {
            names: isObj(input.names) ? input.names : {},
            synonyms: isObj(input.synonyms) ? input.synonyms : {},
          },
          index,
        );
        if (ti.length) {
          issues.push(...ti);
          return;
        }
        if (
          input.riskOwner !== undefined &&
          input.riskOwner !== null &&
          !(MAP_RISKS as readonly string[]).includes(input.riskOwner as string)
        ) {
          issues.push({ index, code: 'bad_target', path: 'riskOwner' });
          return;
        }
        const prev = find(input.key);
        // Дескриптор: новый — из операции; правка карточки без дескриптора —
        // прежний (перепривязка — отдельной операцией).
        const merged = {
          ...(prev ?? {}),
          ...input,
          descriptor: input.descriptor ?? prev?.descriptor,
          riskComputed: undefined,
          samples: prev?.samples ?? [],
          origin: prev?.origin ?? input.origin ?? 'owner',
          status: 'active',
        };
        const t = parseTarget(merged, content.templates);
        if (!t) {
          issues.push({
            index,
            code:
              typeof input.key === 'string' &&
              !VOICE_MAP_LIMITS.keyRe.test(input.key)
                ? 'bad_key'
                : 'bad_target',
          });
          return;
        }
        const r = computeTargetRisk(t.descriptor, ctx.hosts, t.stability);
        t.riskComputed = r.risk;
        t.riskReason = r.reason;
        // Аудит Э6-тер: импорт поверх существующей цели риск только поднимает
        // (§5-кватер.12): риск владельца, denylist и тип — не ниже черновика.
        if (ctx.source === 'import' && prev) {
          if (prev.riskOwner)
            t.riskOwner = mapRiskMax(prev.riskOwner, t.riskOwner);
          if (prev.denylisted) t.denylisted = true;
          if (
            MAP_RANK[typeFloor(prev.semanticType)] >
            MAP_RANK[typeFloor(t.semanticType)]
          )
            t.semanticType = prev.semanticType;
        }
        const ri = targetRuleIssues(t, index);
        if (ri.length) {
          issues.push(...ri);
          return;
        }
        if (!prev && content.targets.length >= VOICE_MAP_LIMITS.targets) {
          issues.push({ index, code: 'limit' });
          return;
        }
        if (prev) content.targets[content.targets.indexOf(prev)] = t;
        else content.targets.push(t);
        changes.push({
          op: prev ? 'update-target' : 'add-target',
          key: t.key,
          scope: t.scope,
          risk: effectiveRisk(t),
          denylisted: t.denylisted,
        });
        return;
      }
      case 'remove-target':
      case 'restore-target': {
        const t = find(raw.key);
        if (!t) {
          issues.push({ index, code: 'not_found' });
          return;
        }
        t.status = raw.op === 'remove-target' ? 'removed' : 'active';
        changes.push({ op: raw.op, key: t.key });
        return;
      }
      case 'rebind-target': {
        const t = find(raw.key);
        const d = parseDescriptor(raw.descriptor);
        if (!t || !d) {
          issues.push({ index, code: t ? 'bad_target' : 'not_found' });
          return;
        }
        const next: VoiceMapTarget = {
          ...t,
          descriptor: d,
          samples: [],
          stability: descriptorStability(d),
        };
        const r = computeTargetRisk(d, ctx.hosts, next.stability);
        next.riskComputed = r.risk;
        next.riskReason = r.reason;
        const ri = targetRuleIssues(next, index);
        if (ri.length) {
          issues.push(...ri);
          return;
        }
        content.targets[content.targets.indexOf(t)] = next;
        changes.push({ op: 'rebind-target', key: t.key });
        return;
      }
      case 'add-synonym': {
        const t = find(raw.key);
        const lang = raw.lang as VoiceMapLang;
        if (!t || !(VOICE_MAP_LANGS as readonly string[]).includes(lang)) {
          issues.push({ index, code: t ? 'bad_op' : 'not_found' });
          return;
        }
        const p =
          typeof raw.text === 'string'
            ? memoTextProblem(raw.text, VOICE_MAP_LIMITS.synonymChars)
            : 'type';
        if (p) {
          issues.push({ index, code: 'text_invalid', detail: p });
          return;
        }
        if (effectiveRisk(t) === 'never') {
          issues.push({ index, code: 'never_target_named' });
          return;
        }
        const list = t.synonyms[lang] ?? [];
        const text = (raw.text as string).trim();
        if (!list.some((s) => phraseNorm(s.text) === phraseNorm(text))) {
          if (list.length >= VOICE_MAP_LIMITS.synonymsPerLang) {
            issues.push({ index, code: 'limit' });
            return;
          }
          list.push({
            text,
            origin: ctx.source === 'suggestion' ? 'queue' : 'owner',
          });
        }
        t.synonyms[lang] = list;
        changes.push({ op: 'add-synonym', key: t.key, lang });
        return;
      }
      case 'sample': {
        const t = find(raw.key);
        if (
          !t ||
          typeof raw.path !== 'string' ||
          !PATH_MASK_RE.test(raw.path) ||
          typeof raw.found !== 'number' ||
          !Number.isInteger(raw.found) ||
          raw.found < 0
        ) {
          issues.push({ index, code: t ? 'bad_op' : 'not_found' });
          return;
        }
        const path = raw.path;
        t.samples = [
          ...t.samples.filter((s) => s.path !== path),
          { path, found: Math.min(raw.found, 99) },
        ].slice(-VOICE_MAP_LIMITS.samplesPerTarget);
        t.stability = descriptorStability(t.descriptor, t.samples);
        // Хрупкая цель «сразу» не бывает — риск кода поднимается.
        if (t.stability === 'fragile')
          t.riskComputed = mapRiskMax(t.riskComputed, 'confirm');
        changes.push({ op: 'sample', key: t.key, found: raw.found });
        return;
      }
      case 'upsert-template': {
        const input = isObj(raw.template) ? raw.template : null;
        const clean = input ? cleanTemplate(input) : null;
        if (!input || !clean) {
          issues.push({ index, code: 'bad_template' });
          return;
        }
        const prev =
          typeof input.id === 'string'
            ? content.templates.find((x) => x.id === input.id)
            : undefined;
        if (!prev && content.templates.length >= VOICE_MAP_LIMITS.templates) {
          issues.push({ index, code: 'limit' });
          return;
        }
        const tpl: VoiceMapTemplate = {
          ...clean,
          id: prev?.id ?? ctx.newId(),
          status: input.status === 'suggested' ? 'suggested' : 'active',
        };
        if (prev) content.templates[content.templates.indexOf(prev)] = tpl;
        else content.templates.push(tpl);
        changes.push({
          op: prev ? 'update-template' : 'add-template',
          id: tpl.id,
          pathPattern: tpl.pathPattern,
        });
        return;
      }
      case 'remove-template': {
        const tpl = content.templates.find((x) => x.id === raw.id);
        if (!tpl) {
          issues.push({ index, code: 'not_found' });
          return;
        }
        tpl.status = 'removed';
        // Цели шаблона уходят вместе с ним (мягко — «вернуть» до публикации).
        for (const t of content.targets)
          if (t.templateId === tpl.id) t.status = 'removed';
        changes.push({ op: 'remove-template', id: tpl.id });
        return;
      }
      case 'set-terms': {
        const list = Array.isArray(raw.terms) ? raw.terms : null;
        if (
          !list ||
          list.length > 100 ||
          list.some(
            (x) =>
              typeof x !== 'string' ||
              memoTextProblem(x, VOICE_MAP_LIMITS.synonymChars) !== null,
          )
        ) {
          issues.push({ index, code: 'text_invalid', path: 'terms' });
          return;
        }
        content.terms = (list as string[]).map((x) => x.trim());
        changes.push({ op: 'set-terms', count: list.length });
        return;
      }
      default:
        issues.push({ index, code: 'bad_op' });
    }
  });
  return { content, issues, changes };
}

// ── шаблоны страниц ───────────────────────────────────────────────────────

/** Специфичность маски: точная — выше любой `*`; длиннее префикс — уже. */
export function maskSpecificity(mask: string): number {
  return mask.endsWith('*') ? mask.length - 1 : 10_000 + mask.length;
}

/** Самый узкий активный шаблон страницы (§5-кватер.4: узкая маска побеждает). */
export function templateFor(
  content: Pick<VoiceMapContent, 'templates'>,
  path: string,
): VoiceMapTemplate | null {
  let best: VoiceMapTemplate | null = null;
  for (const t of content.templates) {
    if (t.status !== 'active' || !pathMatches(path, t.pathPattern)) continue;
    if (
      !best ||
      maskSpecificity(t.pathPattern) > maskSpecificity(best.pathPattern)
    )
      best = t;
  }
  return best;
}

/** Цели, действующие на странице: весь сайт + узкий шаблон + эта страница. */
export function targetsForPage(
  content: VoiceMapContent,
  path: string,
): VoiceMapTarget[] {
  const tpl = templateFor(content, path);
  return content.targets.filter(
    (t) =>
      t.status === 'active' &&
      (t.scope === 'site' ||
        (t.scope === 'template' && !!tpl && t.templateId === tpl.id) ||
        (t.scope === 'page' &&
          (t.pagePath === path || t.pagePath === `${path}/`))),
  );
}

/**
 * Предложение шаблонов по путям страниц сайта (§5-кватер.4 «Шаблоны
 * страниц»): общий префикс + переменная часть (`/product/*`) при ≥ 3
 * разных страницах. Структурный отпечаток — с воркером (не здесь).
 */
export function suggestTemplates(
  paths: readonly string[],
  existing: readonly string[] = [],
): Array<{ pathPattern: string; pages: number; samplePages: string[] }> {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!PATH_MASK_RE.test(p)) continue;
    const segs = p.split('/').filter(Boolean);
    if (segs.length < 2) continue;
    for (let depth = 1; depth < segs.length; depth++) {
      const mask = `/${segs.slice(0, depth).join('/')}/*`;
      const set = groups.get(mask) ?? new Set<string>();
      set.add(p);
      groups.set(mask, set);
    }
  }
  const out = [...groups.entries()]
    .filter(([m, s]) => s.size >= 3 && !existing.includes(m))
    .map(([pathPattern, s]) => ({
      pathPattern,
      pages: s.size,
      samplePages: [...s].sort().slice(0, VOICE_MAP_LIMITS.samplePages),
    }))
    .sort(
      (a, b) => b.pages - a.pages || a.pathPattern.localeCompare(b.pathPattern),
    );
  // Вложенная маска с тем же набором страниц — шум («/a/*» и «/a/b/*»).
  return out
    .filter(
      (x) =>
        !out.some(
          (y) =>
            y !== x &&
            y.pages === x.pages &&
            x.pathPattern.startsWith(y.pathPattern.slice(0, -1)),
        ),
    )
    .slice(0, 20);
}

// ── ворота публикации (§5-кватер.9) ───────────────────────────────────────

export type MapGateCode =
  | 'risk_lowered'
  | 'never_named'
  | 'never_attr'
  | 'phrase_conflict'
  | 'memo_phrase'
  | 'text'
  | 'not_found'
  | 'empty';

export interface MapGateProblem {
  code: MapGateCode;
  key?: string;
  other?: string;
  lang?: VoiceMapLang;
  phrase?: string;
}

export interface MapGateReport {
  ok: boolean;
  problems: MapGateProblem[];
  warnings: Array<{
    code: 'not_found' | 'fragile' | 'memo_affected';
    key?: string;
    memo?: number;
  }>;
  counts: {
    targets: number;
    denylisted: number;
    templates: number;
    notFound: number;
    fragile: number;
  };
}

function groupOverlap(
  a: VoiceMapTarget,
  b: VoiceMapTarget,
  templates: readonly VoiceMapTemplate[],
): boolean {
  if (a.scope === 'site' || b.scope === 'site') return true;
  if (a.scope === 'template' && b.scope === 'template')
    return a.templateId === b.templateId;
  if (a.scope === 'page' && b.scope === 'page')
    return a.pagePath === b.pagePath;
  const page = a.scope === 'page' ? a : b;
  const tpl = templates.find(
    (t) => t.id === (a.scope === 'template' ? a.templateId : b.templateId),
  );
  return (
    !!tpl && !!page.pagePath && pathMatches(page.pagePath, tpl.pathPattern)
  );
}

/**
 * Ворота кода при сборке версии. Блокируют (`held`): понижение риска,
 * имя/синоним у цели «никогда», `data-assist="never"` не в denylist,
 * конфликт фраз (одна фраза → две цели одного шаблона/страницы или фраза
 * мемо), невалидный текст, > 30% целей не найдены на образцах. Показывают:
 * каждая ненайденная, хрупкие, затронутые мемо.
 */
/**
 * Мемо, затронутые картой (аудит Э6-бис (е) (2), Э6-тер): шаг нажимает
 * цель — по разметке (`assistId`) или по ключу карты (`mapKey`), — которая
 * стала «никогда» (риск/denylist) или удалена (была в прежней версии, нет
 * в этой; ключ мемо не найден ни там, ни там). После публикации карты
 * такие мемо уходят в `needs_review` (в бою не исполняются).
 */
export function memoAffected(
  content: VoiceMapContent,
  ctx: {
    memoAssistIds?: ReadonlyMap<string, number[]>;
    memoMapKeys?: ReadonlyMap<string, number[]>;
    previous?: VoiceMapContent | null;
  },
): Array<{ code: 'memo_affected'; key: string; memo: number }> {
  const out: Array<{ code: 'memo_affected'; key: string; memo: number }> = [];
  if (!ctx.memoAssistIds && !ctx.memoMapKeys) return out;
  const seen = new Set<string>();
  const push = (key: string, nums: readonly number[]) => {
    for (const memo of nums) {
      const k = `${key}|${memo}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ code: 'memo_affected', key, memo });
    }
  };
  const users = (t: VoiceMapTarget): number[] => [
    ...((t.descriptor.assistId &&
      ctx.memoAssistIds?.get(t.descriptor.assistId)) ||
      []),
    ...(ctx.memoMapKeys?.get(t.key) ?? []),
  ];
  const active = new Set(
    content.targets.filter((t) => t.status === 'active').map((t) => t.key),
  );
  for (const t of content.targets)
    if (t.status === 'removed' || t.denylisted || effectiveRisk(t) === 'never')
      push(t.key, users(t));
  const known = new Set(content.targets.map((t) => t.key));
  for (const t of ctx.previous?.targets ?? []) {
    known.add(t.key);
    if (t.status === 'active' && !active.has(t.key)) push(t.key, users(t));
  }
  for (const [key, nums] of ctx.memoMapKeys ?? [])
    if (!known.has(key)) push(key, nums);
  return out;
}

export function voiceMapGates(
  content: VoiceMapContent,
  ctx: {
    /** Фразы опубликованных мемо: `${lang}:${norm}`. */
    memoPhrases?: ReadonlySet<string>;
    /** Мемо, чьи шаги ссылаются на разметку целей: assistId → номера. */
    memoAssistIds?: ReadonlyMap<string, number[]>;
    /** Мемо, чьи шаги найдены по цели карты (`MemoTarget.mapKey`): ключ → номера. */
    memoMapKeys?: ReadonlyMap<string, number[]>;
    /**
     * Опубликованная (прежняя) версия: её цели, которых в этой нет, —
     * «удалены» для мемо (версия хранит только активные цели).
     */
    previous?: VoiceMapContent | null;
  } = {},
): MapGateReport {
  const problems: MapGateProblem[] = [];
  const warnings: MapGateReport['warnings'] = [];
  const active = content.targets.filter((t) => t.status === 'active');
  for (const t of active) {
    if (t.riskOwner && mapRiskBelow(t.riskOwner, t.riskComputed))
      problems.push({ code: 'risk_lowered', key: t.key });
    if (t.descriptor.neverAttr && !t.denylisted)
      problems.push({ code: 'never_attr', key: t.key });
    if (effectiveRisk(t) === 'never' && named(t))
      problems.push({ code: 'never_named', key: t.key });
    for (const p of targetPhrases(t))
      if (memoTextProblem(p.text, VOICE_MAP_LIMITS.nameChars) !== null)
        problems.push({ code: 'text', key: t.key, lang: p.lang });
  }
  // Конфликт фраз: одна нормализованная фраза — одна цель там, где они
  // действуют вместе; и не совпадает с фразой мемо (общий индекс фраз).
  const named_ = active.filter((t) => !t.denylisted);
  const seen = new Map<string, VoiceMapTarget[]>();
  for (const t of named_)
    for (const p of targetPhrases(t)) {
      const k = `${p.lang}:${p.norm}`;
      if (ctx.memoPhrases?.has(k))
        problems.push({
          code: 'memo_phrase',
          key: t.key,
          lang: p.lang,
          phrase: p.text,
        });
      const list = seen.get(k) ?? [];
      for (const o of list)
        if (o.key !== t.key && groupOverlap(o, t, content.templates))
          problems.push({
            code: 'phrase_conflict',
            key: t.key,
            other: o.key,
            lang: p.lang,
            phrase: p.text,
          });
      if (!list.includes(t)) list.push(t);
      seen.set(k, list);
    }
  const sampled = active.filter((t) => t.samples.length > 0);
  const lost = sampled.filter((t) => t.samples.some((s) => s.found !== 1));
  for (const t of lost) warnings.push({ code: 'not_found', key: t.key });
  if (
    active.length &&
    lost.length / active.length > VOICE_MAP_LIMITS.notFoundHeldShare
  )
    problems.push({ code: 'not_found' });
  const fragile = active.filter((t) => t.stability === 'fragile');
  for (const t of fragile) warnings.push({ code: 'fragile', key: t.key });
  warnings.push(...memoAffected(content, ctx));
  if (!active.length) problems.push({ code: 'empty' });
  return {
    ok: problems.length === 0,
    problems: dedupeProblems(problems),
    warnings,
    counts: {
      targets: active.length,
      denylisted: active.filter((t) => t.denylisted).length,
      templates: content.templates.filter((t) => t.status === 'active').length,
      notFound: lost.length,
      fragile: fragile.length,
    },
  };
}

function dedupeProblems(ps: MapGateProblem[]): MapGateProblem[] {
  const seen = new Set<string>();
  return ps.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Содержимое версии — только активные цели и шаблоны (без предложений). */
export function versionContent(draft: VoiceMapContent): VoiceMapContent {
  const templates = draft.templates.filter((t) => t.status === 'active');
  const ids = new Set(templates.map((t) => t.id));
  return {
    schemaVersion: 1,
    templates,
    targets: draft.targets
      .filter(
        (t) =>
          t.status === 'active' &&
          (t.scope !== 'template' || (t.templateId && ids.has(t.templateId))),
      )
      .map((t) => ({
        ...t,
        // Предложения ИИ (`suggested`) в версию не попадают (Р-33): их видела
        // бы роль виджета через представление.
        synonyms: Object.fromEntries(
          Object.entries(t.synonyms).map(([l, list]) => [
            l,
            (list ?? []).filter((s) => s.origin !== 'suggested'),
          ]),
        ) as VoiceMapTarget['synonyms'],
      })),
    terms: draft.terms,
  };
}

/** Дифф двух содержимых для TMA: +цели, ~изменённые, −удалённые. */
export function voiceMapDiff(
  prev: VoiceMapContent | null,
  next: VoiceMapContent,
): { added: string[]; changed: string[]; removed: string[] } {
  const before = new Map((prev?.targets ?? []).map((t) => [t.key, t]));
  const after = new Map(next.targets.map((t) => [t.key, t]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [k, t] of after) {
    const p = before.get(k);
    if (!p) added.push(k);
    else if (JSON.stringify(p) !== JSON.stringify(t)) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added, changed, removed };
}

// ── в бою: разрешение по снимку и прямой путь (§5-кватер.8) ──────────────

export interface MapHit {
  key: string;
  ref: string;
  /** Имена и синонимы (все языки) — совпадение «цель ↔ команда». */
  names: string[];
  floor: UiRisk;
  denylisted: boolean;
}

function hrefHostOf(href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href).host;
  } catch {
    return null;
  }
}

/** Путь ссылки снимка — с той же маской ПД, что путь в дескрипторе. */
function hrefPathOf(href: string | null): string | null {
  if (!href) return null;
  try {
    return maskPagePath(new URL(href).pathname);
  } catch {
    return null;
  }
}

/**
 * Найти цель карты в снимке (порядок поиска §5-кватер.8 п.6): разметка →
 * путь ссылки с ролью → роль + видимый текст. Только единственное
 * совпадение; иначе — не найдена (сервер не угадывает).
 */
export function findInSnapshot(
  d: VoiceMapDescriptor,
  elements: readonly UiSnapElement[],
): UiSnapElement | null {
  const one = (xs: UiSnapElement[]) => (xs.length === 1 ? xs[0] : null);
  if (d.assistId) return one(elements.filter((e) => e.assistId === d.assistId));
  if (d.hrefPath && (d.tag === 'a' || d.role === 'link')) {
    const byHref = elements.filter(
      (e) =>
        e.role === 'link' &&
        hrefPathOf(e.href) === d.hrefPath &&
        (!d.hrefHost || hrefHostOf(e.href) === d.hrefHost),
    );
    if (byHref.length === 1) return byHref[0];
    if (byHref.length > 1 && d.text) {
      const t = normText(d.text);
      const narrowed = byHref.filter((e) => normText(e.text) === t);
      if (narrowed.length === 1) return narrowed[0];
    }
  }
  if (!d.text) return null;
  const t = normText(d.text);
  let hits = elements.filter((e) => normText(e.text) === t);
  if (hits.length > 1 && d.role) hits = hits.filter((e) => e.role === d.role);
  if (hits.length > 1 && d.heading) {
    const h = normText(d.heading);
    hits = hits.filter((e) => e.heading && normText(e.heading) === h);
  }
  return one(hits);
}

export interface ResolvedMap {
  /** Цели, найденные в снимке: ссылка элемента → подсказка. */
  hits: MapHit[];
  /** Ключи действующих на странице целей, не найденных в снимке. */
  missing: string[];
  /** Элементы снимка из denylist карты — вон из снимка до плана. */
  denyRefs: string[];
  /** Все действующие цели с фразами (для прямого пути и промаха). */
  targets: VoiceMapTarget[];
}

export function resolveVoiceMap(
  content: VoiceMapContent,
  snapshot: UiSnapshot,
  path: string,
): ResolvedMap {
  const targets = targetsForPage(content, path);
  const hits: MapHit[] = [];
  const missing: string[] = [];
  const denyRefs: string[] = [];
  const taken = new Set<string>();
  for (const t of targets) {
    const el = findInSnapshot(t.descriptor, snapshot.elements);
    if (!el || taken.has(el.ref)) {
      missing.push(t.key);
      continue;
    }
    taken.add(el.ref);
    if (t.denylisted) {
      denyRefs.push(el.ref);
      continue;
    }
    hits.push({
      key: t.key,
      ref: el.ref,
      names: targetPhrases(t).map((p) => p.text),
      floor: mapFloor(effectiveRisk(t)),
      denylisted: false,
    });
  }
  return { hits, missing, denyRefs, targets };
}

const VERB_PREFIX =
  /^(відкрий(те)?|натисни|натисніть|перейди(ть)?|відкрити|открой(те)?|нажми(те)?|перейди(те)?|open|click|press|tap|go to|покажи(ть|те)?|show|додай(те)?|добавь(те)?|add|постав(те)?|поставь(те)?)\s+/u;

/** Команда без вежливости и глагола-действия: «натисни в кошик» → «в кошик». */
export function commandBody(text: string): string {
  return phraseNorm(phraseNorm(text).replace(VERB_PREFIX, ''));
}

/**
 * Прямой путь по карте (§5-кватер.8 п.3): нормализованная команда (или её
 * тело без глагола) совпала с именем/синонимом РОВНО ОДНОЙ действующей
 * цели. Найдена в снимке — шаг клика кодом (дальше — обычный `checkPlan`);
 * не найдена — промах карты (`mapMiss`, сигнал Т-4) и обычный путь.
 */
export function directMapPlan(
  text: string,
  resolved: ResolvedMap,
): { raw: RawStep[]; key: string; phrase: string } | { miss: string } | null {
  const full = phraseNorm(text);
  const body = commandBody(text);
  if (!full) return null;
  const matched = resolved.targets.filter(
    (t) =>
      !t.denylisted &&
      targetPhrases(t).some((p) => p.norm === full || p.norm === body),
  );
  if (matched.length !== 1) return null;
  const t = matched[0];
  const hit = resolved.hits.find((h) => h.key === t.key);
  if (!hit) return { miss: t.key };
  const phrase =
    targetPhrases(t).find((p) => p.norm === full || p.norm === body)?.text ??
    '';
  const d = t.descriptor;
  const kind =
    d.role === 'searchbox' || d.inputType === 'search' ? 'click' : 'click';
  return { raw: [{ kind, target: hit.ref }], key: t.key, phrase };
}

/** Подсказки карты для `checkPlan`: ссылка → имена и нижняя граница риска. */
export function mapHintsOf(
  resolved: ResolvedMap,
  map: ReadonlyArray<{ ref: string; selector: string; label: string }> = [],
): Map<string, { key: string; names: string[]; floor: UiRisk }> {
  const out = new Map(
    resolved.hits.map((h) => [
      h.ref,
      { key: h.key, names: h.names, floor: h.floor },
    ]),
  );
  // Аудит Э6-тер: ссылки общей карты Ш4 (`mN`) — тот же элемент другим
  // путём; без подсказки запрет/подъём риска картой обходился бы через
  // `mN`. Совпадение (селектор кандидата или видимый текст) — консервативно:
  // denylist → «никогда», иначе — нижняя граница карты.
  for (const m of map) {
    const label = normText(m.label);
    let hint: { key: string; names: string[]; floor: UiRisk } | null = null;
    for (const t of resolved.targets) {
      const sel = descriptorCandidates(t.descriptor)
        .map((c) => c.selector)
        .filter((s): s is string => !!s);
      const same =
        sel.includes(m.selector) ||
        (!!label &&
          !!t.descriptor.text &&
          normText(t.descriptor.text) === label);
      if (!same) continue;
      const floor: UiRisk = t.denylisted ? 'never' : mapFloor(effectiveRisk(t));
      if (!hint || UI_RISK_RANK[floor] > UI_RISK_RANK[hint.floor])
        hint = {
          key: t.key,
          names: t.denylisted ? [] : targetPhrases(t).map((p) => p.text),
          floor,
        };
    }
    if (hint) out.set(m.ref, hint);
  }
  return out;
}

const UI_RISK_RANK: Record<UiRisk, number> = {
  auto: 0,
  confirm: 1,
  manual: 2,
  never: 3,
};

/** Ссылки Ш4 без целей denylist карты — в промпт модели (аудит Э6-тер). */
export function mapRefsForPrompt<
  T extends { ref: string; selector: string; label: string },
>(map: readonly T[], hints: ReadonlyMap<string, { floor: UiRisk }>): T[] {
  return map.filter((m) => hints.get(m.ref)?.floor !== 'never');
}

/** Совпадение команды с именами карты (владелец — доверенный источник названий). */
export function namesMatch(
  names: readonly string[],
  transcript: string,
): boolean {
  return names.some((n) => overlaps(transcript, n));
}

// ── фрагмент разметки для разработчика (§5-кватер.4) ─────────────────────

/** Предложенный `data-assist-id` (латиница, kebab-case) по имени цели. */
export function suggestAssistId(
  t: Pick<VoiceMapTarget, 'key' | 'semanticType'>,
): string {
  if (t.semanticType === 'add-to-cart') return 'add-to-cart';
  if (t.semanticType === 'favorite') return 'add-to-wishlist';
  if (t.semanticType === 'compare') return 'add-to-compare';
  if (t.semanticType === 'search') return 'search';
  return t.key;
}

export function markupSnippet(
  t: VoiceMapTarget,
  template: VoiceMapTemplate | null,
): { assistId: string; where: string; line: string } | null {
  if (t.descriptor.assistId) return null;
  const id = suggestAssistId(t);
  const d = t.descriptor;
  const where = [
    template
      ? `${template.name} (${template.pathPattern})`
      : (t.pagePath ?? '/'),
    `${d.tag}${d.text ? ` «${d.text}»` : ''}`,
    d.css ? `css: ${d.css}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return { assistId: id, where, line: `data-assist-id="${id}"` };
}

/**
 * Пара компенсации цели (Э6-тер (и), §5-бис.15 п.6): объявленная владельцем
 * («Как отменить») или встроенная пара стандартной разметки (В-68, Р-66).
 * По тексту кнопки — никогда.
 */
export function compensationOf(t: VoiceMapTarget): MapUndo | null {
  if (t.undo) return t.undo;
  const pair = t.descriptor.assistId
    ? (STANDARD_UNDO_PAIRS[t.descriptor.assistId] ?? null)
    : null;
  return pair ? { assistId: pair, at: null } : null;
}

// ── экспорт / импорт (§5-кватер.12) ───────────────────────────────────────

export interface VoiceMapExport {
  schemaVersion: 1;
  kind: 'site' | 'admin';
  templates: Array<{ ref: string; name: string; pathPattern: string }>;
  targets: Array<Record<string, unknown>>;
  terms: string[];
}

/** Файл экспорта — без внутренних id, образцов страниц и журнала. */
export function exportPayload(c: VoiceMapContent): VoiceMapExport {
  const tpls = c.templates.filter((t) => t.status === 'active');
  const refOf = new Map(tpls.map((t, i) => [t.id, `t${i + 1}`]));
  return {
    schemaVersion: 1,
    kind: 'site',
    templates: tpls.map((t) => ({
      ref: refOf.get(t.id) as string,
      name: t.name,
      pathPattern: t.pathPattern,
    })),
    targets: c.targets
      .filter((t) => t.status === 'active')
      .filter((t) => t.scope !== 'template' || refOf.has(t.templateId ?? ''))
      .map((t) => ({
        key: t.key,
        scope: t.scope,
        template: t.templateId ? refOf.get(t.templateId) : null,
        pagePath: t.pagePath,
        descriptor: t.descriptor,
        names: t.names,
        synonyms: Object.fromEntries(
          Object.entries(t.synonyms).map(([l, list]) => [
            l,
            (list ?? [])
              .filter((s) => s.origin !== 'suggested')
              .map((s) => ({ text: s.text })),
          ]),
        ),
        semanticType: t.semanticType,
        riskOwner: t.riskOwner,
        denylisted: t.denylisted,
        control: t.control,
        undo: t.undo,
      })),
    terms: c.terms,
  };
}

/**
 * Импорт в черновик как пакет операций (§5-кватер.12): `kind` другого вида
 * — отказ целиком; каждая цель — со всеми проверками («только вверх»,
 * тексты, ключ); отклонённые — в отчёт с причиной. Происхождение синонимов
 * и целей — `import`.
 */
export function importOps(
  raw: unknown,
  newId: () => string,
):
  | { ok: false; reason: 'format' | 'kind' }
  | { ok: true; ops: MapOp[]; templateIds: Map<string, string> } {
  if (!isObj(raw) || raw.schemaVersion !== 1)
    return { ok: false, reason: 'format' };
  if (raw.kind !== 'site') return { ok: false, reason: 'kind' };
  if (!Array.isArray(raw.targets) || !Array.isArray(raw.templates))
    return { ok: false, reason: 'format' };
  const ops: MapOp[] = [];
  const templateIds = new Map<string, string>();
  for (const t of raw.templates.slice(0, VOICE_MAP_LIMITS.templates)) {
    if (!isObj(t) || typeof t.ref !== 'string') continue;
    const id = newId();
    templateIds.set(t.ref, id);
    ops.push({
      op: 'upsert-template',
      template: {
        id,
        name: t.name,
        pathPattern: t.pathPattern,
        samplePages: [],
      },
    });
  }
  for (const t of raw.targets.slice(0, VOICE_MAP_LIMITS.targets)) {
    if (!isObj(t)) {
      ops.push({ op: 'upsert-target', target: null });
      continue;
    }
    const synonyms = isObj(t.synonyms)
      ? Object.fromEntries(
          Object.entries(t.synonyms).map(([l, list]) => [
            l,
            Array.isArray(list)
              ? list.map((s) => ({
                  text: isObj(s) ? s.text : s,
                  origin: 'import',
                }))
              : list,
          ]),
        )
      : {};
    ops.push({
      op: 'upsert-target',
      target: {
        ...t,
        templateId:
          typeof t.template === 'string'
            ? (templateIds.get(t.template) ?? null)
            : null,
        synonyms,
        origin: 'import',
      },
    });
  }
  if (Array.isArray(raw.terms)) ops.push({ op: 'set-terms', terms: raw.terms });
  return { ok: true, ops, templateIds };
}

/** Канонический JSON (ключи по алфавиту) — подпись и хеш содержимого. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Хеш «того же содержимого» без id шаблонов (экспорт → импорт — тот же). */
export function contentFingerprint(c: VoiceMapContent): string {
  return canonicalJson(exportPayload(versionContent(c)));
}

// ── шаблоны платформ (§5-кватер.12; по В-54 — 1 платформа) ───────────────

/**
 * Шаблон WooCommerce (наш каталог, а не данные заказчика): цели по разметке,
 * которую ставит наш плагин WordPress (`data-assist-id`: «В кошик» —
 * `add-to-cart`, поиск — `search`, меню — `nav-<сегмент>`), с готовыми
 * именами и синонимами uk/ru/en. Попадают в ЧЕРНОВИК с происхождением
 * `template` и проходят все проверки; публикует человек. Shopify, Хорошоп,
 * Tilda — после стендов Т-1 (В-54: шаблоны 4 → 1).
 */
export const PLATFORM_TEMPLATES: Readonly<
  Record<string, { version: string; targets: Array<Record<string, unknown>> }>
> = {
  woocommerce: {
    version: 'woocommerce@1',
    targets: [
      {
        key: 'add-to-cart',
        scope: 'site',
        semanticType: 'add-to-cart',
        descriptor: {
          tag: 'button',
          role: 'button',
          text: '',
          assistId: 'add-to-cart',
          unique: true,
        },
        names: { uk: 'В кошик', ru: 'В корзину', en: 'Add to cart' },
        synonyms: {
          uk: [
            { text: 'до кошика', origin: 'template' },
            { text: 'додай у кошик', origin: 'template' },
          ],
          ru: [{ text: 'добавь в корзину', origin: 'template' }],
          en: [{ text: 'add to basket', origin: 'template' }],
        },
      },
      {
        key: 'search',
        scope: 'site',
        semanticType: 'search',
        descriptor: {
          tag: 'input',
          role: 'searchbox',
          text: '',
          assistId: 'search',
          inputType: 'search',
          unique: true,
        },
        names: { uk: 'Пошук', ru: 'Поиск', en: 'Search' },
        synonyms: {},
      },
      {
        key: 'nav-cart',
        scope: 'site',
        semanticType: 'nav',
        descriptor: {
          tag: 'a',
          role: 'link',
          text: '',
          assistId: 'nav-cart',
          unique: true,
        },
        names: { uk: 'Кошик', ru: 'Корзина', en: 'Cart' },
        synonyms: { uk: [{ text: 'відкрий кошик', origin: 'template' }] },
      },
    ],
  },
};

/** Операции черновика для шаблона платформы (ключи, уже занятые владельцем, не трогаются). */
export function platformTemplateOps(
  platform: string,
  existingKeys: ReadonlySet<string>,
): MapOp[] | null {
  const t = PLATFORM_TEMPLATES[platform];
  if (!t) return null;
  return t.targets
    .filter((x) => !existingKeys.has(String(x.key)))
    .map((x) => ({
      op: 'upsert-target',
      target: { ...x, origin: 'template' },
    }));
}
