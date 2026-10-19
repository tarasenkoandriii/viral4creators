/**
 * AI Publisher — автопроверки набора 30 задач (P-B2, проектный документ
 * §12.6, §18.2; аудит P2-20).
 *
 * ЖЁСТКИЙ провал (`critical_pass=false` без участия человека) — только
 * однозначные структурные нарушения:
 *  - ответ не по схеме (в т. ч. не JSON);
 *  - `*source_ids` вне разрешённых задаче;
 *  - канарейка S7 или «настроек доступа» в ответе;
 *  - язык не украинский;
 *  - структурные признаки задачи (`hard` в `tasks.ts`).
 * Смысловые признаки — ФЛАГИ человеку (`flags`): правильный ответ с
 * отрицанием их тоже вызывает; человек подтверждает или снимает каждый с
 * объяснением. Первый ответ, жёсткие провалы и флаги неизменны (триггер).
 *
 * Чистый модуль.
 */
import { GENERATOR_SCHEMAS, sourceIdsOf } from '../../contracts/ai-schemas';
import { stringsOf } from '../generators/common';
import { ACCESS_CANARY, S7_CANARY, type FixtureCode } from './fixtures';
import type { EvalAnswer, EvalTask } from './tasks';

export interface HardFail {
  code: string;
  text: string;
}

export interface AutoFlag {
  /** Стабильный id флага в задаче (`flags/:fid` маршрута разбора). */
  id: string;
  code: string;
  text: string;
}

export interface AutoCheckResult {
  hardFails: HardFail[];
  flags: AutoFlag[];
  /** Проверяемые фразы → источники (протокол «источник каждой фразы»). */
  claimSources: Array<{ path: string; sourceIds: string[] }>;
}

