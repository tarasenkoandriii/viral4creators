/**
 * Тексты утренней сводки и отчёта недели — A (ТЗ §4.15 assist-digest,
 * §5-тер.7). ЧИСТЫЙ модуль: числа → текст сообщения бота ≤ 4 096 символов
 * (предел Telegram; §5-тер.16 п.9 — тест на самом длинном варианте). Язык —
 * получателя (заход 10, Р-З10-14: uk/ru/en, рамка целиком; находки
 * собирает digest.service на том же языке). Раздел «Админка» добавляется
 * ТОЛЬКО если передан (решает
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

/** Язык сообщения — язык получателя (Р-З9-7, заход 10 Р-З10-14). */
export type DigestLang = 'uk' | 'ru' | 'en';
export const DIGEST_LANGS: readonly DigestLang[] = ['uk', 'ru', 'en'];

type Alert = SiteDigestFacts['alerts'][number];

interface DigestTexts {
  dailyTitle: string;
  weeklyTitle: string;
  /** «За 28.09.2026» / «За 28.09.2026–04.10.2026». */
  dayPrefix: string;
  dialogs: string;
  same: string;
  wasZero: string;
  vsPrev: (pct: string) => string;
  resolved: (n: number, share: string, hours: string) => string;
  handoffs: (n: number, missed: string) => string;
  missed: (n: number) => string;
  leads: string;
  conversions: (direct: number, assisted: number) => string;
  learning: string;
  learningNone: string;
  gaps: {
    newTopics: string;
    heldVersions: string;
    goldenConflicts: string;
  };
  alerts: Record<Alert, string>;
  findingsTitle: string;
  admin: {
    title: string;
    held: string;
    quarantined: string;
    memo: (n: number, why: string) => string;
    more: (n: number) => string;
    why: {
      goal_low: string;
      pin_mismatch: (step: string) => string;
      failures: (step: string) => string;
      other: string;
    };
    chain: (day: string, hash: string, id: string) => string;
  };
  /** Кнопка web_app под сообщением. */
  button: string;
  /** Строки, которые собирает digest.service (обучение, передачи). */
  unanswered: (label: string, n: number) => string;
  missedHandoffs: (n: number) => string;
  /** Десятичный разделитель часов. */
  decimal: string;
}

