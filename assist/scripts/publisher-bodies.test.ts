/**
 * AI Publisher (P-G, аудит S2) — тела ВСЕХ мутаций клиента кабинета против
 * типов `*Body` контрактов бэкенда, на уровне типов: `tsc -p
 * tsconfig.scripts.json` падает, если параметр-тело метода клиента
 *  - содержит ключ, которого нет в `*Body` (как `approverDisplayName`);
 *  - не требует ключ, обязательный в `*Body`, или тип значения шире
 *    (как `reason?: 'manual' | 'other'` при `reason?: 'manual'`).
 * `opKey` кладёт `PublisherHttp` (в параметре его нет). Методы со
 * скалярными аргументами (`revokeSource(id, reason)` и т. п.) тело строят
 * сами — их проверяют в рантайме `publisher-api.test.ts` и
 * `publisher-ops-api.test.ts` (каждое пойманное тело = `*Body`).
 * Рантайм-часть файла — проверка, что сверка не пуста и не слепа.
 */
import assert from 'node:assert/strict';
import type { RevisionedBody } from '../../sites-backend/src/modules/publisher/contracts/common';
import type * as AiC from '../../sites-backend/src/modules/publisher/contracts/ai-api';
import type * as CoC from '../../sites-backend/src/modules/publisher/contracts/content-api';
import type * as CrC from '../../sites-backend/src/modules/publisher/contracts/core-api';
import type * as DiC from '../../sites-backend/src/modules/publisher/contracts/distribution-api';
import type * as LeC from '../../sites-backend/src/modules/publisher/contracts/leads-api';
import type * as ReC from '../../sites-backend/src/modules/publisher/contracts/reports-api';
import type * as RdC from '../../sites-backend/src/modules/publisher/contracts/reddit-api';
import type { createAiApi } from '../src/lib/publisher/ai-api';
import type { createCalendarApi } from '../src/lib/publisher/calendar-api';
import type {
  ApproveIn,
  FactDecisionIn,
  createContentApi,
} from '../src/lib/publisher/content-api';
import type { createCoreApi } from '../src/lib/publisher/core-api';
import type {
  PlacementStepIn,
  createDistributionApi,
} from '../src/lib/publisher/distribution-api';
import type { createLeadsApi } from '../src/lib/publisher/leads-api';
import type { createReportsApi } from '../src/lib/publisher/reports-api';
import type { createRedditApi } from '../src/lib/publisher/reddit-api';
import type { createRedditStudioApi } from '../src/lib/publisher/reddit-studio-api';
import { bodyIssuesOf, contractSrc, routesOf } from './publisher-contract-lib';
import type { PublisherHttp } from '../src/lib/publisher/common-api';
import { createAiApi as createAiApiRt } from '../src/lib/publisher/ai-api';
import { createCalendarApi as createCalendarApiRt } from '../src/lib/publisher/calendar-api';
import { createContentApi as createContentApiRt } from '../src/lib/publisher/content-api';
import { createCoreApi as createCoreApiRt } from '../src/lib/publisher/core-api';
import { createDistributionApi as createDistributionApiRt } from '../src/lib/publisher/distribution-api';
import { createLeadsApi as createLeadsApiRt } from '../src/lib/publisher/leads-api';
import { createReportsApi as createReportsApiRt } from '../src/lib/publisher/reports-api';
import { createRedditApi as createRedditApiRt } from '../src/lib/publisher/reddit-api';
import { createRedditStudioApi as createRedditStudioApiRt } from '../src/lib/publisher/reddit-studio-api';

// ── Помощники типов ─────────────────────────────────────────────────────
type NoOp<B> = Omit<B, 'opKey'>;
/** Тело-параметр метода: единственный объектный аргумент. */
type BodyOf<F> = F extends (...a: infer A) => unknown
  ? Exclude<Extract<A[number], object>, undefined>
  : never;
/** Ключи клиента ⊆ ключей контракта и клиент присваиваем контракту. */
type Fits<Client, Contract> = [Exclude<keyof Client, keyof Contract>] extends [
  never,
]
  ? [Client] extends [NoOp<Contract>]
    ? true
    : { notAssignable: Client; to: NoOp<Contract> }
  : { extraKeys: Exclude<keyof Client, keyof Contract> };