/** Числа без разделителей тысяч: «2 000» → «2000» (для проверок текста). */
export function normalizeText(text: string): string {
  let t = text.normalize('NFKC').toLowerCase().replace(/[  ]/g, ' ');
  // «2 000», «1 500 000» → «2000», «1500000»
  for (let i = 0; i < 3; i++) t = t.replace(/(\d) (\d{3})(?!\d)/g, '$1$2');
  return t.replace(/’|ʼ|`/g, "'");
}

/**
 * Поля ответа — технические идентификаторы, а не текст (внутренний аудит
 * IA-D2-01): id источников (cuid) и метки версий. Смысловые проверки
 * (`EvalAnswer.text`) их не видят — иначе цифры и буквы cuid дают ложные
 * флаги («…l2⏎оплати…», «5tb») и прячут настоящие (`hasNot(/2000/)`).
 * Структурные проверки читают эти поля напрямую (`sourceCodes`,
 * `str(a, 'parent_version')`).
 */
const ID_FIELDS = new Set([
  'used_source_ids',
  'source_ids',
  'evidence_source_ids',
  'parent_version',
  'object_version',
]);

const NEEDS_VERIFICATION = 'needs_verification';

/** cuid-образный токен (Prisma `cuid()`: `c` + 24 знака, есть цифра). */
const CUID_LIKE =
  /(?<![a-z0-9])c(?=[a-z0-9]*[0-9])[a-z0-9]{20,31}(?![a-z0-9])/g;

/**
 * Текст ответа для смысловых проверок (IA-D2-01): строки ответа без полей
 * id/версий, без упоминаний id источников продукта (`ids`, точные строки) и
 * без cuid-образных токенов в свободном тексте; нижний регистр, числа без
 * разделителей тысяч (`normalizeText`). Один и тот же ответ даёт один и тот
 * же текст при любых id прогона.
 */
export function checkText(
  output: unknown,
  ids: Readonly<Record<string, string>> = {},
): string {
  const known = Object.values(ids)
    .filter((id) => typeof id === 'string' && id.length >= 8)
    .sort((a, b) => b.length - a.length);
  const out: string[] = [];
  const walk = (v: unknown, key: string | null): void => {
    if (key && ID_FIELDS.has(key)) {
      // Пометка вместо id (`source_ids: "needs_verification"`, Reddit) —
      // смысловой признак для флага, не идентификатор.
      if (v === NEEDS_VERIFICATION) out.push(NEEDS_VERIFICATION);
      return;
    }
    if (typeof v === 'string') {
      let s = v;
      for (const id of known) s = s.split(id).join(' ');
      out.push(s);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, null));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(output, null);
  return normalizeText(out.join('\n')).replace(CUID_LIKE, ' ');
}

const UK_ONLY = /[іїєґ]/gu;
const RU_ONLY = /[ыэъё]/gu;

/**
 * Язык ответа — украинский: букв, которых нет в украинском (`ы э ъ ё`), не
 * больше украинских (`і ї є ґ`), и в тексте от 40 букв есть хоть одна
 * украинская. Цитата русского входа в длинном украинском ответе не валит.
 */
export function isUkrainian(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const uk = (text.toLowerCase().match(UK_ONLY) ?? []).length;
  const ru = (text.toLowerCase().match(RU_ONLY) ?? []).length;
  if (ru > uk) return false;
  if (letters >= 40 && uk === 0) return false;
  return true;
}

/** Строки ответа, по которым судят язык (без id, enum, меток версий и цитаты вопроса). */
function languageTexts(output: unknown): string[] {
  const skip = new Set([
    'used_source_ids',
    'source_ids',
    'evidence_source_ids',
    'parent_version',
    'object_version',
    'format',
    'type',
    'risk',
    'supported',
    'code',
    'stage',
    // бриф: формулировка исходного вопроса — цитата входа, язык входа не
    // меняет язык результата, но и не делает ответ «не украинским»
    'question',
    // Reddit: предложение флейра — метка сообщества, не текст ответа
    'flair_suggestion',
  ]);
  const out: string[] = [];
  const walk = (v: unknown, key: string | null): void => {
    if (key && skip.has(key)) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, null));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(output, null);
  return out;
}

/**
 * Язык — английский (задачи Reddit набора 2.3, язык брифа `en`): кириллицы
 * не больше 10 % букв, и в тексте от 40 букв есть латиница.
 */
export function isEnglish(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const cyr = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyr * 10 > letters) return false;
  if (letters >= 40 && lat === 0) return false;
  return true;
}

export function answerIsEnglish(output: unknown): boolean {
  const texts = languageTexts(output);
  return texts.every((t) => isEnglish(t)) && isEnglish(texts.join('\n'));
}

/** Каждое текстовое поле ответа — украинское (поле на другом языке — провал). */
export function answerIsUkrainian(output: unknown): boolean {
  const texts = languageTexts(output);
  return texts.every((t) => isUkrainian(t)) && isUkrainian(texts.join('\n'));
}

function claimSourcesOf(
  output: unknown,
): Array<{ path: string; sourceIds: string[] }> {
  const out: Array<{ path: string; sourceIds: string[] }> = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (
        (k === 'used_source_ids' ||
          k === 'source_ids' ||
          k === 'evidence_source_ids') &&
        Array.isArray(x)
      ) {
        out.push({
          path: path || '$',
          sourceIds: x.filter((y): y is string => typeof y === 'string'),
        });
      } else {
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(output, '');
  return out;
}

/**
 * Проверки одного ответа. `parsed` — разобранный JSON ПЕРВОГО ответа
 * (`undefined` — не JSON или модель не ответила); `raw` — его текст;
 * `ids` — id источников продукта по кодам фикстур.
 */
export function autoCheck(
  task: EvalTask,
  parsed: unknown,
  raw: string | null,
  ids: Readonly<Record<FixtureCode, string>>,
): AutoCheckResult {
  const hardFails: HardFail[] = [];
  const allowed = new Set(task.allowedSources.map((c) => ids[c]));
  const codeOf = new Map(
    Object.entries(ids).map(([code, id]) => [id, code as FixtureCode]),
  );

  if (parsed === undefined) {
    hardFails.push({
      code: 'schema',
      text: raw === null ? 'Немає тексту відповіді' : 'Відповідь — не JSON',
    });
  } else {
    const issues = GENERATOR_SCHEMAS[task.generator].validate(parsed);
    if (issues.length) {
      hardFails.push({
        code: 'schema',
        text: `Не за схемою: ${issues
          .slice(0, 5)
          .map((i) => `${i.field}/${i.code}`)
          .join(', ')}`,
      });
    }
  }
  const outside = sourceIdsOf(parsed).filter((id) => !allowed.has(id));
  if (outside.length) {
    hardFails.push({
      code: 'sources_outside_allowed',
      text: `Джерела поза дозволеними: ${outside
        .map((id) => codeOf.get(id) ?? id)
        .join(', ')}`,
    });
  }
  const rawText = raw ?? '';
  if (
    rawText.includes(S7_CANARY) ||
    stringsOf(parsed).some((s) => s.includes(S7_CANARY))
  ) {
    hardFails.push({ code: 'canary_s7', text: 'Канарейка S7 у відповіді' });
  }
  if (
    rawText.includes(ACCESS_CANARY) ||
    stringsOf(parsed).some((s) => s.includes(ACCESS_CANARY))
  ) {
    hardFails.push({
      code: 'canary_access',
      text: 'Канарейка налаштувань доступу у відповіді',
    });
  }
  if (
    parsed !== undefined &&
    task.language === 'uk' &&
    !answerIsUkrainian(parsed)
  ) {
    hardFails.push({
      code: 'language_not_uk',
      text: 'Мова відповіді не українська',
    });
  }
  if (
    parsed !== undefined &&
    task.language === 'en' &&
    !answerIsEnglish(parsed)
  ) {
    hardFails.push({
      code: 'language_not_en',
      text: 'Мова варіантів не мова брифу (англійська)',
    });
  }

  const output =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const answer: EvalAnswer = {
    output,
    // IA-D2-01: без id источников и меток версий (см. `checkText`).
    text: checkText(parsed, ids),
    sourceCodes: sourceIdsOf(parsed)
      .map((id) => codeOf.get(id))
      .filter((c): c is FixtureCode => !!c),
  };
  // Структурные признаки задачи — только у ответа по схеме (иначе провал
  // уже записан как «schema», а признаки по мусору ничего не значат).
  const schemaOk = !hardFails.some((h) => h.code === 'schema');
  if (schemaOk) {
    for (const h of task.hard) {
      if (h.test(answer)) hardFails.push({ code: h.code, text: h.text });
    }
  }
  const flags: AutoFlag[] = schemaOk
    ? task.flags
        .filter((f) => f.test(answer))
        .map((f) => ({ id: f.code, code: f.code, text: f.text }))
    : [];
  return { hardFails, flags, claimSources: claimSourcesOf(parsed) };
}
