/**
 * Внутренний аудит 19.10.2026, IA-AB-08 (Р-IA-FXC-4): версия словарей
 * проверки `reddit_policy` (`REDDIT_MARKERS_VERSION`, `markers@N`) пишется в
 * строку `pub_qa_checks.rulesVersion` (миграция
 * `20261026100000_publisher_reddit_policy_version`). Исходный сценарий: строки, полученные на markers@2/@3/@4, были
 * неразличимы — по строке нельзя было установить, какими правилами получен
 * BLOCK/WARN.
 */
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { REDDIT_MARKERS_VERSION } from './markers';
import {
  api,
  draftVersion,
  redditStack,
  redditWorld,
  seedStudio,
  submitVersion,
  type RedditStack,
  type RedditWorld,
} from './testing/reddit-kit.testing';

jest.setTimeout(180_000);

ciDescribe('IA-AB-08: версия словарей reddit_policy в строке проверки', () => {
  let s: RedditStack;
  let w: RedditWorld;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
  });
  afterAll(async () => {
    await s?.close();
  });

  it('заморозка версии → строка reddit_policy с rulesVersion = markers@N; база не принимает чужой формат и версию у других видов', async () => {
    expect(REDDIT_MARKERS_VERSION).toMatch(/^markers@[1-9]\d*$/);
    const ed = api(s, w.acc.accountId, w.team.editor);
    const po = api(s, w.acc.accountId, w.team.product_owner);
    const ids = await seedStudio(s, w, ed, po);
    const v = await submitVersion(
      ed,
      w,
      ids.contentId,
      await draftVersion(ed, w, ids),
    );
    const row = await s.prisma.pubQaCheck.findFirstOrThrow({
      where: { versionId: v.id, kind: 'reddit_policy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.rulesVersion).toBe(REDDIT_MARKERS_VERSION);
    // В `meta` аудита версии нет: `markers@4` для проверки ПД похож на ник
    // (`@`); источник — строка проверки (аудит ссылается на неё по id).
    const base = {
      accountId: w.acc.accountId,
      productId: w.product.id,
      versionId: v.id,
      result: 'pass',
      blockers: [],
      warnings: [],
    };
    // Чужой формат версии — отказ базы.
    await expect(
      s.prisma.pubQaCheck.create({
        data: {
          ...base,
          kind: 'reddit_policy',
          rulesVersion: 'v4',
          checkedBy: 'system:reddit-policy',
          createdBy: 'system:reddit-policy',
        },
      }),
    ).rejects.toThrow(/pub_qa_checks\.rulesVersion: markers@N/);
    // У проверки человека версии словарей нет.
    const member = `member:${w.team.editor.memberId}`;
    await expect(
      s.prisma.pubQaCheck.create({
        data: {
          ...base,
          kind: 'editorial',
          rulesVersion: REDDIT_MARKERS_VERSION,
          checkedBy: member,
          createdBy: member,
        },
      }),
    ).rejects.toThrow(/pub_qa_checks\.rulesVersion: markers@N/);
    // Строка до миграции (и её восстановление из копии) — NULL допустим.
    await expect(
      s.prisma.pubQaCheck.create({
        data: {
          ...base,
          kind: 'reddit_policy',
          checkedBy: 'system:reddit-policy',
          createdBy: 'system:reddit-policy',
        },
      }),
    ).resolves.toMatchObject({ rulesVersion: null });
  });
});