/** Компилируется только при `true`; иначе tsc покажет расхождение. */
function ok<T extends true>(name: string, proof?: T): void {
  void proof;
  names.push(name);
}
const names: string[] = [];

type Co = ReturnType<typeof createCoreApi>;
type Ct = ReturnType<typeof createContentApi>;
type Ai = ReturnType<typeof createAiApi>;
type Ca = ReturnType<typeof createCalendarApi>;
type Di = ReturnType<typeof createDistributionApi>;
type Le = ReturnType<typeof createLeadsApi>;
type Re = ReturnType<typeof createReportsApi>;
type Rd = ReturnType<typeof createRedditApi>;
type St = ReturnType<typeof createRedditStudioApi>;

// ── Ядро (P-G1) ─────────────────────────────────────────────────────────
ok<Fits<BodyOf<Co['createProduct']>, CrC.CreateProductBody>>('createProduct');
ok<Fits<BodyOf<Co['rename']>, CrC.RenameProductBody>>('rename');
ok<Fits<BodyOf<Co['changeMode']>, CrC.ChangeModeBody>>('changeMode');
ok<Fits<BodyOf<Co['decide']>, CrC.DecisionBody>>('decide');
ok<Fits<BodyOf<Co['grant']>, CrC.GrantBody>>('grant');
ok<Fits<BodyOf<Co['resolveTask']>, CrC.ResolveTaskBody>>('resolveTask');
ok<Fits<BodyOf<Co['assignTask']>, CrC.AssignTaskBody>>('assignTask');

// ── Содержание (P-G1) ───────────────────────────────────────────────────
ok<Fits<BodyOf<Ct['createSource']>, CoC.CreateSourceBody>>('createSource');
ok<Fits<BodyOf<Ct['importUrl']>, CoC.ImportUrlBody>>('importUrl');
ok<Fits<BodyOf<Ct['patchSource']>, CoC.PatchSourceBody>>('patchSource');
ok<Fits<BodyOf<Ct['createQuestion']>, CoC.CreateQuestionBody>>(
  'createQuestion'
);
ok<Fits<BodyOf<Ct['patchQuestion']>, CoC.PatchQuestionBody>>('patchQuestion');
ok<Fits<BodyOf<Ct['createGroup']>, CoC.CreateQuestionGroupBody>>('createGroup');
ok<Fits<BodyOf<Ct['patchGroup']>, CoC.PatchQuestionGroupBody>>('patchGroup');
ok<Fits<BodyOf<Ct['createFact']>, CoC.CreateBrandFactBody>>('createFact');
ok<Fits<FactDecisionIn['activate'], CoC.ActivateFactBody>>('fact activate');
ok<Fits<FactDecisionIn['resolve'], CoC.ResolveFactBody>>('fact resolve');
ok<Fits<FactDecisionIn['retire'], CoC.RetireFactBody>>('fact retire');
ok<Fits<BodyOf<Ct['createOffer']>, CoC.CreateOfferBody>>('createOffer');
ok<Fits<BodyOf<Ct['createBrief']>, CoC.CreateBriefBody>>('createBrief');
ok<Fits<BodyOf<Ct['patchBrief']>, CoC.PatchBriefBody>>('patchBrief');
ok<Fits<BodyOf<Ct['createContent']>, CoC.CreateContentBody>>('createContent');
ok<Fits<BodyOf<Ct['patchContent']>, CoC.PatchContentBody>>('patchContent');
ok<Fits<BodyOf<Ct['transition']>, CoC.TransitionBody>>('transition');
ok<Fits<BodyOf<Ct['createVersion']>, CoC.CreateVersionBody>>('createVersion');
ok<Fits<BodyOf<Ct['patchVersion']>, CoC.PatchVersionBody>>('patchVersion');
ok<Fits<BodyOf<Ct['createClaim']>, CoC.CreateClaimBody>>('createClaim');
ok<Fits<BodyOf<Ct['patchClaim']>, CoC.PatchClaimBody>>('patchClaim');
ok<Fits<BodyOf<Ct['claimSource']>, CoC.ClaimSourceBody>>('claimSource');
ok<Fits<BodyOf<Ct['verifyClaim']>, CoC.VerifyClaimBody>>('verifyClaim');
ok<Fits<BodyOf<Ct['qaCheck']>, CoC.QaCheckBody>>('qaCheck');
ok<Fits<ApproveIn, CoC.ApproveBody>>('approve');

