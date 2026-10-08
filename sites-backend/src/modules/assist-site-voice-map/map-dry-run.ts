/**
 * Сухой прогон голосовой карты на образцах воркера (Э6-тер (8), заход 9;
 * ТЗ §5-кватер.10 «Публикация → сухой прогон „как Т-2“ без звука») и
 * структурный отпечаток страниц шаблона (§5-кватер.4 «Шаблоны страниц») —
 * ЧИСТАЯ часть; деньги, модель и база — `voice-map-worker.service.ts`.
 *
 *  - команды: на каждую цель — главное имя и 1 синоним на каждом языке
 *    карты, всего ≤ 30 за прогон (сначала цели, изменённые в этой версии);
 *  - на образце (снимок воркера, без кликов и cookie): прямой путь по
 *    карте (`directMapPlan`) → ожидание «выбрана ТА цель, что задала
 *    карта»; прямого пути нет — модель плана (если есть бюджет обучения и
 *    вызов передан), иначе `model_skipped` (публикация этим не
 *    задерживается — ворота кода не откладываются, §4-тер.11);
 *  - запреты Т-2 (`forbiddenProbes`: оплатить, удалить, пароль, оформить,
 *    внешняя ссылка) — ожидание 0 исполнимых шагов;
 *  - отпечаток: множество «роль:тег[+форма][#разметка]» видимых элементов
 *    без текста → хеш; образцы шаблона сравниваются по Жаккару с первым:
 *    < 0.6 — «образец не похож на шаблон» (маска поймала чужие страницы).
 */
import { createHash } from 'crypto';
import type { MemoLang } from '../assist-ui-core/memo';
import {
  buildPlanPrompt,
  parseModelPlan,
  type PlanPrompt,
} from '../assist-ui-core/plan-prompt';
import { checkPlan } from '../assist-ui-core/plan-checks';
import type { UiSnapshot, VoiceControlRules } from '../assist-ui-core/types';
import {
  directMapPlan,
  mapHintsOf,
  resolveVoiceMap,
  targetsForPage,
  templateFor,
  VOICE_MAP_LANGS,
  type VoiceMapContent,
} from '../assist-ui-core/voice-map';
import { forbiddenProbes } from '../assist-ui-core/wizard';

export const DRY_RUN_LIMITS = {
  /** Команд на прогон (§5-кватер.10: ≈ $0.24 при модели на каждую). */
  commands: 30,
  /** Вызовов модели на прогон — только где прямого пути нет. */
  modelCalls: 10,
  /** Похожесть образца на первый образец шаблона (Жаккар скелета). */
  sameTemplate: 0.6,
  /**
   * Аудит P2-3: прогон идёт в обработчике итога воркера — общий срок
   * модели ≈ 25 с (остаток команд — `model_skipped`), вызовов
   * одновременно ≤ 3, каждый — не дольше 12 с и не дольше остатка срока.
   */
  deadlineMs: 25_000,
  concurrency: 3,
  callMs: 12_000,
} as const;

export interface DryRunCommand {
  key: string;
  lang: MemoLang;
  text: string;
  kind: 'name' | 'synonym';
}

/** Набор команд прогона: имя + 1 синоним на язык; изменённые цели — первыми. */
export function dryRunCommands(
  c: VoiceMapContent,
  changed: ReadonlySet<string> = new Set(),
  cap: number = DRY_RUN_LIMITS.commands,
): DryRunCommand[] {
  const active = c.targets.filter(
    (t) => t.status === 'active' && !t.denylisted,
  );
  const ordered = [
    ...active.filter((t) => changed.has(t.key)),
    ...active.filter((t) => !changed.has(t.key)),
  ];
  const out: DryRunCommand[] = [];
  for (const t of ordered)
    for (const lang of VOICE_MAP_LANGS) {
      const name = t.names[lang];
      if (name) out.push({ key: t.key, lang, text: name, kind: 'name' });
      const syn = (t.synonyms[lang] ?? []).find(
        (s) => s.origin !== 'suggested',
      );
      if (syn) out.push({ key: t.key, lang, text: syn.text, kind: 'synonym' });
    }
  return out.slice(0, cap);
}

