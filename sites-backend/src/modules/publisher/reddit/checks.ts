/**
 * AI Publisher, P-R M2 — детерминированная проверка Reddit-версии
 * `reddit_policy` (reddit-manual-mvp-adapted.md §M2.4, Р-RD-8; AT-RD-07,
 * AT-RD-08). Чистая функция без базы, сети и LLM: вход собирает
 * `reddit-port.ts`, результат пишет P-B1 (`pub_qa_checks`, актёр
 * `system:reddit-policy`) при заморозке версии, перед согласованием, перед
 * копированием и по `POST …/reddit/contents/:cid/check`.
 *
 * BLOCK → `blockers` (`result='fail'`), WARN → `warnings` (подтверждаются
 * при согласовании). Таблица §M2.4 построчно:
 *  - актуальность правил (`policyGate`) и снимок версии = текущий;
 *  - реклама при `promotion_prohibited` (гейт);
 *  - ссылки против `linksPolicy` (BLOCK prohibited/unknown, WARN restricted)
 *    и против брифа (`linksAllowed=false` → BLOCK);
 *  - раскрытие аффилированности (A08, Р-RD-65): ≥ 20 знаков, маркер
 *    аффилированности и бренд брифа, в первых 300 знаках ВИДИМОГО текста;
 *    аффилированность — замороженной версии (`meta.affiliation`, Р-RD-66);
 *  - неподтверждённые факты (`claimMap`): `needs_verification` с числом или
 *    обещанием — BLOCK, без них — WARN; источник не allowed/отозван/не
 *    продукта/доказательство P-R — BLOCK; числа и гарантии ТЕЛА без пункта
 *    с разрешённым источником (и не из контекста брифа/оффера) — BLOCK
 *    (Р-RD-67); запрещённые брифом утверждения — после нормализации;
 *  - фальшивые отзывы (A07): маркеры личного опыта при `affiliation ≠
 *    customer`, цитата «клиента» без источника;
 *  - ПД: контакты, ники и профили в title/body/disclosure/claimMap;
 *  - дубли (Жаккар ≥ 0,6 за 90 дней) — WARN; оскорбления — WARN;
 *  - comment без треда/выдержки — BLOCK; обязательный флейр без
 *    предложения — WARN.
 * Формулировок «соответствует правилам Reddit» нет: «проверки P-R пройдены
 * на снимке правил vN».
 *
 * Раунд 2 M2 (`markers@3`, Р-RD-74…82): BLOCK — только при высокой
 * уверенности, неоднозначное — WARN (подтверждается при согласовании):
 *  - ссылки: явная ссылка/обход — BLOCK, голый `слово.зона` — WARN
 *    `reddit_link_suspect` (там, где ссылки нельзя);
 *  - раскрытие: отрицание или чужая роль — BLOCK `reddit_disclosure_negated`,
 *    бренд есть, а роль неясна — WARN `reddit_disclosure_unclear`;
 *  - числа результата (проценты, деньги, множители, число рядом со словом
 *    результата) — BLOCK без пункта claimMap о том же утверждении; число
 *    только из контекста брифа/оффера — WARN `reddit_claim_from_brief`;
 *  - гарантия — WARN `reddit_guarantee`, BLOCK вместе с числом результата;
 *  - личный опыт с брендом — BLOCK, без связи с продуктом — WARN
 *    `reddit_personal_experience`;
 *  - контакт — правило Reddit-текста (`redditContact`): `@scope/pkg`,
 *    `pkg@1.2.3`, `git@host:repo` — не контакт.
 */
import type {
  QaBlocker,
  QaFindingParams,
  QaWarning,
} from '../contracts/content-api';
import type { RedditAffiliation } from '../contracts/states';
import {
  DISCLOSURE_WARN_ISSUES,
  DUPLICATE_JACCARD,
  containsPhrase,
  disclosureIssue,
  guaranteesIn,
  hasCustomerQuote,
  hasPromise,
  jaccard,
  linkFindings,
  normText,
  offensiveWords,
  personalExperience,
  redditContact,
  resultNumbersIn,
  sameNumber,
  sameStatement,
  sentencesOf,
  wordSet,
  type ResultNumber,
} from './markers';
import { hasProfileRef } from './normalize';
import { policyGate, type PolicySnapshot } from './policy';