// ── AI (P-G1) ───────────────────────────────────────────────────────────
ok<Fits<BodyOf<Ai['helperAnswer']>, AiC.HelperAnswerBody>>('helperAnswer');
ok<Fits<BodyOf<Ai['briefDraft']>, AiC.BriefDraftBody>>('briefDraft');
ok<Fits<BodyOf<Ai['adaptationDraft']>, AiC.AdaptationDraftBody>>(
  'adaptationDraft'
);
ok<Fits<BodyOf<Ai['configDecision']>, AiC.ConfigDecisionBody>>(
  'configDecision'
);
ok<Fits<BodyOf<Ai['resolveFlag']>, AiC.FlagResolutionBody>>('resolveFlag');
ok<Fits<BodyOf<Ai['reviewResult']>, AiC.ResultReviewBody>>('reviewResult');

// ── Календарь (P-G1) ────────────────────────────────────────────────────
ok<Fits<BodyOf<Ca['createAction']>, DiC.CreateActionBody>>('createAction');
ok<Fits<BodyOf<Ca['actionTransition']>, DiC.ActionTransitionBody>>(
  'actionTransition'
);
ok<Fits<BodyOf<Ca['createPublication']>, DiC.CreatePublicationBody>>(
  'createPublication'
);
ok<Fits<BodyOf<Ca['verifyPublication']>, DiC.VerifyPublicationBody>>(
  'verifyPublication'
);

ok<Fits<BodyOf<Ca['createChannel']>, DiC.CreateChannelBody>>('createChannel');
ok<Fits<BodyOf<Ca['patchChannel']>, DiC.PatchChannelBody>>('patchChannel');
ok<Fits<BodyOf<Ca['publicationTransition']>, DiC.PublicationTransitionBody>>(
  'publicationTransition'
);

// ── Площадки, закупки, бюджет (P-G2) ────────────────────────────────────
ok<Fits<BodyOf<Di['createVenue']>, DiC.CreateVenueBody>>('createVenue');
// `expectedRevision` у PATCH — отдельный аргумент метода.
type Rev = { expectedRevision: number };
ok<Fits<BodyOf<Di['patchVenue']> & Rev, DiC.PatchVenueBody>>('patchVenue');
ok<Fits<BodyOf<Di['venueTransition']>, DiC.VenueTransitionBody>>(
  'venueTransition'
);
ok<Fits<BodyOf<Di['createPlacement']>, DiC.CreatePlacementBody>>(
  'createPlacement'
);
ok<Fits<BodyOf<Di['patchPlacement']> & Rev, DiC.PatchPlacementBody>>(
  'patchPlacement'
);
ok<Fits<PlacementStepIn['approve'], DiC.ApprovePlacementBody>>('approve pl');
ok<Fits<PlacementStepIn['reserve'], RevisionedBody>>('reserve');
ok<Fits<PlacementStepIn['order'], DiC.OrderBody>>('order');
ok<Fits<PlacementStepIn['publication'], DiC.AwaitPublicationBody>>(
  'publication'
);
ok<Fits<PlacementStepIn['published'], DiC.PlacementPublishedBody>>('published');
ok<Fits<PlacementStepIn['verify'], DiC.PlacementVerifyBody>>('verify');
ok<Fits<PlacementStepIn['dispute'], DiC.DisputeBody>>('dispute');
ok<Fits<PlacementStepIn['dispute/resolve'], DiC.ResolveDisputeBody>>(
  'dispute/resolve'
);
ok<Fits<PlacementStepIn['cancel'], DiC.CancelPlacementBody>>('cancel');
ok<Fits<PlacementStepIn['reject'], DiC.RejectPlacementBody>>('reject');
ok<Fits<BodyOf<Di['createExpense']>, DiC.CreateExpenseBody>>('createExpense');
ok<Fits<BodyOf<Di['createEntry']>, DiC.CreateEntryBody>>('createEntry');
ok<Fits<BodyOf<Di['reconcileEntry']>, DiC.ReconcileEntryBody>>(
  'reconcileEntry'
);
ok<Fits<BodyOf<Di['reserveRelease']>, DiC.ReserveReleaseBody>>(
  'reserveRelease'
);

