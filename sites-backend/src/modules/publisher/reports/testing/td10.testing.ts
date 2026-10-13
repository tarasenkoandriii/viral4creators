/**
 * AI Publisher — TD-10 (P-E, проектный документ §16.7; план внешнего
 * аудита): продукт для резервной копии и восстановления — параметры с
 * решениями и предложением (обратная ссылка цикла), источники (разрешённый,
 * отзываемый ПОСЛЕ копии, уже отозванный), материал с версией, связями,
 * согласованием и live-публикацией, эксперимент с материалом, отчёт и
 * наследник (самоссылка), закупка с согласованием, обязательством и
 * записями оплаты/оказания, лимит бюджета, заявки с шифрованными
 * контактами и заметками (одна будет удалена ПОСЛЕ копии, одна удалена
 * ДО), проспект с заметкой, сессия и события, оплата клиента, труд, импорт,
 * интеграция, аудит, задача проверки, AI-задача и вызов, исходящая
 * очередь и уведомление (в копию не входят).
 *
 * Пишет клиентом владельца схемы БЕЗ транзакции теста (восстановление идёт
 * своими транзакциями Prisma): данные остаются в базе — id случайные,
 * кабинет свой.
 */
import { randomBytes } from 'crypto';
import {
  M,
  hex64,
  json,
  rid,
  uuid4,
  type PubDb,
  type PubWorld,
} from '../../../../prisma/publisher-schema.testing';
import {
  contactMatchHash,
  publisherKeys,
  sealContact,
  sealNote,
  type ContactPayload,
} from '../../core/contact-crypto';

export const TD10_SECRET = 'td10-test-secret-not-a-real-key-0123456789';

export interface Td10 {
  w: PubWorld;
  targetSiteId: string;
  ids: {
    sourceAllowed: string;
    sourceToRevoke: string;
    sourceRevoked: string;
    /** Подтверждённый критический claim, опора — `sourceToRevoke` (Р-PUB-Z2-23). */
    claimCritical: string;
    content: string;
    version: string;
    publication: string;
    experiment: string;
    report: string;
    reportChild: string;
    placement: string;
    expense: string;
    lead1: string;
    lead2: string;
    lead3: string;
    prospect: string;
    decision1: string;
    proposal: string;
    auditEvent: string;
    aiCall: string;
  };
  contact1: ContactPayload;
}

const NOW = () => new Date();

export function td10Keys() {
  const env = { ...process.env, ASSIST_SECRETS_KEY: TD10_SECRET };
  return {
    contact: publisherKeys('leadContact', env)!,
    match: publisherKeys('contactMatch', env)!,
    notes: publisherKeys('leadNotes', env)!,
  };
}