/** Коды BLOCK проверки (`QaBlocker.code`). */
export const REDDIT_CHECK_BLOCKERS = [
  'reddit_rules_missing',
  'reddit_rules_unreviewed',
  'reddit_rules_stale',
  'reddit_rules_source_revoked',
  'reddit_rules_changed',
  'reddit_promotion_prohibited',
  'reddit_promotion_unknown',
  'reddit_links_unknown',
  'reddit_links_prohibited',
  'reddit_links_not_allowed',
  'reddit_disclosure_missing',
  'reddit_disclosure_negated',
  'reddit_unverified_claim',
  'reddit_source_not_allowed',
  'reddit_forbidden_claim',
  'reddit_fake_testimonial',
  'reddit_pii',
  'reddit_thread_missing',
] as const;
export type RedditCheckBlocker = (typeof REDDIT_CHECK_BLOCKERS)[number];

/** Коды WARN проверки (`QaWarning.code`). */
export const REDDIT_CHECK_WARNINGS = [
  'reddit_links_restricted',
  'reddit_claim_needs_verification',
  'reddit_duplicate',
  'reddit_offensive',
  'reddit_flair_missing',
  'reddit_link_suspect',
  'reddit_disclosure_unclear',
  'reddit_claim_from_brief',
  'reddit_guarantee',
  'reddit_personal_experience',
] as const;
export type RedditCheckWarning = (typeof REDDIT_CHECK_WARNINGS)[number];

export interface RedditClaim {
  text: string;
  sourceIds: string[] | 'needs_verification';
}

/** Что известно об источнике пункта claimMap (нет в карте — нет в продукте). */
export interface ClaimSourceState {
  usage: string;
  origin: string;
}

export interface RedditCheckInput {
  contentType: 'post' | 'comment';
  title: string | null;
  body: string;
  disclosure: string;
  flairSuggestion: string | null;
  claimMap: RedditClaim[];
  /** Снимок, на котором собрана версия (`meta.ruleSnapshotId`). */
  versionSnapshotId: string | null;
  brief: {
    /** Аффилированность ЗАМОРОЖЕННОЙ версии (`meta.affiliation`, Р-RD-66). */
    affiliation: RedditAffiliation | null;
    linksAllowed: boolean;
    forbiddenClaims: string[];
    /** Имя продукта/бренда для раскрытия (бриф, Р-RD-65); null — не задано. */
    brand: string | null;
  };
  /**
   * Контекст, цель и тезисы брифа, текст активного оффера: число результата
   * только отсюда (без пункта claimMap) — WARN `reddit_claim_from_brief`
   * (раунд 2, Р-RD-78; раньше — допуск).
   */
  contextTexts: string[];
  /** Текущий снимок сообщества (null — правил нет). */
  snapshot:
    (PolicySnapshot & { id: string; flairRequired: boolean | null }) | null;
  now: Date;
  staleDays: number;
  /** Тред брифа (comment): URL возможности и наличие выдержки. */
  thread: { url: string | null; hasExcerpt: boolean } | null;
  sources: ReadonlyMap<string, ClaimSourceState>;
  /** Тексты других Reddit-версий продукта за 90 дней (дубли). */
  others: ReadonlyArray<{ versionId: string; text: string }>;
}

export interface RedditCheckResult {
  result: 'pass' | 'fail';
  blockers: QaBlocker[];
  warnings: QaWarning[];
}

/** Коды гейта → коды BLOCK. */
const GATE_BLOCK: Record<string, RedditCheckBlocker> = {
  rules_missing: 'reddit_rules_missing',
  rules_unreviewed: 'reddit_rules_unreviewed',
  rules_stale: 'reddit_rules_stale',
  rules_source_revoked: 'reddit_rules_source_revoked',
  promotion_prohibited: 'reddit_promotion_prohibited',
  promotion_unknown: 'reddit_promotion_unknown',
  links_unknown: 'reddit_links_unknown',
  links_prohibited: 'reddit_links_prohibited',
};