// ── Заявки, клиенты, оплаты (P-G2) ──────────────────────────────────────
ok<Fits<BodyOf<Le['transition']>, LeC.LeadTransitionBody>>('lead transition');
ok<Fits<BodyOf<Le['assign']>, LeC.LeadAssignBody>>('lead assign');
ok<Fits<BodyOf<Le['testFlag']>, LeC.LeadTestFlagBody>>('testFlag');
ok<Fits<BodyOf<Le['duplicate']>, LeC.LeadDuplicateBody>>('duplicate');
ok<Fits<BodyOf<Le['setProspect']>, LeC.LeadProspectBody>>('setProspect');
ok<Fits<BodyOf<Le['erase']>, LeC.EraseBody>>('erase');
ok<Fits<BodyOf<Le['retain']>, LeC.RetainBody>>('retain');
ok<Fits<BodyOf<Le['createProspect']>, LeC.ProspectCreateBody>>(
  'createProspect'
);
ok<Fits<BodyOf<Le['updateProspect']>, LeC.ProspectUpdateBody>>(
  'updateProspect'
);
ok<Fits<BodyOf<Le['mergeProspects']>, LeC.ProspectMergeBody>>('mergeProspects');
ok<Fits<BodyOf<Le['createPayment']>, LeC.PaymentCreateBody>>('createPayment');
ok<Fits<BodyOf<Le['paymentStep']>, LeC.PaymentConfirmBody>>('paymentStep');

// ── Отчёты, эксперименты, время, бэкапы (P-G2) ──────────────────────────
ok<Fits<BodyOf<Re['createTimeEntry']>, ReC.CreateTimeEntryBody>>(
  'createTimeEntry'
);
ok<Fits<BodyOf<Re['patchTimeEntry']>, ReC.PatchTimeEntryBody>>(
  'patchTimeEntry'
);
ok<Fits<BodyOf<Re['createMetricImport']>, ReC.CreateMetricImportBody>>(
  'createMetricImport'
);
ok<Fits<BodyOf<Re['putIntegration']>, ReC.PutIntegrationBody>>(
  'putIntegration'
);
ok<Fits<BodyOf<Re['registerExperiment']>, ReC.RegisterExperimentBody>>(
  'registerExperiment'
);
ok<Fits<BodyOf<Re['experimentVersion']>, ReC.NewExperimentVersionBody>>(
  'experimentVersion'
);
ok<Fits<BodyOf<Re['concludeExperiment']>, ReC.ConcludeExperimentBody>>(
  'concludeExperiment'
);
ok<Fits<BodyOf<Re['createReport']>, ReC.CreateReportBody>>('createReport');
ok<
  Fits<
    { decision: Parameters<Re['reportDecision']>[3] },
    ReC.ReportDecisionBody
  >
>('reportDecision');
ok<
  Fits<
    { reason?: Parameters<Re['recomputeReport']>[3] },
    ReC.RecomputeReportBody
  >
>('recomputeReport');
ok<Fits<BodyOf<Re['restore']>, ReC.RestoreBody>>('restore');