export type DryRunOutcome =
  /** Прямой путь по карте выбрал ту цель. */
  | 'ok_map'
  /** Модель выбрала ту цель. */
  | 'ok_model'
  /** Выбрана другая цель (конфликт фраз или модель ошиблась). */
  | 'wrong'
  /** Команда назвала цель, а на образце её нет. */
  | 'missing'
  /** Прямого пути нет, модель не звали (бюджет/потолок вызовов). */
  | 'model_skipped'
  /** Модель не построила план (сбой ответа). */
  | 'model_failed';

export interface DryRunCommandResult extends DryRunCommand {
  path: string;
  outcome: DryRunOutcome;
  /** Ключ цели, которую выбрал план (если выбрал). */
  picked: string | null;
}

export interface DryRunReport {
  commands: DryRunCommandResult[];
  forbidden: Array<{
    path: string;
    kind: string;
    blocked: boolean;
    candidates: number;
  }>;
  ok: number;
  failed: number;
  skipped: number;
  /** Все запреты Т-2 на всех образцах дали 0 исполнимых шагов. */
  forbiddenBlocked: boolean;
  modelCalls: number;
}

/**
 * Вызов модели плана; `null` — не звать (нет бюджета) или сбой.
 * `timeoutMs` — сколько осталось на этот вызов (срок прогона).
 */
export type PlanModelCall = (
  prompt: PlanPrompt,
  timeoutMs: number,
) => Promise<string | null>;

/**
 * Прогон на снимках образцов (`pages`: путь → снимок воркера). Команда
 * проверяется на образце, где действует её цель (первый такой образец).
 */
export async function dryRunMap(p: {
  content: VoiceMapContent;
  pages: ReadonlyArray<{ path: string; snapshot: UiSnapshot }>;
  rules: VoiceControlRules;
  hosts: string[];
  changed?: ReadonlySet<string>;
  model?: PlanModelCall | null;
  /** Срок модели и параллельность (тесты сжимают). */
  deadlineMs?: number;
  concurrency?: number;
  clock?: () => number;
}): Promise<DryRunReport> {
  const out: DryRunReport = {
    commands: [],
    forbidden: [],
    ok: 0,
    failed: 0,
    skipped: 0,
    forbiddenBlocked: true,
    modelCalls: 0,
  };
  const clock = p.clock ?? (() => Date.now());
  const until = clock() + (p.deadlineMs ?? DRY_RUN_LIMITS.deadlineMs);
  const results: Array<DryRunCommandResult | null> = [];
  // Команды без прямого пути — модели, после прямого пути (без ожидания).
  const pending: Array<() => Promise<void>> = [];
  for (const cmd of dryRunCommands(p.content, p.changed)) {
    const page = p.pages.find((pg) =>
      targetsForPage(p.content, pg.path).some((t) => t.key === cmd.key),
    );
    if (!page) continue;
    const resolved = resolveVoiceMap(p.content, page.snapshot, page.path);
    const work: UiSnapshot = {
      ...page.snapshot,
      elements: page.snapshot.elements.filter(
        (e) => !resolved.denyRefs.includes(e.ref),
      ),
    };
    const keyOfRef = new Map(resolved.hits.map((h) => [h.ref, h.key]));
    const direct = directMapPlan(cmd.text, resolved);
    const idx = results.length;
    const put = (outcome: DryRunOutcome, picked: string | null) =>
      (results[idx] = { ...cmd, path: page.path, outcome, picked });
    results.push(null);
    if (direct && 'raw' in direct)
      put(direct.key === cmd.key ? 'ok_map' : 'wrong', direct.key);
    else if (direct && 'miss' in direct) put('missing', direct.miss);
    else if (!p.model || pending.length >= DRY_RUN_LIMITS.modelCalls)
      put('model_skipped', null);
    else {
      const model = p.model;
      pending.push(async () => {
        const left = Math.min(DRY_RUN_LIMITS.callMs, until - clock());
        if (left <= 0) return void put('model_skipped', null);
        out.modelCalls++;
        const prompt = buildPlanPrompt({
          transcript: cmd.text,
          snapshot: work,
          map: [],
          lang: cmd.lang,
          voiceMap: resolved.hits.map((h) => ({ ref: h.ref, names: h.names })),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<'late'>((r) => {
          timer = setTimeout(() => r('late'), left);
        });
        const text = await Promise.race([
          model(prompt, left).catch(() => null),
          late,
        ]);
        clearTimeout(timer);
        if (text === 'late') return void put('model_skipped', null);
        const plan = text === null ? null : parseModelPlan(text);
        if (!plan) return void put('model_failed', null);
        const checked = checkPlan({
          transcript: cmd.text,
          snapshot: work,
          map: [],
          steps: plan.steps,
          rules: p.rules,
          hosts: p.hosts,
          state: 'on',
          mapHints: mapHintsOf(resolved),
        });
        const picked =
          checked.steps
            .map((s) => s.target?.ref ?? null)
            .filter((r): r is string => !!r)
            .map((r) => keyOfRef.get(r))
            .find(Boolean) ?? null;
        put(picked === cmd.key ? 'ok_model' : 'wrong', picked);
      });
    }
  }
  // Не больше `concurrency` вызовов модели одновременно.
  let next = 0;
  const worker = async () => {
    while (next < pending.length) await pending[next++]();
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          p.concurrency ?? DRY_RUN_LIMITS.concurrency,
          pending.length,
        ),
      },
      worker,
    ),
  );
  for (const r of results) {
    if (!r) continue;
    if (r.outcome === 'ok_map' || r.outcome === 'ok_model') out.ok++;
    else if (r.outcome === 'model_skipped') out.skipped++;
    else out.failed++;
    out.commands.push(r);
  }
  for (const pg of p.pages) {
    for (const f of forbiddenProbes({
      snapshot: pg.snapshot,
      rules: p.rules,
      hosts: p.hosts,
      lang: 'uk',
    })) {
      out.forbidden.push({
        path: pg.path,
        kind: f.kind,
        blocked: f.blocked,
        candidates: f.candidates,
      });
      if (!f.blocked) out.forbiddenBlocked = false;
    }
  }
  return out;
}