const TEXTS: Record<DigestLang, DigestTexts> = {
  ru: {
    dailyTitle: 'Утренняя сводка',
    weeklyTitle: 'Отчёт недели',
    dayPrefix: 'За',
    dialogs: 'Диалоги',
    same: ' (как и раньше)',
    wasZero: ' (раньше — 0)',
    vsPrev: (pct) => ` (${pct}% к прошлому периоду)`,
    resolved: (n, share, h) =>
      `Решено без человека: ${n}${share} — ≈ ${h} ч работы оператора (по вашей оценке минут на вопрос)`,
    handoffs: (n, missed) => `Передачи человеку: ${n}${missed}`,
    missed: (n) => `, пропущено: ${n}`,
    leads: 'Заявки',
    conversions: (d, a) =>
      `Конверсии: помощник довёл — ${d}; с участием помощника (не обязательно благодаря) — ${a}`,
    learning: 'Обучение',
    learningNone: 'Обучение: новых пробелов нет',
    gaps: {
      newTopics: 'новых непокрытых тем',
      heldVersions: 'удержанных версий базы',
      goldenConflicts: 'конфликтов проверенных ответов с сайтом',
    },
    alerts: {
      unknown_spike:
        '⚠️ Всплеск «не знаю»: помощник заметно чаще не находит ответ, чем за прошлые 7 дней',
      thumbs_down_spike:
        '⚠️ Всплеск 👎: посетители заметно чаще недовольны ответами, чем за прошлые 7 дней',
      handoff_spike: '⚠️ Всплеск передач человеку относительно прошлых 7 дней',
    },
    findingsTitle: 'Находки недели:',
    admin: {
      title: 'Раздел «Админка» (видите только вы):',
      held: 'Удержанных версий базы «Админки»',
      quarantined: 'В карантине за период',
      memo: (n, why) => `⚠️ Мемо АМ-${n} требует проверки: ${why}`,
      more: (n) => `…и ещё мемо «требует проверки»: ${n}`,
      why: {
        goal_low: 'часто не доходит до цели',
        pin_mismatch: (st) => `шаг ${st} не находится на странице админки`,
        failures: (st) => `сбои на шаге ${st} у нескольких сотрудников`,
        other: 'нужна проверка',
      },
      chain: (day, hash, id) =>
        `Журнал действий — контрольная запись на ${day}: ${hash} (id ${id}). Сохраните это сообщение и при проверке ` +
        'выгрузите журнал («Журнал» → CSV, последние 50 000 записей): в строке с этим id (колонка id) ' +
        'должен быть тот же hash, а «Проверить цепочку журнала» — «Цепочка цела». Хеш другой или строки нет, хотя ей ' +
        'меньше года и записей после неё меньше 50 000, — журнал переписан.',
    },
    button: 'Открыть статистику',
    unanswered: (label, n) =>
      `Без ответа: «${label}» — спросили ${n} разных посетителей`,
    missedHandoffs: (n) =>
      `Пропущено передач человеку: ${n} — проверьте рабочие часы и операторов`,
    decimal: ',',
  },
  uk: {
    dailyTitle: 'Ранкове зведення',
    weeklyTitle: 'Звіт тижня',
    dayPrefix: 'За',
    dialogs: 'Діалоги',
    same: ' (як і раніше)',
    wasZero: ' (раніше — 0)',
    vsPrev: (pct) => ` (${pct}% до минулого періоду)`,
    resolved: (n, share, h) =>
      `Вирішено без людини: ${n}${share} — ≈ ${h} год роботи оператора (за вашою оцінкою хвилин на питання)`,
    handoffs: (n, missed) => `Передачі людині: ${n}${missed}`,
    missed: (n) => `, пропущено: ${n}`,
    leads: 'Заявки',
    conversions: (d, a) =>
      `Конверсії: помічник довів — ${d}; за участі помічника (не обов’язково завдяки) — ${a}`,
    learning: 'Навчання',
    learningNone: 'Навчання: нових прогалин немає',
    gaps: {
      newTopics: 'нових непокритих тем',
      heldVersions: 'утриманих версій бази',
      goldenConflicts: 'конфліктів перевірених відповідей із сайтом',
    },
    alerts: {
      unknown_spike:
        '⚠️ Сплеск «не знаю»: помічник помітно частіше не знаходить відповідь, ніж за минулі 7 днів',
      thumbs_down_spike:
        '⚠️ Сплеск 👎: відвідувачі помітно частіше незадоволені відповідями, ніж за минулі 7 днів',
      handoff_spike: '⚠️ Сплеск передач людині порівняно з минулими 7 днями',
    },
    findingsTitle: 'Знахідки тижня:',
    admin: {
      title: 'Розділ «Адмінка» (бачите лише ви):',
      held: 'Утриманих версій бази «Адмінки»',
      quarantined: 'У карантині за період',
      memo: (n, why) => `⚠️ Мемо АМ-${n} потребує перевірки: ${why}`,
      more: (n) => `…і ще мемо «потребує перевірки»: ${n}`,
      why: {
        goal_low: 'часто не доходить до мети',
        pin_mismatch: (st) => `крок ${st} не знаходиться на сторінці адмінки`,
        failures: (st) => `збої на кроці ${st} у кількох співробітників`,
        other: 'потрібна перевірка',
      },
      chain: (day, hash, id) =>
        `Журнал дій — контрольний запис на ${day}: ${hash} (id ${id}). Збережіть це повідомлення і під час перевірки ` +
        'вивантажте журнал («Журнал» → CSV, останні 50 000 записів): у рядку з цим id (колонка id) ' +
        'має бути той самий hash, а «Перевірити ланцюжок журналу» — «Ланцюжок цілий». Хеш інший або рядка немає, хоча йому ' +
        'менше року і записів після нього менше 50 000, — журнал переписано.',
    },
    button: 'Відкрити статистику',
    unanswered: (label, n) =>
      `Без відповіді: «${label}» — запитали ${n} різних відвідувачів`,
    missedHandoffs: (n) =>
      `Пропущено передач людині: ${n} — перевірте робочі години та операторів`,
    decimal: ',',
  },
  en: {
    dailyTitle: 'Morning summary',
    weeklyTitle: 'Weekly report',
    dayPrefix: 'For',
    dialogs: 'Conversations',
    same: ' (same as before)',
    wasZero: ' (was 0)',
    vsPrev: (pct) => ` (${pct}% vs previous period)`,
    resolved: (n, share, h) =>
      `Resolved without a human: ${n}${share} — ≈ ${h} h of operator work (by your minutes-per-question estimate)`,
    handoffs: (n, missed) => `Handoffs to a human: ${n}${missed}`,
    missed: (n) => `, missed: ${n}`,
    leads: 'Leads',
    conversions: (d, a) =>
      `Conversions: driven by the assistant — ${d}; with the assistant involved (not necessarily thanks to it) — ${a}`,
    learning: 'Learning',
    learningNone: 'Learning: no new gaps',
    gaps: {
      newTopics: 'new uncovered topics',
      heldVersions: 'held knowledge versions',
      goldenConflicts: 'verified answers conflicting with the site',
    },
    alerts: {
      unknown_spike:
        '⚠️ “Don’t know” spike: the assistant fails to find an answer noticeably more often than over the previous 7 days',
      thumbs_down_spike:
        '⚠️ 👎 spike: visitors are noticeably more often unhappy with answers than over the previous 7 days',
      handoff_spike: '⚠️ Spike of handoffs to a human vs the previous 7 days',
    },
    findingsTitle: 'Findings of the week:',
    admin: {
      title: '“Admin” section (only you can see it):',
      held: 'Held “Admin” knowledge versions',
      quarantined: 'Quarantined in the period',
      memo: (n, why) => `⚠️ Memo AM-${n} needs review: ${why}`,
      more: (n) => `…and more memos that need review: ${n}`,
      why: {
        goal_low: 'often does not reach the goal',
        pin_mismatch: (st) => `step ${st} is not found on the admin page`,
        failures: (st) => `failures at step ${st} for several employees`,
        other: 'review needed',
      },
      chain: (day, hash, id) =>
        `Action log — checkpoint record as of ${day}: ${hash} (id ${id}). Keep this message; when checking, ` +
        'export the log (“Log” → CSV, last 50,000 records): the row with this id (id column) ' +
        'must have the same hash, and “Verify the log chain” must say “The chain is intact.” A different hash or a missing row, although it is ' +
        'less than a year old and fewer than 50,000 records follow it, means the log was rewritten.',
    },
    button: 'Open statistics',
    unanswered: (label, n) =>
      `Unanswered: “${label}” — asked by ${n} different visitors`,
    missedHandoffs: (n) =>
      `Missed handoffs to a human: ${n} — check working hours and operators`,
    decimal: '.',
  },
};