// ── Reddit Manual MVP, M1 (P-R) ─────────────────────────────────────────
ok<Fits<BodyOf<Rd['createProject']>, RdC.CreateRedditProjectBody>>(
  'createRedditProject'
);
ok<Fits<BodyOf<Rd['patchProject']>, RdC.PatchRedditProjectBody>>(
  'patchRedditProject'
);
ok<Fits<BodyOf<Rd['createCommunity']>, RdC.CreateRedditCommunityBody>>(
  'createRedditCommunity'
);
ok<Fits<BodyOf<Rd['patchCommunity']>, RdC.PatchRedditCommunityBody>>(
  'patchRedditCommunity'
);
ok<Fits<BodyOf<Rd['createRules']>, RdC.CreateRedditRulesBody>>(
  'createRedditRules'
);
ok<Fits<BodyOf<Rd['createOpportunity']>, RdC.CreateRedditOpportunityBody>>(
  'createRedditOpportunity'
);
ok<Fits<BodyOf<Rd['patchOpportunity']>, RdC.PatchRedditOpportunityBody>>(
  'patchRedditOpportunity'
);
ok<
  Fits<BodyOf<Rd['transitionOpportunity']>, RdC.RedditOpportunityTransitionBody>
>('redditTransition');
ok<Fits<BodyOf<Rd['createKeyword']>, RdC.CreateRedditKeywordBody>>(
  'createRedditKeyword'
);
ok<Fits<BodyOf<Rd['patchKeyword']>, RdC.PatchRedditKeywordBody>>(
  'patchRedditKeyword'
);

// ── Reddit Manual MVP, M2 Studio (P-R) ──────────────────────────────────
ok<Fits<BodyOf<St['createBrief']>, RdC.CreateRedditBriefBody>>(
  'createRedditBrief'
);
ok<Fits<BodyOf<St['patchBrief']>, RdC.PatchRedditBriefBody>>(
  'patchRedditBrief'
);
ok<Fits<BodyOf<St['generate']>, RdC.GenerateRedditDraftBody>>(
  'generateRedditDraft'
);
ok<Fits<BodyOf<St['createContent']>, RdC.CreateRedditContentBody>>(
  'createRedditContent'
);
ok<Fits<BodyOf<St['reportPublication']>, RdC.ReportRedditPublicationBody>>(
  'reportRedditPublication'
);
// Версии Reddit-ветви общего маршрута — свои тела контракта (§9.9).
ok<Fits<BodyOf<St['createVersion']>, CoC.CreateRedditVersionBody>>(
  'createRedditVersion'
);
ok<Fits<BodyOf<St['patchVersion']>, CoC.PatchRedditVersionBody>>(
  'patchRedditVersion'
);
ok<Fits<BodyOf<St['copy']>, RdC.CopyRedditContentBody>>('copyRedditContent');

// ── Сверка не слепа: заведомые расхождения tsc отвергает ────────────────
// @ts-expect-error — лишний ключ (старое тело согласования, аудит A8)
ok<Fits<ApproveIn & { approverDisplayName: string }, CoC.ApproveBody>>('x');
// @ts-expect-error — причина пересчёта шире контракта (аудит S2)
ok<Fits<{ reason?: 'manual' | 'other' }, ReC.RecomputeReportBody>>('x');
// @ts-expect-error — проверка размещения без ссылок (аудит S1-1)
ok<Fits<{ expectedRevision: number; url: string }, DiC.PlacementVerifyBody>>(
  'x'
);
// @ts-expect-error — `policy_risk` выводится из снимка, не вводится (P-R)
ok<Fits<{ policy_risk: number }, RdC.RedditFactorsInput>>('x');
// @ts-expect-error — имя сообщества — `community`, не `name` (P-R)
ok<Fits<{ projectId: string; name: string }, RdC.CreateRedditCommunityBody>>(
  'x'
);
type RdAffMeta = { body: string; meta: { affiliation: 'none' } };
// @ts-expect-error — серверный ключ `meta.affiliation` от клиента (P-R M2)
ok<Fits<RdAffMeta, CoC.CreateRedditVersionBody>>('x');
// @ts-expect-error — шаблон генерации вне списка (P-R M2)
ok<Fits<{ template: 'essay' }, RdC.GenerateRedditDraftBody>>('x');
names.length -= 7;

