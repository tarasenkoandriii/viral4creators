/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * C2 захода 8 на НАСТОЯЩЕМ Postgres: точечная запись снимка поздравления
 * (`greeting-snapshot-write`) и сервисы, которые ею пишут.
 *
 * Строка базы: `GREETING_SNAPSHOT_PG_URL`, а в CI — `DATABASE_URL` джобы
 * backend (там Postgres 16 с накатанными миграциями, шаг
 * `prisma migrate deploy`; ci.yml передаёт строку и явно). Без строки
 * набор пропускается с причиной в названии, а при `CI=true` —
 * ПРОВАЛИВАЕТСЯ: приёмка гонки не должна тихо перестать выполняться (тот
 * же приём, что `describeDb` в sites-backend).
 *
 * Локальный прогон: база с накатанными миграциями backend, затем
 *   GREETING_SNAPSHOT_PG_URL=postgresql://postgres@localhost:55432/<база> \
 *     npx jest -i src/common/greeting-snapshot-write.pg
 * Строки сессий набор заводит и удаляет сам.
 */
import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';
import {
  GreetingSnapshotDb,
  MAX_SNAPSHOT_WRITE_ATTEMPTS,
  applyGreetingSnapshotChange,
  readGreetingSnapshot,
  updateGreetingSnapshot,
} from './greeting-snapshot-write';
import type { GreetingBriefSnapshot } from './types/greeting.types';
import { GreetingScenesService } from '../modules/greeting-scenes/greeting-scenes.service';
import { GreetingCardsService } from '../modules/greeting-cards/greeting-cards.service';
import { GreetingMusicService } from '../modules/greeting-music/greeting-music.service';
import { GreetingStickerService } from '../modules/greeting-sticker/greeting-sticker.service';
import { GreetingVoiceService } from '../modules/greeting-voice/greeting-voice.service';

const IN_CI = process.env.CI === 'true';
const URL =
  process.env.GREETING_SNAPSHOT_PG_URL ??
  (IN_CI ? process.env.DATABASE_URL : undefined);

/** На базе — набор; без неё — пропуск с причиной, в CI — провал. */
function maybe(name: string, body: () => void): void {
  if (!URL) {
    describe(name, () => {
      (IN_CI ? it : it.skip)(
        'ПРОПУЩЕНО: нет GREETING_SNAPSHOT_PG_URL (песочница без базы) — проверка идёт в CI, джоба backend',
        () => {
          throw new Error(
            `CI=true, но ни GREETING_SNAPSHOT_PG_URL, ни DATABASE_URL не заданы — «${name}» не выполнился`,
          );
        },
      );
    });
    return;
  }
  describe(name, body);
}

const BRIEF = {
  sourceGreetingBriefId: 'gb1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Марина «Ёж» 🎂',
  senderName: 'Андрей',
  tone: 'WARM',
  personalMessage: null,
  requestedPresenterProvider: 'grok',
  resolvedPresenterProvider: 'grok',
  requestedResolution: '720p',
  resolvedResolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  addedAt: '2026-10-07T10:00:00.000Z',
  sticker: {
    id: 'st_1',
    url: 'https://blob.test/a.png',
    pathname: 'sessions/x/stickers/st_1.png',
    sourceUrl: 'https://pixabay.com/x',
    source: 'pixabay',
    placement: 'bottom-right',
  },
} as unknown as GreetingBriefSnapshot;