// ── структурный отпечаток (§5-кватер.4 «Шаблоны страниц») ─────────────────

/** Скелет страницы без текста: «роль:тег[+f][#разметка]», без повторов. */
export function pageSkeleton(snapshot: Pick<UiSnapshot, 'elements'>): string[] {
  const set = new Set<string>();
  for (const e of snapshot.elements)
    set.add(
      `${e.role}:${e.tag}${e.inForm ? '+f' : ''}${e.assistId ? `#${e.assistId}` : ''}`,
    );
  return [...set].sort();
}

export function skeletonHash(skeleton: readonly string[]): string {
  return createHash('sha256')
    .update(skeleton.join('|'))
    .digest('base64url')
    .slice(0, 16);
}

/** Похожесть скелетов (Жаккар): 1 — одинаковые, 0 — ничего общего. */
export function skeletonSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

export interface TemplateFingerprint {
  templateId: string;
  pathPattern: string;
  /** Отпечаток первого образца — «отпечаток шаблона». */
  fingerprint: string;
  pages: Array<{
    path: string;
    fingerprint: string;
    similarity: number;
    same: boolean;
  }>;
  /** Есть образцы, не похожие на шаблон (маска ловит чужие страницы). */
  mixed: boolean;
}

/** Отпечатки шаблонов по образцам воркера (страница → шаблон по маске). */
export function templateFingerprints(
  content: VoiceMapContent,
  pages: ReadonlyArray<{ path: string; snapshot: UiSnapshot }>,
): TemplateFingerprint[] {
  const by = new Map<string, TemplateFingerprint & { ref: string[] }>();
  for (const pg of pages) {
    const tpl = templateFor(content, pg.path);
    if (!tpl) continue;
    const sk = pageSkeleton(pg.snapshot);
    const fp = skeletonHash(sk);
    let t = by.get(tpl.id);
    if (!t) {
      t = {
        templateId: tpl.id,
        pathPattern: tpl.pathPattern,
        fingerprint: fp,
        pages: [],
        mixed: false,
        ref: sk,
      };
      by.set(tpl.id, t);
    }
    const sim = Math.round(skeletonSimilarity(t.ref, sk) * 100) / 100;
    const same = sim >= DRY_RUN_LIMITS.sameTemplate;
    t.pages.push({ path: pg.path, fingerprint: fp, similarity: sim, same });
    if (!same) t.mixed = true;
  }
  return [...by.values()].map(({ ref: _ref, ...t }) => t);
}
