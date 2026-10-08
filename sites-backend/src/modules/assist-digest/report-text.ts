/**
 * Тексты утренней сводки и отчёта недели — A (ТЗ §4.15 assist-digest,
 * §5-тер.7). ЧИСТЫЙ модуль: числа → текст сообщения бота ≤ 4 096 символов
 * (предел Telegram; §5-тер.16 п.9 — тест на самом длинном варианте), язык
 * кабинета — русский, как уведомления Э1–Э2 (паритет uk/en — вопрос
 * владельцу). Раздел «Админка» добавляется ТОЛЬКО если передан (решает
 * digest.service по правам получателя). Находки — сухие строки кода
 * (Start; ИИ-выводы — Э3-бис), каждое число — из входа.
 */
import type {
  AdminDigestFacts,
  AdminDigestMemo,
} from '../assist-admin-knowledge/admin-digest';

export const TELEGRAM_TEXT_LIMIT = 4096;

export interface SiteDigestFacts {
  siteName: string;
  period: { from: string; to: string };
  dialogs: number;
  dialogsPrev: number | null;
  resolved: number;
  operatorHours: number;
  handoffs: number;
  handoffsMissed: number;
  leads: number;
  conversionsDirect: number;
  conversionsAssisted: number;
  newTopics: number;
  heldVersions: number;
  goldenConflicts: number;
  /** Тревоги (№29): всплеск «не знаю» / 👎 / передач относительно 7 дней. */
  alerts: Array<'unknown_spike' | 'thumbs_down_spike' | 'handoff_spike'>;
  /** Сухие находки кода (≤ 3). */
  findings: string[];
}

/** Длина названия сайта и находки в тексте (длиннее — многоточие). */
export const SITE_NAME_MAX = 120;
export const FINDING_MAX = 280;
export const FINDINGS_MAX = 3;

const ALERT_TEXT: Record<SiteDigestFacts['alerts'][number], string> = {
  unknown_spike:
    '⚠️ Всплеск «не знаю»: помощник заметно чаще не находит ответ, чем за прошлые 7 дней',
  thumbs_down_spike:
    '⚠️ Всплеск 👎: посетители заметно чаще недовольны ответами, чем за прошлые 7 дней',
  handoff_spike: '⚠️ Всплеск передач человеку относительно прошлых 7 дней',
};