maybe('greeting-snapshot-write на настоящем Postgres (C2)', () => {
  let prisma: PrismaService;
  let sessions: SessionService;
  const created: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prisma = new PrismaService();
    await prisma.$connect();
    sessions = new SessionService(prisma);
  });

  afterAll(async () => {
    if (created.length) {
      await prisma.$executeRaw`DELETE FROM "sessions" WHERE "id" = ANY(${created}::text[])`;
    }
    await prisma.$disconnect();
  });

  async function seed(
    data: Record<string, unknown> = { greetingBriefSnapshot: BRIEF },
    live: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await prisma.$executeRaw`
      INSERT INTO "sessions" ("id", "status", "data", "liveData", "lastActivityAt")
      VALUES (${id}, 'created', ${JSON.stringify(data)}::jsonb,
              ${JSON.stringify(live)}::jsonb, NOW() - INTERVAL '1 hour')
    `;
    return id;
  }

  const snapshotOf = async (id: string) =>
    (await sessions.getSession(id))!.greetingBriefSnapshot!;

  it('контроль: прежняя запись целиком по устаревшему снимку теряет соседнюю правку', async () => {
    // Доказывает, что проверка ниже вообще умеет поймать потерю.
    const id = await seed();
    const stale = await snapshotOf(id);
    await sessions.updateSession(id, {
      greetingBriefSnapshot: { ...stale, sceneCount: 3 },
    });
    await sessions.updateSession(id, {
      greetingBriefSnapshot: { ...stale, cards: { title: 'А', closing: null } },
    });
    expect((await snapshotOf(id)).sceneCount).toBeUndefined();
  });

  it('две правки разных полей по одному устаревшему снимку — обе сохраняются', async () => {
    const id = await seed();
    const stale = await snapshotOf(id);
    await updateGreetingSnapshot(prisma, id, stale, () => ({
      set: { sceneCount: 3 },
    }));
    await updateGreetingSnapshot(prisma, id, stale, () => ({
      set: { cards: { title: 'А', closing: null } },
    }));
    const now = await snapshotOf(id);
    expect(now.sceneCount).toBe(3);
    expect(now.cards).toEqual({ title: 'А', closing: null });
    expect(now.recipientName).toBe(BRIEF.recipientName);
  });

  it('двенадцать одновременных правок разных полей, пять заходов — ни одна не теряется', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await seed();
      const stale = await snapshotOf(id);
      const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
      await Promise.all(
        keys.map((k, i) =>
          updateGreetingSnapshot(prisma, id, stale, () => ({
            set: { [k]: { n: i, round } } as any,
          })),
        ),
      );
      const now = (await snapshotOf(id)) as any;
      for (const [i, k] of keys.entries()) {
        expect(now[k]).toEqual({ n: i, round });
      }
      expect(now.sticker).toEqual(BRIEF.sticker);
    }
  });

  it('сервисы наклейки, музыки, сцен, карточек и голоса читают снимок одновременно — все пять правок на месте', async () => {
    const id = await seed();
    // Барьер: первые пять чтений сессии ждут друг друга — все сервисы
    // решают по ОДНОМУ и тому же снимку, как при быстрых кликах подряд.
    // Прежняя запись целиком при таком порядке оставляла только одну.
    let waiting: Array<() => void> = [];
    let reads = 0;
    const barrier = Object.create(sessions) as SessionService;
    barrier.getSession = async (sid: string) => {
      const s = await sessions.getSession(sid);
      if (++reads <= 5) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 5) {
            waiting.forEach((r) => r());
            waiting = [];
          }
        });
      }
      return s;
    };
    const scenes = new GreetingScenesService(barrier, prisma);
    const cards = new GreetingCardsService(barrier, prisma);
    const music = new GreetingMusicService(
      { get: async () => null } as any,
      barrier,
      {} as any,
      { enabled: false } as any,
      prisma,
    );
    const sticker = new GreetingStickerService(barrier, {} as any, prisma);
    const voice = new GreetingVoiceService(
      prisma,
      barrier,
      {} as any,
      {} as any,
    );
    await Promise.all([
      scenes.setCount(id, 3),
      cards.update(id, { title: 'Марине', closing: 'От Андрея' }),
      music.selectLink(id, {
        url: 'https://example.com/track.mp3',
        title: 'Своя',
        rightsConfirmed: true,
      } as any),
      sticker.move(id, 'top-left'),
      voice.selectPreset(id, 'eve'),
    ]);
    const now = await snapshotOf(id);
    expect(now.sceneCount).toBe(3);
    expect(now.cards).toEqual({ title: 'Марине', closing: 'От Андрея' });
    expect(now.musicTheme).toEqual(
      expect.objectContaining({ source: 'link', title: 'Своя' }),
    );
    expect(now.sticker).toEqual({ ...BRIEF.sticker, placement: 'top-left' });
    expect(now.presetVoiceId).toBe('eve');
    // Замок голоса снят.
    const raw = await prisma.$queryRaw<Array<{ locks: unknown }>>`
      SELECT "data" -> 'workLocks' AS locks FROM "sessions" WHERE "id" = ${id}`;
    expect(raw[0].locks ?? {}).not.toHaveProperty('prompt');
  });

  it("CAS 'all' по снимку, прочитанному через SessionService, — совпадает (круговой путь JSON честный)", async () => {
    const id = await seed();
    const current = await snapshotOf(id);
    const out = await applyGreetingSnapshotChange(prisma, id, current, {
      set: { tone: 'FUNNY' } as any,
      expect: 'all',
    });
    expect(out?.tone).toBe('FUNNY');
  });

  it("CAS 'all' по устаревшему снимку — промах без записи; цикл повторяет по свежему", async () => {
    const id = await seed();
    const stale = await snapshotOf(id);
    await updateGreetingSnapshot(prisma, id, stale, () => ({
      set: { sceneCount: 2 },
    }));
    await expect(
      applyGreetingSnapshotChange(prisma, id, stale, {
        set: { tone: 'FUNNY' } as any,
        expect: 'all',
      }),
    ).resolves.toBeNull();
    expect((await snapshotOf(id)).tone).toBe('WARM');
    const out = await updateGreetingSnapshot(prisma, id, stale, () => ({
      set: { tone: 'FUNNY' } as any,
      expect: 'all',
    }));
    expect(out).toEqual(
      expect.objectContaining({ tone: 'FUNNY', sceneCount: 2 }),
    );
  });

  it('expect: отсутствующий ключ равен null; изменённый — промах', async () => {
    const id = await seed();
    const current = await snapshotOf(id);
    // occasionRegister в снимке нет — ожидание null совпадает.
    await expect(
      applyGreetingSnapshotChange(prisma, id, current, {
        set: { sceneCount: 2 },
        expect: ['occasionRegister', 'tone'],
      }),
    ).resolves.toEqual(expect.objectContaining({ sceneCount: 2 }));
    await expect(
      applyGreetingSnapshotChange(
        prisma,
        id,
        { ...current, tone: 'FUNNY' } as any,
        { set: { sceneCount: 4 }, expect: ['tone'] },
      ),
    ).resolves.toBeNull();
    expect((await snapshotOf(id)).sceneCount).toBe(2);
  });

  it('удаление ключа и другие ключи сессии — тем же UPDATE; горячие копии и статус рендера не тронуты', async () => {
    const id = await seed(
      {
        greetingBriefSnapshot: { ...BRIEF, sceneCount: 3 },
        generationPrompt: { promptId: 'p1', finalText: 'x' },
      },
      { generatedVideo: { status: 'complete' } },
    );
    await prisma.$executeRaw`
      UPDATE "sessions" SET "generationStatus" = 'complete' WHERE "id" = ${id}`;
    const current = await snapshotOf(id);
    await applyGreetingSnapshotChange(prisma, id, current, {
      set: { sceneCount: undefined, tone: 'FUNNY' } as any,
      data: { generationPrompt: undefined },
    });
    const rows = await prisma.$queryRaw<
      Array<{
        data: any;
        liveData: any;
        generationStatus: string;
        fresh: boolean;
      }>
    >`
      SELECT "data", "liveData", "generationStatus",
             "lastActivityAt" > NOW() - INTERVAL '1 minute' AS fresh
        FROM "sessions" WHERE "id" = ${id}`;
    const row = rows[0];
    expect(row.data.greetingBriefSnapshot).not.toHaveProperty('sceneCount');
    expect(row.data.greetingBriefSnapshot.tone).toBe('FUNNY');
    expect(row.data.generationPrompt).toBeNull();
    expect(row.liveData).toEqual({ generatedVideo: { status: 'complete' } });
    expect(row.generationStatus).toBe('complete');
    expect(row.fresh).toBe(true);
  });

  it('удалённая (soft-delete) сессия — запись не ложится', async () => {
    const id = await seed();
    const current = await snapshotOf(id);
    await prisma.$executeRaw`
      UPDATE "sessions" SET "deletedAt" = NOW() WHERE "id" = ${id}`;
    await expect(
      applyGreetingSnapshotChange(prisma, id, current, {
        set: { sceneCount: 2 },
      }),
    ).resolves.toBeNull();
    const rows = await prisma.$queryRaw<Array<{ n: unknown }>>`
      SELECT "data" -> 'greetingBriefSnapshot' -> 'sceneCount' AS n
        FROM "sessions" WHERE "id" = ${id}`;
    expect(rows[0].n).toBeNull();
  });

  it('сессия без снимка — не поздравление: ничего не пишется, снимок не заводится', async () => {
    const id = await seed({ productInformation: { name: 'x' } });
    await expect(
      applyGreetingSnapshotChange(prisma, id, null, {
        set: { sceneCount: 2 },
      }),
    ).resolves.toBeNull();
    await expect(readGreetingSnapshot(prisma, id)).resolves.toBeNull();
  });

  it(`снимок меняют параллельно перед каждой попыткой — после ${MAX_SNAPSHOT_WRITE_ATTEMPTS} попыток 409, своя правка не легла`, async () => {
    const id = await seed();
    const current = await snapshotOf(id);
    let i = 0;
    // Перед каждой записью — «чужая» запись другого соединения в
    // зависимый ключ.
    const racing: GreetingSnapshotDb = {
      $queryRaw: (async (strings: TemplateStringsArray, ...values: any[]) => {
        if (strings.join('?').includes('greeting-snapshot:write')) {
          await prisma.$executeRaw`
            UPDATE "sessions"
               SET "data" = jsonb_set("data", '{greetingBriefSnapshot,recipientName}', to_jsonb(${`r${++i}`}::text))
             WHERE "id" = ${id}`;
        }
        return (prisma.$queryRaw as any)(strings, ...values);
      }) as any,
    };
    const err = await updateGreetingSnapshot(racing, id, current, () => ({
      set: { sceneCount: 2 },
      expect: 'all',
    })).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('GREETING_EDIT_IN_PROGRESS');
    expect(i).toBe(MAX_SNAPSHOT_WRITE_ATTEMPTS);
    const now = await snapshotOf(id);
    expect(now.sceneCount).toBeUndefined();
    expect(now.recipientName).toBe(`r${MAX_SNAPSHOT_WRITE_ATTEMPTS}`);
  });
});