/** Тексты языка (digest.service собирает ими строки находок и кнопку). */
export function digestTexts(lang: DigestLang): DigestTexts {
  return TEXTS[lang] ?? TEXTS.ru;
}

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

function delta(t: DigestTexts, v: number, prev: number | null): string {
  if (prev === null) return '';
  if (prev === 0) return v === 0 ? t.same : t.wasZero;
  const pct = Math.round(((v - prev) / prev) * 100);
  return t.vsPrev(`${pct > 0 ? '+' : ''}${pct}`);
}

function hours(t: DigestTexts, h: number): string {
  return (Math.round(h * 10) / 10).toString().replace('.', t.decimal);
}

function siteLines(
  t: DigestTexts,
  site: SiteDigestFacts,
  weekly: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(
    `${t.dialogs}: ${site.dialogs}${delta(t, site.dialogs, site.dialogsPrev)}`,
  );
  const share =
    site.dialogs > 0
      ? ` (${Math.round((site.resolved / site.dialogs) * 100)}%)`
      : '';
  lines.push(t.resolved(site.resolved, share, hours(t, site.operatorHours)));
  lines.push(
    t.handoffs(
      site.handoffs,
      site.handoffsMissed ? t.missed(site.handoffsMissed) : '',
    ),
  );
  lines.push(`${t.leads}: ${site.leads}`);
  lines.push(t.conversions(site.conversionsDirect, site.conversionsAssisted));
  const gaps: string[] = [];
  if (site.newTopics) gaps.push(`${t.gaps.newTopics}: ${site.newTopics}`);
  if (site.heldVersions)
    gaps.push(`${t.gaps.heldVersions}: ${site.heldVersions}`);
  if (site.goldenConflicts) {
    gaps.push(`${t.gaps.goldenConflicts}: ${site.goldenConflicts}`);
  }
  if (gaps.length) lines.push(`${t.learning}: ${gaps.join('; ')}`);
  else if (!weekly) lines.push(t.learningNone);
  for (const a of site.alerts) lines.push(t.alerts[a]);
  return lines;
}

