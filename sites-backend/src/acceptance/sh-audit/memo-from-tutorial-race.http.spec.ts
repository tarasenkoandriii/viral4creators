/**
 * Аудит L6680 «защита от двойного „Из обучалки“» по HTTP на настоящем
 * Postgres: два (и больше) одновременных «создать» из ОДНОЙ обучалки — оба
 * проходят проверку «мемо уже есть» до записи любого из них (подделка
 * генератора держит ответы, пока не придут все запросы). Внутри транзакции
 * создания — advisory-блокировка по (сайт, черновик) и повторная проверка:
 * ровно одно мемо, остальные — 409 `MEMO_TUTORIAL_EXISTS` с тем же номером;
 * счётчик номеров сайта сдвинулся один раз. Другая обучалка того же сайта
 * параллельно не ждёт отказа (ключ блокировки — черновик).
 */
import { Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { GeneratorMemoStepsClient } from '../../modules/assist-site-voice-control/cabinet/generator-memo-steps.client';
import { MemoFromTutorialController } from '../../modules/assist-site-voice-control/cabinet/memo-from-tutorial.controller';
import { MemoFromTutorialService } from '../../modules/assist-site-voice-control/cabinet/memo-from-tutorial.service';
import { MemoService } from '../../modules/assist-site-voice-control/cabinet/memo.service';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { SitesDb } from '../../prisma/sites-db.service';
import { ingestUiSnapshot } from '../../modules/site-core/ui-map/ui-map-store';
import { E7Stack, describeE7, type E7Site } from '../e7/e7-stack';

jest.setTimeout(120_000);

const SECRET = 'memo-tutorial-race-secret-'.padEnd(48, 'x');

@Module({
  imports: [SiteCoreModule],
  controllers: [MemoFromTutorialController],
  providers: [MemoService, MemoFromTutorialService, GeneratorMemoStepsClient],
})
class MemoTutorialRaceModule {}

class RaceStack extends E7Stack {
  protected override extraModules() {
    return [MemoTutorialRaceModule];
  }
}

describeE7('L6680: двойное «Из обучалки» — ровно одно мемо', () => {
  const st = new RaceStack();
  let S: E7Site;
  /** Сколько запросов к генератору ждать, прежде чем ответить всем. */
  let gate = { want: 1, waiting: [] as Array<() => void> };

  const steps = (host: string, title: string) => ({
    host,
    title,
    startPath: '/catalog',
    endPath: '/cart',
    view: 'mobile',
    requiresLogin: false,
    steps: [
      { kind: 'navigate', path: '/catalog' },
      { kind: 'click', selector: '#add-to-cart' },
    ],
    dropped: { login: 0, foreign: 0, other: 0 },
  });

  async function video(draftId: string) {
    await st.prisma.assistSiteVideo.create({
      data: {
        accountId: S.accountId,
        siteId: S.siteId,
        externalId: `vid_${randomUUID().slice(0, 8)}`,
        draftId,
        ownerTelegramId: S.ownerTg,
        title: `Ролик ${draftId}`,
        locale: 'uk',
        url: 'https://blob.example.com/v.mp4',
        requiresLogin: false,
        syncedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    await st.init();
    const gen = st.app.get(GeneratorMemoStepsClient);
    gen.env = {
      GENERATOR_INTERNAL_URL: 'https://gen.example.com',
      SITES_TUTORIAL_HMAC_SECRET: SECRET,
    };
    gen.fetchImpl = async (input) => {
      const url = new URL(String(input));
      const [, , , , , siteId, draftId] = url.pathname.split('/');
      // Барьер: ответ — когда пришли все параллельные запросы (значит, все
      // уже прошли проверку «мемо есть?» до записи).
      await new Promise<void>((resolve) => {
        gate.waiting.push(resolve);
        if (gate.waiting.length >= gate.want) {
          for (const r of gate.waiting.splice(0)) r();
        }
        setTimeout(resolve, 5_000).unref();
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            siteId,
            draftId,
            ...steps(S.host, `Обучалка ${draftId}`),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    S = await st.site({ plan: 'business' });
    const db = new SitesDb(st.prisma).forAccount(S.accountId);
    await ingestUiSnapshot(db, {
      accountId: S.accountId,
      siteId: S.siteId,
      hostId: S.siteHostId,
      host: S.host,
      path: '/catalog',
      source: 'tutorial',
      viewport: 'mobile',
      elements: [{ selector: '#add-to-cart', tag: 'button', label: 'В кошик' }],
    });
  });
  afterAll(() => st.close());

  const post = (draftId: string) =>
    request(st.srv())
      .post(`/assist/sites/${S.siteId}/memo-tutorials/${draftId}`)
      .set(st.as(S.ownerTg));

  const counter = async () =>
    (
      await st.prisma.assistSite.findUniqueOrThrow({
        where: { siteId: S.siteId },
        select: { memoCounter: true },
      })
    ).memoCounter;

  const memosOf = async (draftId: string) => {
    const ch = await st.prisma.assistSiteMemoChange.findMany({
      where: { siteId: S.siteId, source: 'tutorial' },
      select: { memoId: true, op: true },
    });
    const ids = ch
      .filter((c) => (c.op as { draftId?: string } | null)?.draftId === draftId)
      .map((c) => c.memoId);
    return st.prisma.assistSiteMemo.findMany({
      where: { id: { in: ids }, status: { not: 'removed' } },
      select: { number: true },
    });
  };

  it('три одновременных «создать» из одной обучалки → одно мемо, остальные 409 с его номером', async () => {
    await video('dr_race');
    const before = await counter();
    gate = { want: 3, waiting: [] };
    const rs = await Promise.all([
      post('dr_race'),
      post('dr_race'),
      post('dr_race'),
    ]);
    const ok = rs.filter((r) => r.status === 200);
    const dup = rs.filter((r) => r.status === 409);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const number = (ok[0].body.data ?? ok[0].body).memo.number;
    for (const r of dup) {
      expect(r.body.error.code).toBe('MEMO_TUTORIAL_EXISTS');
      expect(JSON.stringify(r.body)).toContain(`М-${number}`);
    }
    expect((await memosOf('dr_race')).map((m) => m.number)).toEqual([number]);
    // Отказ откатился до счётчика: номер сдвинулся один раз.
    expect(await counter()).toBe(before + 1);
  });

  it('две разные обучалки одновременно — обе создаются (блокировка по черновику)', async () => {
    await video('dr_a');
    await video('dr_b');
    gate = { want: 2, waiting: [] };
    const rs = await Promise.all([post('dr_a'), post('dr_b')]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await memosOf('dr_a')).toHaveLength(1);
    expect(await memosOf('dr_b')).toHaveLength(1);
  });
});