// ── Рантайм: методы со скалярными аргументами тело строят сами — каждый
// вызывается через подменённый `PublisherHttp`, тело сверяется с `*Body`
// маршрута (лишних ключей нет, обязательные есть) ─────────────────────────
const sent: Array<{
  method: string;
  path: string;
  body: Record<string, unknown>;
}> = [];
const fake: PublisherHttp = {
  async get<T>() {
    return {} as T;
  },
  async send<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: Record<string, unknown>
  ) {
    sent.push({ method, path, body: { ...(body ?? {}) } });
    return {} as T;
  },
  async reveal<T>(path: string, body: Record<string, unknown>) {
    sent.push({ method: 'POST', path, body: { ...body } });
    return {} as T;
  },
  async csv() {
    return { filename: 'x.csv', text: '' };
  },
  async markdown() {
    return { filename: 'x.md', text: '' };
  },
};
{
  const pid = 'prod1';
  const K = 'k';
  const co = createCoreApiRt(fake);
  const ct = createContentApiRt(fake, pid);
  const ai = createAiApiRt(fake, fake, pid);
  const ca = createCalendarApiRt(fake, pid);
  const di = createDistributionApiRt(fake);
  const le = createLeadsApiRt(fake);
  const re = createReportsApiRt(fake);
  const rd = createRedditApiRt(fake, pid);
  const st = createRedditStudioApiRt(fake, pid);
  const calls: Array<Promise<unknown>> = [
    co.propose(pid, 'niche', { text: 'x' }, K),
    co.withdraw(pid, 'niche', 'pr1', K),
    co.revoke(pid, 'g1', 'r', K),
    co.resetRateLimit(pid, K),
    ct.revokeSource('s1', 'r', K),
    ct.activateOffer('o1', 'b', K),
    ct.briefReady('b1', 1, K),
    ct.submitVersion('c1', 'v1', 1, K),
    ct.revokeApproval('a1', 'r', K),
    ai.qaReview('v1', K),
    ai.questionsCluster(['q1', 'q2'], K),
    ai.draftWrite('c1', K),
    ai.claimsExtract('v1', K),
    ai.extra('t1', 'r', K),
    ai.accept('t1', 'call1', K),
    ai.bind('cfg1', 'b', K),
    ai.unbind('bind1', 'r', K),
    ca.aiPlan('c1', K),
    di.aiCompareVenues(pid, K, ['v1', 'v2']),
    di.placementStep(pid, 'p1', 'reserve', K, { expectedRevision: 1 }),
    di.rebuildCounters(pid, K, 'пересборка после сверки'),
    le.paymentStep(pid, 'pay1', 'confirm', K, { confirmation: 'INV-1' }),
    le.paymentStep(pid, 'pay1', 'refund', K),
    le.paymentStep(pid, 'pay1', 'cancel', K),
    le.retryNotification(pid, 'n1', K),
    le.markQueueChecked(pid, K),
    // Раскрытие ПД — POST без opKey (Р-PUB-Z2-25): тело = тип тела маршрута.
    le.revealContact(pid, 'l1', 'first_contact'),
    le.revealNotes(pid, 'l1'),
    re.applyExperiment(pid, 'e1', K),
    re.reportDecision(pid, 'r1', K, 'go'),
    re.recomputeReport(pid, 'r1', K, 'manual'),
    re.createBackup(pid, K),
    // P-R: тела из скаляров (архив проекта, review, пересчёт, переходы).
    rd.archiveProject('rp1', K, 1),
    rd.restoreProject('rp1', K, 2),
    rd.reviewRules('rs1', K),
    rd.scoreOpportunity('ro1', K, 2),
    rd.transitionOpportunity('ro1', 'qualify', K, { expectedRevision: 2 }),
    rd.transitionOpportunity('ro1', 'skip', K, {
      expectedRevision: 2,
      reason: 'r',
    }),
    rd.transitionOpportunity('ro1', 'archive', K, { expectedRevision: 2 }),
    // P-R M2: ready/архив брифа, проверка и копирование (общие тела).
    st.briefReady('rb1', K, 3),
    st.archiveBrief('rb1', K, 3),
    st.check('c1', K),
    st.copy('c1', K),
  ];
  await Promise.all(calls.map((p) => p.catch(() => undefined)));
}
const ROUTES = [
  'core-api.ts',
  'content-api.ts',
  'ai-api.ts',
  'distribution-api.ts',
  'leads-api.ts',
  'reports-api.ts',
  'reddit-api.ts',
]
  .flatMap((f) => routesOf(contractSrc(f)))
  .filter((r) => r.method !== 'GET')
  // Литеральный сегмент важнее параметра (`sources/import-url`).
  .sort((a, b) => a.path.split(':').length - b.path.split(':').length);
