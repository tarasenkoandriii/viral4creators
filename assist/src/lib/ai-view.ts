/**
 * Э3-бис: чистые помощники экранов «ИИ-оценка», «Выводы», «Эксперименты»,
 * «Поведение» (без React — проверяются `scripts/ai-api.test.ts`).
 */
import { fmt } from '../kit/i18n';
import type { e3bRu } from '../i18n/e3b-ru';
import type {
  AiSummaryView,
  ExperimentView,
  FindingView,
  InsightView,
  PowerView,
} from './ai-types';
import { AI_FAILURES, type AiFailure } from './ai-types';
import { pct } from './e3-view';
import { WIDGET_GLOBAL } from './widget-brand';

type E3b = typeof e3bRu;

/** Значение метрики скорости: LCP/INP — мс, CLS — без единиц. */
export function metricValue(
  metric: FindingView['metric'],
  value: number | null | undefined
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '—';
  if (metric === 'cls') return value.toFixed(2);
  if (metric === 'lcp' || metric === 'inp') return `${Math.round(value)} ms`;
  return String(Math.round(value * 100) / 100);
}

function reasonName(t: E3b, r: string | null): string {
  return r && (AI_FAILURES as readonly string[]).includes(r)
    ? t.ai.failureNames[r as AiFailure]
    : (r ?? '—');
}

/**
 * «Сухая» строка находки (числа кода, без модели) — то же, что видит
 * владелец, когда текст модели не прошёл проверку или тариф без ИИ.
 */
export function dryLine(
  t: E3b,
  i: Pick<InsightView, 'code' | 'finding'>
): string {
  const f = i.finding;
  const page = f.page ? fmt(t.insights.onPage, { page: f.page }) : '';
  const vars: Record<string, string | number> = {
    n: f.n,
    x: f.x,
    share: pct(f.share),
    page,
    topic: f.topic ?? '—',
    reason: reasonName(t, f.reason),
    field: f.field ?? '—',
    trigger: f.trigger ?? '—',
    metric: (f.metric ?? '').toUpperCase(),
    value:
      i.code === 'N8' ? metricValue(f.metric, f.value) : String(f.value ?? 0),
  };
  return fmt(t.insights.dry[i.code], vars);
}

/** Значение «было/стало» для сверки через 14 дней. */
export function followUpValue(
  i: Pick<InsightView, 'code' | 'finding'>,
  v: { share?: number; value?: number | null } | null | undefined
): string {
  if (!v) return '—';
  if (typeof v.share === 'number') return pct(v.share);
  if (i.code === 'N8') return metricValue(i.finding.metric, v.value);
  return typeof v.value === 'number' ? String(v.value) : '—';
}

/** Оттенок значка важности. */
export function impactTone(
  impact: InsightView['impact']
): 'danger' | 'warning' | 'neutral' {
  return impact === 'high'
    ? 'danger'
    : impact === 'medium'
      ? 'warning'
      : 'neutral';
}

/** Доля закрытых диалогов, уже размеченных (для подписи покрытия). */
export function coverageShare(c: AiSummaryView['coverage']): number | null {
  return c.closed > 0 ? Math.min(1, c.labeled / c.closed) : null;
}

/** Строка мощности перед запуском эксперимента (или причина отказа). */
export function powerLine(t: E3b, p: PowerView, horizonDays: number): string {
  if (!p.ok || p.mdeRel === null)
    return t.experiments.reasons[p.reason ?? 'underpowered'];
  return fmt(t.experiments.power, {
    days: horizonDays,
    mde: pct(p.mdeRel),
    base: pct(p.baseRate),
    perDay: Math.round(p.unitsPerDay * 10) / 10,
  });
}

/** Подпись разницы в процентных пунктах со знаком. */
export function signedPct(v: number): string {
  const s = pct(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

/**
 * Строки состояния эксперимента: итог показываем ТОЛЬКО у `done`
 * (фиксированный горизонт, без подглядывания); у остановленного и
 * испорченного — причина и «итога нет».
 */
export function experimentLines(
  t: E3b,
  e: ExperimentView,
  endsAt: string
): string[] {
  const x = t.experiments;
  const arms = e.kind === 'holdout' ? x.holdoutArms : x.variantArms;
  if (e.status === 'running')
    return [arms, fmt(x.running, { d: endsAt, a: e.units.a, b: e.units.b })];
  if (e.status === 'invalid') return [arms, x.invalid];
  if (e.status === 'stopped') {
    const why =
      e.stopReason === 'plan' ||
      e.stopReason === 'consent_off' ||
      e.stopReason === 'owner'
        ? x.stopWhy[e.stopReason]
        : x.stopWhy.owner;
    return [arms, fmt(x.stopped, { why })];
  }
  const r = e.result;
  if (!r) return [arms, x.verdicts.insufficient_sample];
  return [
    arms,
    fmt(x.result, {
      ra: pct(r.rateA),
      xa: r.xA,
      na: r.nA,
      rb: pct(r.rateB),
      xb: r.xB,
      nb: r.nB,
      diff: signedPct(r.diff),
      lo: signedPct(r.ciLow),
      hi: signedPct(r.ciHigh),
    }),
    x.verdicts[r.verdict],
  ];
}

/** Фрагмент для баннера согласия сайта (тот же, что в DEPLOYMENT §6.21). */
export const CONSENT_SNIPPET = `${WIDGET_GLOBAL}('consent', { analytics: true }); // false — при отказе`;