/** TD-10 в базе (автокоммит); `extraEvents` — для замера скорости. */
export async function seedTd10(
  db: PubDb,
  opts: { extraEvents?: number } = {},
): Promise<Td10> {
  const keys = td10Keys();
  const w = await db.world({ kind: 'working' });
  await db.openForIntake(w);
  const targetSiteId = await db.site(w.accountId);

  // ── Параметры: решение → голова; предложение ↔ решение (цикл FK) ──────
  await db.decidedParam(w, 'analytics_storage', json('session'), 'approved');
  await db.decidedParam(
    w,
    'retention_policy',
    { leadReviewDays: 90, closedReviewDays: 90, backupRotationDays: 30 },
    'approved',
  );
  await db.child('pub_parameters', w, {
    key: 'niche',
    value: { text: 'Ніша' },
    status: 'assumption',
  });
  const proposal = await db.child('pub_parameter_proposals', w, {
    parameterKey: 'language',
    value: { code: 'uk' },
    proposedBy: M,
    status: 'open',
  });
  const decision = await db.child('pub_parameter_decisions', w, {
    parameterKey: 'language',
    version: 1,
    proposalId: proposal,
    fromStatus: 'assumption',
    toStatus: 'approved',
    valueSnapshot: { code: 'uk' },
    decidedBy: M,
    basis: 'Решение владельца по языку',
    dependentStages: [],
  });
  await db.child('pub_parameters', w, {
    key: 'language',
    value: { code: 'uk' },
    status: 'approved',
    version: 1,
    approvedBy: M,
    approvedAt: NOW(),
  });
  await db.upd('pub_parameter_proposals', proposal, {
    status: 'accepted',
    decisionId: decision,
  });

  // ── Источники ───────────────────────────────────────────────────────
  const sourceAllowed = await db.source(w, { url: 'https://src.example/a' });
  const sourceToRevoke = await db.source(w, { url: 'https://src.example/b' });
  const sourceRevoked = await db.source(w, {
    url: 'https://src.example/c',
    usage: 'revoked',
    revokedAt: NOW(),
    revokedBy: M,
    revokeReason: 'Право використання відкликано',
  });
  await db.child('pub_source_revocations', w, {
    sourceId: sourceRevoked,
    revokedBy: M,
    reason: 'Право використання відкликано',
  });
  // Критический claim подтверждён источником, который отзовут ПОСЛЕ копии.
  const claimCritical = await db.child('pub_claims', w, {
    statement: 'Пілот коштує 10 000 грн',
    type: 'fact',
    risk: 'critical',
  });
  // Проверка связи — после последнего изменения источника (с запасом).
  const checkedAt = new Date(Date.now() + 1000);
  await db.child('pub_claim_sources', w, {
    claimId: claimCritical,
    sourceId: sourceToRevoke,
    supports: 'yes',
    checkedBy: M,
    checkedAt,
  });
  await db.upd('pub_claims', claimCritical, {
    status: 'supported',
    verifiedBy: M,
    verifiedAt: checkedAt,
  });

  // ── Материал: версия со связями, согласование, live-публикация ───────
  const content = await db.article(w);
  const version = await db.version(w, content, { status: 'draft' });
  for (const s of [sourceAllowed, sourceToRevoke]) {
    await db.child('pub_version_sources', w, {
      versionId: version,
      sourceId: s,
    });
  }
  await db.upd('pub_content_versions', version, {
    status: 'submitted',
    hash: hex64(version),
    frozenAt: NOW(),
  });
  const approval = await db.publishApproval(w, version);
  const channel = await db.channel(w);
  const publication = await db.child('pub_publications', w, {
    versionId: version,
    channelId: channel,
    approvalId: approval,
    stage: 'live',
    finalUrl: `https://site.example/${randomBytes(3).toString('hex')}`,
    publishedAt: NOW(),
    status: 'published',
    opKey: uuid4(),
  });
  await db.upd('pub_contents', content, {
    status: 'published',
    currentVersionId: version,
    approvedVersionId: version,
    publishedVersionId: version,
    firstPublishedAt: NOW(),
  });

  // ── Эксперимент, отчёт и наследник ──────────────────────────────────
  const experiment = await db.experiment(w);
  await db.child('pub_experiment_contents', w, {
    experimentId: experiment,
    contentId: content,
  });
  const reportBase = {
    kind: 'ad_hoc',
    periodStart: new Date('2026-10-20T07:00:00Z'),
    periodEnd: new Date('2026-10-27T08:00:00Z'),
    snapshotAt: new Date('2026-10-28T08:00:00Z'),
    experimentId: experiment,
    cohort: {},
    attributionModel: 'last_non_direct_30d',
    sources: {},
    costs: {},
  };
  const report = await db.child('pub_reports', w, {
    ...reportBase,
    metrics: { membership: { leadIds: [], prospectIds: [] } },
    inputsHash: hex64('r1'),
  });
  const reportChild = await db.child('pub_reports', w, {
    ...reportBase,
    metrics: { note: `Наслідник ${report}` },
    inputsHash: hex64('r1'),
    decision: 'Продовжити обмежено',
    supersedesReportId: report,
    recomputeReason: 'decision',
  });

  // ── Деньги: лимит, закупка, обязательство, записи ───────────────────
  await db.budgetLimit(w, {
    placementsLimitMinor: 600_000,
    toolsLimitMinor: 200_000,
    protectedReserveMinor: 200_000,
    perPurchaseMaxMinor: 200_000,
    netPaidMinor: 100_000,
    openCommitMinor: 0,
    usedPlacementsMinor: 100_000,
  });
  const { placementId } = await db.approvedPlacement(w);
  const expense = await db.child('pub_expenses', w, {
    category: 'placements',
    description: 'Закупка розміщення',
    placementId,
    amountTotalMinor: 100_000,
    paidMinor: 100_000,
    deliveredMinor: 100_000,
    currency: 'UAH',
    status: 'open',
  });
  for (const [kind, extra] of [
    ['commit', {}],
    ['pay', { confirmedAt: NOW(), confirmedBy: M, externalRef: 'PAY-1' }],
    ['deliver', {}],
  ] as const) {
    await db.child('pub_expense_entries', w, {
      expenseId: expense,
      kind,
      amountMinor: 100_000,
      status: 'confirmed',
      occurredAt: NOW(),
      opKey: uuid4(),
      ...extra,
    });
  }
  await db.upd('pub_placements', placementId, { expenseId: expense });

  // ── Заявки, контакты, проспект, решения ─────────────────────────────
  const prospect = rid('pros');
  await db.prospect(w, {
    id: prospect,
    noteEnc: sealNote('Нотатка про проспект', prospect, keys.notes).enc,
  });
  const contact1: ContactPayload = {
    name: 'Синтетичний Заявник',
    contactMethod: 'email',
    contact: 'synthetic.td10@example.com',
    business: 'Синтетичний бізнес',
    task: 'Синтетичне завдання TD-10',
    selfReported: null,
  };
  const lead1 = await db.lead(w, {
    status: 'qualified',
    prospectId: prospect,
    sessionRef: 'sess_td10_1',
  });
  const lead2 = await db.lead(w, { status: 'new' });
  const lead3 = await db.lead(w, { status: 'new', erasedAt: NOW() });
  for (const [leadId, payload] of [
    [lead1, contact1],
    [lead2, { ...contact1, contact: 'second.td10@example.com' }],
  ] as const) {
    const sealed = sealContact(payload, leadId, keys.contact);
    await db.child('pub_lead_contacts', w, {
      leadId,
      contactEnc: sealed.enc,
      keyVersion: sealed.keyVersion,
      matchHash: contactMatchHash(
        w.productId,
        payload.contactMethod,
        payload.contact,
        keys.match,
      ),
      createdBy: 'public',
    });
  }
  await db.child('pub_erasures', w, {
    leadId: lead3,
    erasedBy: M,
    basis: 'Запит заявника',
    scope: { active: true, exports: true },
  });
  const decision1 = rid('dec');
  await db.child('pub_lead_decisions', w, {
    id: decision1,
    leadId: lead1,
    fromStatus: 'new',
    toStatus: 'qualified',
    confirmedInterestAt: NOW(),
    decidedBy: M,
    noteEnc: sealNote('Підтвердив інтерес', decision1, keys.notes).enc,
  });
  await db.child('pub_lead_prospect_links', w, {
    leadId: lead1,
    prospectId: prospect,
    reason: 'new',
    decidedBy: 'system:lead-enrich',
  });
  await db.child('pub_sessions', w, {
    sessionRef: 'sess_td10_1',
    landingPath: '/a',
    utm: {},
    consentState: 'not_required',
    testFlag: false,
    createdBy: 'public',
  });
  await db.child('pub_events', w, {
    eventId: uuid4(),
    name: 'lead_submit_success',
    leadId: lead1,
    sessionRef: 'sess_td10_1',
    testFlag: false,
    createdBy: 'public',
  });
  await db.child('pub_payments', w, {
    prospectId: prospect,
    leadId: lead1,
    recordType: 'payment_received',
    payerKind: 'external',
    amountMinor: 50_000,
    currency: 'UAH',
    occurredAt: NOW(),
    paymentRef: `PAY-${randomBytes(3).toString('hex')}`,
    status: 'confirmed',
    confirmedBy: M,
    confirmedAt: NOW(),
    isNewCustomer: 'yes',
    opKey: uuid4(),
  });
  // Исходящая очередь и уведомление — в копию не входят (§15.4).
  await db.child('pub_lead_outbox', w, {
    leadId: lead1,
    kind: 'lead_received',
    status: 'done',
    createdBy: 'public',
  });
  await db.child('pub_notifications', w, {
    leadId: lead1,
    kind: 'new_lead',
    recipientMemberId: 'm1',
    status: 'sent',
    sentAt: NOW(),
    nextAttemptAt: NOW(),
    createdBy: 'system:lead-enrich',
  });

  // ── Труд, импорт, интеграция, аудит, задача, AI ─────────────────────
  await db.child('pub_time_entries', w, {
    memberId: 'm1',
    memberDisplayName: 'Учасник …m1',
    role: 'analyst',
    task: 'Аналітика тижня',
    minutes: 60,
    workDate: '2026-10-21',
    category: 'analytics_ops',
    isInvestment: false,
  });
  await db.child('pub_metric_imports', w, {
    source: 'web_analytics',
    periodStart: new Date('2026-10-20T00:00:00Z'),
    periodEnd: new Date('2026-10-21T00:00:00Z'),
    payload: { days: [{ date: '2026-10-20', sessions: 3 }] },
    importedBy: M,
  });
  await db.child('pub_integrations', w, {
    kind: 'web_analytics',
    status: 'connected',
    manual: true,
    lastSuccessAt: new Date('2026-01-01T00:00:00Z'),
    staleAfterHours: 1,
  });
  const auditEvent = await db.child('pub_audit_events', w, {
    actor: M,
    objectType: 'content',
    objectId: content,
    action: 'create',
    occurredAt: NOW(),
  });
  await db.child('pub_review_tasks', w, {
    objectType: 'content',
    objectId: content,
    reason: 'other',
    triggerRef: `td10:${content}`,
    severity: 'normal',
  });
  const aiTask = await db.aiTask(w, {
    objectType: 'content',
    objectId: content,
  });
  const aiCall = await db.aiCall(w, {
    taskId: aiTask,
    sourceIds: [sourceAllowed],
  });

  if (opts.extraEvents && opts.extraEvents > 0) {
    // Замер скорости: N сессий + N событий (автокоммит, один оператор на таблицу).
    const suffix = randomBytes(4).toString('hex');
    await db.q(
      `INSERT INTO "sites"."pub_sessions" ("id","accountId","productId","sessionRef","landingPath","utm","consentState","testFlag")
       SELECT 'bs_' || g || '_' || $3, $1, $2, 'bench_' || g || '_' || $3, '/b', '{}'::jsonb, 'not_required', false
         FROM generate_series(1, $4::int) g`,
      [w.accountId, w.productId, suffix, opts.extraEvents],
    );
    await db.q(
      `INSERT INTO "sites"."pub_events" ("id","accountId","productId","eventId","name","occurredAt","sessionRef","utmRedacted","testFlag")
       SELECT 'be_' || g || '_' || $3, $1, $2, gen_random_uuid()::text, 'content_view', now(), 'bench_' || g || '_' || $3, false, false
         FROM generate_series(1, $4::int) g`,
      [w.accountId, w.productId, suffix, opts.extraEvents],
    );
  }

  return {
    w,
    targetSiteId,
    ids: {
      sourceAllowed,
      sourceToRevoke,
      sourceRevoked,
      claimCritical,
      content,
      version,
      publication,
      experiment,
      report,
      reportChild,
      placement: placementId,
      expense,
      lead1,
      lead2,
      lead3,
      prospect,
      decision1,
      proposal,
      auditEvent,
      aiCall,
    },
    contact1,
  };
}
