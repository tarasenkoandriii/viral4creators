/**
 * Сид стенда E2E Publisher (интеграция Z-2b): кабинет, сайт, владелец и
 * участники с ролями продукта появятся после создания продукта драйвером;
 * здесь — только то, чего нет в API кабинета (кабинет и участники site-core,
 * подтверждённый хост сайта). Берёт СОБРАННЫЕ помощники (`npm run build` →
 * dist), пишет JSON с id и telegramId в файл из аргумента.
 *
 *   SITES_DATABASE_URL=… node test/publisher-e2e/seed.cjs /tmp/seed.json pubsite.test
 */
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../../dist');
const { PrismaService } = require(`${dist}/prisma/prisma.service.js`);
const fx = require(`${dist}/modules/publisher/testing/fixtures.testing.js`);
const at = require(`${dist}/modules/publisher/reports/qa/at-catalog.js`);

/**
 * Протокол приёмки в qa-catalog (Р-PUB-Z2-27): 44 кейса каталога AT и
 * прогон, где каждый — passed текущей версии. На стенде нет живого
 * прохождения 44 AT (автотесты — в jest, ручные части — у владельца), а
 * гейты запуска теперь требуют ссылку на СОХРАНЁННЫЙ прогон, — поэтому
 * протокол засевается как инфраструктура стенда, явно помеченной. Драйвер
 * отдельно проверяет, что свободная строка и неполный прогон не проходят.
 */
async function seedQaRun(db, accountId, siteId, memberId, opts = {}) {
  const snapshot = [];
  for (const c of at.AT_CATALOG) {
    const tc = await db.qaTestCase.upsert({
      where: { siteId_caseKey: { siteId, caseKey: c.id } },
      update: {},
      create: {
        accountId,
        siteId,
        caseKey: c.id,
        title: `${c.id} ${c.title}`.slice(0, 200),
        currentVersion: at.AT_CATALOG_VERSION,
      },
    });
    const payload = at.qaCaseInput(c);
    await db.qaTestCaseRevision.upsert({
      where: {
        caseId_version: { caseId: tc.id, version: at.AT_CATALOG_VERSION },
      },
      update: {},
      create: {
        accountId,
        caseId: tc.id,
        version: at.AT_CATALOG_VERSION,
        payload,
        createdByMemberId: memberId,
      },
    });
    snapshot.push({
      caseId: tc.id,
      caseKey: c.id,
      version: at.AT_CATALOG_VERSION,
      payload,
    });
  }
  const run = await db.qaTestRun.create({
    data: {
      accountId,
      siteId,
      title: opts.title ?? 'Стенд E2E: протокол P0 (засіяний сидом стенду)',
      snapshot,
      createdByMemberId: memberId,
    },
  });
  for (const c of at.AT_CATALOG) {
    const status = opts.statusOf ? opts.statusOf(c.id) : 'passed';
    await db.qaTestRunAttempt.create({
      data: {
        accountId,
        runId: run.id,
        caseKey: c.id,
        attemptNumber: 1,
        status,
        comment:
          status === 'passed' ? '' : 'Стенд E2E: навмисно неповний протокол',
        createdByMemberId: memberId,
      },
    });
  }
  return run.id;
}

async function main() {
  const out = process.argv[2];
  const host = process.argv[3] ?? 'pubsite.test';
  if (!out) throw new Error('укажите файл результата');
  const db = new PrismaService();
  const acc = await fx.seedAccount(db);
  await fx.seedVerifiedHost(db, acc.accountId, acc.siteId, host);
  // Участники кабинета с допуском к Publisher (роли продукта выдаст
  // владелец через API после создания продукта).
  const members = {};
  for (const key of [
    'product_owner',
    'editor',
    'operator',
    'analyst',
    'sales',
    'viewer',
  ]) {
    const telegramId = BigInt(
      `5${Date.now() % 1e8}${Math.floor(Math.random() * 90 + 10)}`,
    );
    const m = await db.siteAccountMember.create({
      data: {
        accountId: acc.accountId,
        telegramId,
        role: 'operator',
        productRoles: {
          publisher: 'member',
          qa: 'none',
          assist: 'none',
          assistAdmin: 'none',
        },
      },
    });
    members[key] = { memberId: m.id, telegramId: String(telegramId) };
  }
  // Пустой сайт того же кабинета — цель восстановления копии (§15.4).
  const restoreSiteId = await fx.seedSite(db, acc.accountId);
  const qaRunId = await seedQaRun(
    db,
    acc.accountId,
    acc.siteId,
    acc.owner.memberId,
  );
  // Неполный прогон: один сценарий D0 упал — гейт его не принимает.
  const qaRunPartialId = await seedQaRun(
    db,
    acc.accountId,
    acc.siteId,
    acc.owner.memberId,
    {
      title: 'Стенд E2E: неповний протокол',
      statusOf: (id) => (id === 'AT-CORE-03' ? 'failed' : 'passed'),
    },
  );
  // Второй кабинет — для проверки изоляции глазами клиента.
  const other = await fx.seedAccount(db);
  writeFileSync(
    out,
    JSON.stringify(
      {
        accountId: acc.accountId,
        siteId: acc.siteId,
        restoreSiteId,
        qaRunId,
        qaRunPartialId,
        host,
        owner: {
          memberId: acc.owner.memberId,
          telegramId: String(acc.owner.telegramId),
        },
        members,
        other: {
          accountId: other.accountId,
          siteId: other.siteId,
          owner: {
            memberId: other.owner.memberId,
            telegramId: String(other.owner.telegramId),
          },
        },
      },
      null,
      2,
    ),
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