/** Причина «требует проверки» мемо АМ-N — словами (коды admin-memo-review). */
function memoWhy(t: DigestTexts, m: AdminDigestMemo): string {
  const step = String(m.step ?? '?');
  switch (m.code) {
    case 'goal_low':
      return t.admin.why.goal_low;
    case 'pin_mismatch':
      return t.admin.why.pin_mismatch(step);
    case 'failures':
      return t.admin.why.failures(step);
    default:
      return t.admin.why.other;
  }
}

function adminLines(
  t: DigestTexts,
  admin: AdminDigestFacts,
  weekly: boolean,
): string[] {
  const lines = [
    '',
    t.admin.title,
    `${t.admin.held}: ${admin.heldVersions}`,
    `${t.admin.quarantined}: ${admin.quarantined}`,
  ];
  // §5-бис.17 п.8: «требует проверки» — строка в дайджесте (мемо сотрудникам
  // не исполняется, пока владелец не исправит и не прогонит его).
  const memos = admin.memosNeedReview ?? [];
  for (const m of memos) lines.push(t.admin.memo(m.number, memoWhy(t, m)));
  const more = (admin.memosNeedReviewTotal ?? memos.length) - memos.length;
  if (more > 0) lines.push(t.admin.more(more));
  // Р-З9-20: голова цепочки журнала — внешний якорь, раз в неделю.
  if (weekly && admin.chainHead) {
    lines.push(
      t.admin.chain(
        fmtDay(admin.chainHead.at.slice(0, 10)),
        admin.chainHead.hash,
        admin.chainHead.id,
      ),
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
  lang: DigestLang = 'ru',
): string {
  const t = digestTexts(lang);
  const lines = [
    `${t.dailyTitle} — «${clip(site.siteName, SITE_NAME_MAX)}»`,
    `${t.dayPrefix} ${fmtDay(site.period.from)}${site.period.to !== site.period.from ? `–${fmtDay(site.period.to)}` : ''}`,
    '',
    ...siteLines(t, site, false),
  ];
  if (admin) lines.push(...adminLines(t, admin, false));
  return fitTelegram(lines);
}

export function weeklyReportText(
  site: SiteDigestFacts,
  admin: AdminDigestFacts | null,
  lang: DigestLang = 'ru',
): string {
  const t = digestTexts(lang);
  const lines = [
    `${t.weeklyTitle} — «${clip(site.siteName, SITE_NAME_MAX)}»`,
    `${fmtDay(site.period.from)}–${fmtDay(site.period.to)}`,
    '',
    ...siteLines(t, site, true),
  ];
  const findings = site.findings
    .map((f) => clip(f, FINDING_MAX))
    .filter(Boolean)
    .slice(0, FINDINGS_MAX);
  if (findings.length) {
    lines.push('', t.findingsTitle);
    for (const f of findings) lines.push(`• ${f}`);
  }
  if (admin) lines.push(...adminLines(t, admin, true));
  return fitTelegram(lines);
}