const runtime = new Set<string>();
for (const c of sent) {
  const path = `/publisher/${c.path.split('?')[0]}`;
  const def = ROUTES.find((d) => d.method === c.method && d.re.test(path));
  assert.ok(def, `нет маршрута ${c.method} ${path}`);
  const issues = bodyIssuesOf(c.body, def!.body);
  assert.deepEqual(issues, [], `${def!.name} (${def!.body}): ${issues}`);
  // Ключ — метод и путь: имена маршрутов разных пакетов совпадают
  // (`briefReady` у P-B1 и у P-R M2).
  runtime.add(`${def!.method} ${def!.path}`);
}
assert.equal(runtime.size, sent.length, 'каждый рантайм-вызов — свой маршрут');

// ── Полнота: КАЖДЫЙ маршрут-мутация контракта сверен — по типам (своё
// имя `*Body` в `ok<Fits<…>>`) или в рантайме выше. Общие тела
// (`MutationBody`, `RevisionedBody`, пересечения) — только рантаймом:
// по имени они не различают маршруты. Исключений нет. ─────────────────────
const SHARED = new Set([
  'MutationBody',
  'RevisionedBody',
  // Псевдонимы общих тел P-R (сверяются рантаймом, как сами общие).
  'ArchiveRedditProjectBody',
  'RestoreRedditProjectBody',
  'ReviewRedditRulesBody',
  'ScoreRedditOpportunityBody',
]);
const self = (await import('node:fs')).readFileSync(
  new URL(import.meta.url),
  'utf8'
);
let typed = 0;
for (const r of ROUTES) {
  // Объединение (`CreateVersionBody | CreateRedditVersionBody`) — сверен
  // каждый член.
  const members = r.body.split('|').map((x) => x.trim());
  const named = members.every((m) => /^\w+$/.test(m) && !SHARED.has(m));
  const byType =
    named && members.every((m) => new RegExp(`\\.${m}\\s*>`).test(self));
  if (byType) typed++;
  assert.ok(
    byType || runtime.has(`${r.method} ${r.path}`),
    `маршрут ${r.name} (${r.method} ${r.path}, ${r.body}) не сверен: добавь ok<Fits<…>> или вызов в рантайм-часть`
  );
}
assert.ok(names.length >= 80, `сверено тел ${names.length}`);

// ── Типы проверяет tsc: `npm test` (tsx не проверяет типы) запускает его
// на этом файле — расхождение тела роняет тест, а не только
// `typecheck:scripts`. Модули Node — через вычисляемый спецификатор:
// `scripts/types/node-ambient.d.ts` их не объявляет (и не должен).
{
  const node = (m: string) => import(`node:${m}`);
  const cp = await node('child_process');
  const os = await node('os');
  const fs = await node('fs');
  const path = await node('path');
  const here = new URL('.', import.meta.url).pathname;
  const root = path.resolve(here, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-bodies-'));
  const cfg = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { noEmit: true },
      include: [],
      files: [
        path.join(here, 'publisher-bodies.test.ts'),
        path.join(here, 'types/node-ambient.d.ts'),
      ],
    })
  );
  const r = cp.spawnSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['-p', cfg],
    { encoding: 'utf8' }
  );
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(
    r.status,
    0,
    `tsc: тела клиента ≠ *Body\n${r.stdout}${r.stderr}`
  );
}
console.log(
  `publisher-bodies: ok (${ROUTES.length} мутаций контракта: ${typed} по типам (${names.length} проверок Fits), ${runtime.size} в рантайме)`
);
