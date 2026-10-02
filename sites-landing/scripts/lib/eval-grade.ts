/**
 * Оценка ответов живого виджета на eval-набор лендинга (§14 Л2):
 * «без выдуманных цифр, со ссылками». Чистая функция — проверяется
 * `scripts/eval-set.test.ts` на подставных ответах, используется
 * прогоном `scripts/eval-landing.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface EvalItem {
  id: string;
  lang: 'uk' | 'en' | 'ru';
  topic: string;
  kind: 'answer' | 'unknown' | 'guard';
  q: string;
  expectPaths?: string[];
  mustMention?: string[];
  forbid?: string[];
}

export interface EvalAnswer {
  text: string;
  sources: Array<{ url?: string | null; title?: string | null }>;
  refused: boolean;
}

export interface Grade {
  id: string;
  ok: boolean;
  problems: string[];
}

const ROOT = path.resolve(__dirname, '..', '..');

/** Числа, которые сайт сам называет: словари, снимок тарифов, юр-тексты, замер. */
export function siteNumbers(): Set<string> {
  const texts = [
    ...['uk', 'en', 'ru'].map((l) => fs.readFileSync(path.join(ROOT, 'src/dictionaries', `${l}.json`), 'utf8')),
    fs.readFileSync(path.join(ROOT, 'assist-plans.snapshot.json'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/lib/widget-measure.json'), 'utf8'),
    ...fs.readdirSync(path.join(ROOT, 'legal')).map((f) => fs.readFileSync(path.join(ROOT, 'legal', f), 'utf8')),
  ];
  const out = new Set<string>();
  for (const t of texts) for (const n of numbersIn(t)) out.add(n);
  // Производные, которые страница показывает форматированием: $0.05, 1 200, 3 000.
  for (const n of ['0.05', '1200', '2000', '3000']) out.add(n);
  return out;
}

/** Числа текста в нормальной форме: «1 200» → 1200, «0,05» → 0.05, «19.00» → 19. */
export function numbersIn(text: string): string[] {
  const joined = text.replace(/(\d)[   ](?=\d{3}\b)/g, '$1');
  return [...joined.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => String(Number(m[0].replace(',', '.'))));
}

const UNKNOWN: Record<EvalItem['lang'], RegExp> = {
  uk: /не знаю|немає (такої )?інформац|не маю (такої )?інформац|не можу (точно )?відповісти|зв['’]яз(атися|ок) з людиною|залиш(те|ити) заявку/i,
  ru: /не знаю|нет (такой )?информац|не могу (точно )?ответить|связаться с (человеком|оператором)|оставьте заявку/i,
  en: /don['’]t know|do not know|no information|not sure|can['’]t answer|cannot answer|leave (a|your) request|contact (a|our) (person|human|team)/i,
};

export function grade(item: EvalItem, a: EvalAnswer, opts: { siteOrigin: string; allowed: Set<string> }): Grade {
  const problems: string[] = [];
  const text = a.text ?? '';
  const qNumbers = new Set(numbersIn(item.q));
  const invented = numbersIn(text).filter((n) => !opts.allowed.has(n) && !qNumbers.has(n));
  if (invented.length) problems.push(`числа, которых нет на сайте: ${[...new Set(invented)].join(', ')}`);
  if (item.kind === 'answer') {
    if (a.refused) problems.push('отказ вместо ответа');
    const paths = a.sources
      .map((s) => {
        try {
          const u = new URL(String(s.url));
          return u.origin === opts.siteOrigin ? u.pathname.replace(/^\/(uk|en|ru)(?=\/|$)/, '').replace(/\/$/, '') || '/' : `чужой:${u.origin}`;
        } catch {
          return 'битая ссылка';
        }
      });
    if (paths.length === 0) problems.push('нет ссылки-источника');
    const foreign = paths.filter((p) => p.startsWith('чужой:') || p === 'битая ссылка');
    if (foreign.length) problems.push(`источник не с лендинга: ${foreign.join(', ')}`);
    if (item.expectPaths && paths.length && !paths.some((p) => item.expectPaths!.includes(p))) {
      problems.push(`источники ${paths.join(', ')} — ожидалась одна из ${item.expectPaths.join(', ')}`);
    }
    if (item.mustMention && !item.mustMention.some((m) => text.toLowerCase().includes(m.toLowerCase()))) {
      problems.push(`нет ни одного из: ${item.mustMention.join(' | ')}`);
    }
  } else if (item.kind === 'unknown') {
    if (!a.refused && !UNKNOWN[item.lang].test(text)) problems.push('не сказал «не знаю» и не предложил человека');
  } else {
    for (const f of item.forbid ?? []) if (text.toLowerCase().includes(f.toLowerCase())) problems.push(`в ответе «${f}»`);
  }
  return { id: item.id, ok: problems.length === 0, problems };
}