function clip(s: string, max: number): string {
  // Без управляющих символов: текст уходит в Telegram как есть (не HTML).
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fmtDay(day: string): string {
  const [y, m, d] = day.split('-');
  return y && m && d ? `${d}.${m}.${y}` : day;
}

function delta(v: number, prev: number | null): string {
  if (prev === null) return '';
  if (prev === 0) return v === 0 ? ' (как и раньше)' : ' (раньше — 0)';
  const pct = Math.round(((v - prev) / prev) * 100);
  return ` (${pct > 0 ? '+' : ''}${pct}% к прошлому периоду)`;
}

function hours(h: number): string {
  return (Math.round(h * 10) / 10).toString().replace('.', ',');
}

function siteLines(site: SiteDigestFacts, weekly: boolean): string[] {
  const lines: string[] = [];
  lines.push(
    `Диалоги: ${site.dialogs}${delta(site.dialogs, site.dialogsPrev)}`,
  );
  const share =
    site.dialogs > 0
      ? ` (${Math.round((site.resolved / site.dialogs) * 100)}%)`
      : '';
  lines.push(
    `Решено без человека: ${site.resolved}${share} — ≈ ${hours(site.operatorHours)} ч работы оператора (по вашей оценке минут на вопрос)`,
  );
  lines.push(
    `Передачи человеку: ${site.handoffs}${site.handoffsMissed ? `, пропущено: ${site.handoffsMissed}` : ''}`,
  );
  lines.push(`Заявки: ${site.leads}`);
  lines.push(
    `Конверсии: помощник довёл — ${site.conversionsDirect}; с участием помощника (не обязательно благодаря) — ${site.conversionsAssisted}`,
  );
  const gaps: string[] = [];
  if (site.newTopics) gaps.push(`новых непокрытых тем: ${site.newTopics}`);
  if (site.heldVersions)
    gaps.push(`удержанных версий базы: ${site.heldVersions}`);
  if (site.goldenConflicts) {
    gaps.push(
      `конфликтов проверенных ответов с сайтом: ${site.goldenConflicts}`,
    );
  }
  if (gaps.length) lines.push(`Обучение: ${gaps.join('; ')}`);
  else if (!weekly) lines.push('Обучение: новых пробелов нет');
  for (const a of site.alerts) lines.push(ALERT_TEXT[a]);
  return lines;
}

/** Причина «требует проверки» мемо АМ-N — словами (коды admin-memo-review). */
function memoWhy(m: AdminDigestMemo): string {
  switch (m.code) {
    case 'goal_low':
      return 'часто не доходит до цели';
    case 'pin_mismatch':
      return `шаг ${m.step ?? '?'} не находится на странице админки`;
    case 'failures':
      return `сбои на шаге ${m.step ?? '?'} у нескольких сотрудников`;
    default:
      return 'нужна проверка';
  }
}

function adminLines(admin: AdminDigestFacts, weekly: boolean): string[] {
  const lines = [
    '',
    'Раздел «Админка» (видите только вы):',
    `Удержанных версий базы «Админки»: ${admin.heldVersions}`,
    `В карантине за период: ${admin.quarantined}`,
  ];
  // §5-бис.17 п.8: «требует проверки» — строка в дайджесте (мемо сотрудникам
  // не исполняется, пока владелец не исправит и не прогонит его).
  const memos = admin.memosNeedReview ?? [];
  for (const m of memos) {
    lines.push(`⚠️ Мемо АМ-${m.number} требует проверки: ${memoWhy(m)}`);
  }
  const more = (admin.memosNeedReviewTotal ?? memos.length) - memos.length;
  if (more > 0) lines.push(`…и ещё мемо «требует проверки»: ${more}`);
  // Р-З9-20: голова цепочки журнала — внешний якорь, раз в неделю.
  if (weekly && admin.chainHead) {
    lines.push(
      `Журнал действий — контрольная запись на ${fmtDay(admin.chainHead.at.slice(0, 10))}: ` +
        `${admin.chainHead.hash} (id ${admin.chainHead.id}). Сохраните это сообщение и при проверке ` +
        'выгрузите журнал («Журнал» → CSV, последние 50 000 записей): в строке с этим id (колонка id) ' +
        'должен быть тот же hash, а «Перевірити ланцюжок» — «цілий». Хеш другой или строки нет, хотя ей ' +
        'меньше года и записей после неё меньше 50 000, — журнал переписан.',
    );
  }
  return lines;
}

/** Склейка с гарантией предела Telegram: режем по строкам, не посреди слова. */
export function fitTelegram(lines: string[]): string {
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    const add = (out.length ? 1 : 0) + l.length;
    if (len + add > TELEGRAM_TEXT_LIMIT - 2) {
      out.push('…');
      break;
    }
    out.push(l);
    len += add;
  }
  return out.join('\n').slice(0, TELEGRAM_TEXT_LIMIT);
}

export function dailyDigestText(
  site: SiteDigestFacts,
  admin: AdminDigestFacts | null,
): string {
  const lines = [
    `Утренняя сводка — «${clip(site.siteName, SITE_NAME_MAX)}»`,
    `За ${fmtDay(site.period.from)}${site.period.to !== site.period.from ? `–${fmtDay(site.period.to)}` : ''}`,
    '',
    ...siteLines(site, false),
  ];
  if (admin) lines.push(...adminLines(admin, false));
  return fitTelegram(lines);
}

export function weeklyReportText(
  site: SiteDigestFacts,
  admin: AdminDigestFacts | null,
): string {
  const lines = [
    `Отчёт недели — «${clip(site.siteName, SITE_NAME_MAX)}»`,
    `${fmtDay(site.period.from)}–${fmtDay(site.period.to)}`,
    '',
    ...siteLines(site, true),
  ];
  const findings = site.findings
    .map((f) => clip(f, FINDING_MAX))
    .filter(Boolean)
    .slice(0, FINDINGS_MAX);
  if (findings.length) {
    lines.push('', 'Находки недели:');
    for (const f of findings) lines.push(`• ${f}`);
  }
  if (admin) lines.push(...adminLines(admin, true));
  return fitTelegram(lines);
}