export function redditChecks(i: RedditCheckInput): RedditCheckResult {
  const blockers = new Map<RedditCheckBlocker, QaBlocker | QaWarning>();
  const warnings = new Map<RedditCheckWarning, QaWarning>();
  // Раунд 4 (аудит экранов S3-4): находка — `{code, text: code, params}`;
  // параметры машиночитаемые, тексты делает клиент; повторный код
  // объединяет списки параметров.
  const put = <C extends string>(
    m: Map<C, QaBlocker | QaWarning>,
    code: C,
    params: QaFindingParams = {},
  ) => {
    const prev = m.get(code);
    if (!prev) {
      m.set(code, { code, text: code, params });
      return;
    }
    const merged: QaFindingParams = { ...(prev.params ?? {}) };
    for (const [k, v] of Object.entries(params)) {
      const old = merged[k];
      merged[k] =
        Array.isArray(old) && Array.isArray(v)
          ? ([...new Set([...old, ...v])] as QaFindingParams[string])
          : (old ?? v);
    }
    prev.params = merged;
  };
  const block = (code: RedditCheckBlocker, params?: QaFindingParams) =>
    put(blockers, code, params);
  const warn = (code: RedditCheckWarning, params?: QaFindingParams) =>
    put(warnings, code, params);
  const text = [i.title ?? '', i.body].join('\n');
  const found = linkFindings(text);
  const linkList = found.links;
  const links = linkList.length > 0;

  // Правила: гейт по текущему снимку и снимок версии.
  const gate = policyGate(i.snapshot, i.now, i.staleDays, i.contentType, links);
  for (const r of gate.reasons) {
    const code = GATE_BLOCK[r];
    if (code)
      block(code, r === 'links_prohibited' ? { found: linkList } : undefined);
  }
  if (gate.warnings.includes('links_restricted'))
    warn('reddit_links_restricted');
  if (i.snapshot && i.versionSnapshotId !== i.snapshot.id)
    block('reddit_rules_changed');
  if (links && !i.brief.linksAllowed)
    block('reddit_links_not_allowed', { found: linkList });
  // Голый «слово.зона» (Р-RD-79): там, где ссылки нельзя, — WARN.
  const linksClosed =
    !i.brief.linksAllowed ||
    !i.snapshot ||
    i.snapshot.linksPolicy !== 'allowed';
  if (found.suspect.length && linksClosed)
    warn('reddit_link_suspect', { found: found.suspect });

  // Раскрытие аффилированности (A08, Р-RD-65, Р-RD-75): роль без
  // отрицания и бренд целым словом в первых 300 знаках видимого текста.
  const aff = i.brief.affiliation;
  if (aff === null)
    block('reddit_disclosure_missing', { reason: 'affiliation_missing' });
  else if (aff !== 'none') {
    const issue = disclosureIssue(
      i.body,
      i.disclosure,
      i.brief.brand,
      aff,
      i.contentType === 'post' ? i.title : null,
    );
    if (issue === 'negated') block('reddit_disclosure_negated');
    else if (issue && DISCLOSURE_WARN_ISSUES.includes(issue))
      warn('reddit_disclosure_unclear');
    else if (issue === 'no_brand' && i.brief.brand)
      // Раунд 3 (S3-R2-4): подсказка — бренд так, как он записан в брифе.
      block('reddit_disclosure_missing', {
        reason: issue,
        brand: i.brief.brand.trim(),
      });
    else if (issue) block('reddit_disclosure_missing', { reason: issue });
  }

  // Неподтверждённые факты и источники.
  const supported: RedditClaim[] = [];
  for (const [k, c] of i.claimMap.entries()) {
    if (c.sourceIds === 'needs_verification') {
      if (resultNumbersIn(c.text).length || guaranteesIn(c.text).length)
        block('reddit_unverified_claim', { claims: [k] });
      else warn('reddit_claim_needs_verification', { claims: [k] });
      continue;
    }
    let ok = c.sourceIds.length > 0;
    for (const id of c.sourceIds) {
      const s = i.sources.get(id);
      if (!s || s.origin !== 'content' || s.usage !== 'allowed') {
        block('reddit_source_not_allowed', { claims: [k] });
        ok = false;
      }
    }
    if (ok) supported.push(c);
  }
  // Числа результата и гарантии ТЕЛА (Р-RD-67, Р-RD-78, Р-RD-80): число —
  // только с пунктом claimMap (разрешённый источник) о ТОМ ЖЕ утверждении;
  // только из контекста брифа/оффера — WARN; гарантия — WARN, вместе с
  // числом результата — BLOCK.
  const claimNums = supported.map((c) => resultNumbersIn(c.text));
  const contextNums = i.contextTexts.flatMap((t) => resultNumbersIn(t));
  const claimWords = supported.map((c) => wordSet(c.text));
  const brand = i.brief.brand;
  const unverified: string[] = [];
  const fromBrief: string[] = [];
  const guarantees: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const nums = resultNumbersIn(sentence);
    for (const n of nums) {
      const backed = supported.some(
        (c, k) =>
          claimNums[k].some((x: ResultNumber) => sameNumber(x, n)) &&
          sameStatement(sentence, c.text, brand),
      );
      if (backed) continue;
      if (contextNums.some((x) => sameNumber(x, n))) fromBrief.push(n.raw);
      else unverified.push(n.raw);
    }
    const g = guaranteesIn(sentence);
    if (!g.length) continue;
    const words = wordSet(sentence);
    const backed = supported.some(
      (c, k) =>
        hasPromise(c.text) &&
        (normText(sentence).includes(normText(c.text)) ||
          jaccard(words, claimWords[k]) >= 0.5),
    );
    if (backed) continue;
    if (nums.length) unverified.push(...g);
    else guarantees.push(...g);
  }
  if (unverified.length)
    block('reddit_unverified_claim', { found: [...new Set(unverified)] });
  if (fromBrief.length)
    warn('reddit_claim_from_brief', { found: [...new Set(fromBrief)] });
  if (guarantees.length)
    warn('reddit_guarantee', { found: [...new Set(guarantees)] });
  // Запрещённые брифом утверждения — после нормализации, обе свёртки.
  for (const f of i.brief.forbiddenClaims)
    if (containsPhrase(text, f)) block('reddit_forbidden_claim');

  // Фальшивые отзывы (A07, Р-RD-82): личный опыт с продуктом брифа — BLOCK,
  // личный опыт без связи с продуктом — WARN.
  if (aff !== 'customer') {
    const pe = personalExperience(text, brand);
    if (pe === 'tied') block('reddit_fake_testimonial');
    else if (pe === 'loose') warn('reddit_personal_experience');
  }
  if (
    hasCustomerQuote(text) &&
    !i.claimMap.some((c) => Array.isArray(c.sourceIds) && c.sourceIds.length)
  )
    block('reddit_fake_testimonial');

  // ПД: контакты, ники, профили (и в тексте пунктов claimMap, S3-7).
  for (const t of [
    i.title,
    i.body,
    i.disclosure,
    ...i.claimMap.map((c) => c.text),
  ]) {
    if (t && (redditContact(t) || hasProfileRef(t))) block('reddit_pii');
  }

  // Дубли и оскорбления — WARN.
  const mine = wordSet(text);
  if (i.others.some((o) => jaccard(mine, wordSet(o.text)) >= DUPLICATE_JACCARD))
    warn('reddit_duplicate');
  if (offensiveWords(text).length) warn('reddit_offensive');

  // Контекст треда (comment) и флейр.
  if (
    i.contentType === 'comment' &&
    (!i.thread || !i.thread.url || !i.thread.hasExcerpt)
  )
    block('reddit_thread_missing');
  if (i.snapshot?.flairRequired === true && !i.flairSuggestion?.trim())
    warn('reddit_flair_missing');

  const order = <T extends string>(list: readonly T[], m: Map<T, unknown>) =>
    list.filter((c) => m.has(c));
  const b = order(REDDIT_CHECK_BLOCKERS, blockers).map((c) => blockers.get(c)!);
  const w = order(REDDIT_CHECK_WARNINGS, warnings).map((c) => warnings.get(c)!);
  return { result: b.length ? 'fail' : 'pass', blockers: b, warnings: w };
}
