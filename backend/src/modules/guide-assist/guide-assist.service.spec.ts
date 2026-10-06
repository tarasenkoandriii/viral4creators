/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));

import { NotFoundException } from '@nestjs/common';
import {
  GuideAssistDisabledError,
  GuideAssistService,
} from './guide-assist.service';
import { actorOf } from './guide-assist-jwt';
import type { GuideAssistEnv } from './guide-assist-config';

const SECRET = 'j'.repeat(40);
const KEY = 'k'.repeat(40);
const ON: GuideAssistEnv = {
  WIZARD_GUIDE_ENGINE: 'assist',
  WIZARD_GUIDE_ASSIST_SITE_ID: 'site_v4c',
  WIZARD_GUIDE_ASSIST_PK: 'pk_live_v4c',
  WIZARD_GUIDE_ASSIST_ORIGIN: 'https://assist-wa.viral4creators.app',
  WIZARD_GUIDE_ASSIST_JWT_SECRET: SECRET,
  WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: KEY,
};

class TestService extends GuideAssistService {
  constructor(
    prisma: any,
    plan: any,
    private readonly e: GuideAssistEnv,
  ) {
    super(prisma, plan);
  }
  protected env(): GuideAssistEnv {
    return this.e;
  }
}

function build(env: GuideAssistEnv = ON, over: Record<string, any> = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'u1' || where.id === 'u2'
          ? { id: where.id, telegramId: where.id === 'u1' ? '777' : '1' }
          : null,
      ),
    },
    project: {
      // Как база: фильтр — ровно по переданным полям (без userId проект
      // нашёлся бы любому — это и ловит мутация «владение»).
      findFirst: jest.fn(
        async ({ where }: any) =>
          [{ id: 'p1', userId: 'u1', deletedAt: null, type: 'GREETING_VIDEO' }]
            .filter((r: any) =>
              Object.entries(where).every(([k, v]) => r[k] === v),
            )
            .map((r) => ({ type: r.type }))[0] ?? null,
      ),
      findMany: jest.fn(async () => [
        {
          id: 'p1',
          type: 'GREETING_VIDEO',
          updatedAt: new Date('2026-10-05T08:00:00Z'),
          title: 'НЕ ДОЛЖНО УЙТИ',
        },
      ]),
      count: jest.fn(async () => 1),
    },
    session: {
      findFirst: jest.fn(async () => ({
        status: 'CREATED',
        data: {
          greetingBriefSnapshot: {
            occasion: 'BIRTHDAY',
            recipientName: 'Секретная Тётя Маша',
          },
        },
        liveData: {},
      })),
    },
    clientSiteTutorialDraft: { findUnique: jest.fn(async () => null) },
    ...over,
  };
  const plan = { planOfUser: jest.fn(async () => 'STANDARD') };
  return { svc: new TestService(prisma, plan, env), prisma, plan };
}

describe('GuideAssistService — TMA', () => {
  it('флаг выключен — legacy и отказ в JWT', async () => {
    const { svc } = build({});
    await expect(svc.clientConfig('u1')).resolves.toEqual({ engine: 'legacy' });
    await expect(svc.issueIdentity('u1')).rejects.toBeInstanceOf(
      GuideAssistDisabledError,
    );
  });

  it('аноним — legacy (JWT без личности не выписать)', async () => {
    const { svc } = build();
    await expect(svc.clientConfig(null)).resolves.toEqual({ engine: 'legacy' });
  });

  it('assist — pk и origin для загрузчика, JWT с псевдонимом этого человека', async () => {
    const { svc } = build();
    await expect(svc.clientConfig('u1')).resolves.toEqual({
      engine: 'assist',
      pk: 'pk_live_v4c',
      origin: 'https://assist-wa.viral4creators.app',
    });
    const { jwt } = await svc.issueIdentity('u1');
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString(),
    );
    expect(payload.sub).toBe(actorOf('u1', SECRET));
    expect(payload.aud).toBe('site_v4c');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(900);
  });

  it('pilot — JWT только участнику пилота', async () => {
    const { svc } = build({
      ...ON,
      WIZARD_GUIDE_ENGINE: 'pilot',
      WIZARD_GUIDE_ASSIST_PILOT: '777',
    });
    await expect(svc.issueIdentity('u1')).resolves.toHaveProperty('jwt');
    await expect(svc.issueIdentity('u2')).rejects.toBeInstanceOf(
      GuideAssistDisabledError,
    );
    await expect(svc.clientConfig('u2')).resolves.toEqual({ engine: 'legacy' });
  });
});

describe('GuideAssistService — факты для коннектора', () => {
  it('X-V4C-Actor: свой псевдоним → пользователь; подделка и удалённый — null', async () => {
    const { svc } = build();
    await expect(svc.userOfActor(actorOf('u1', SECRET))).resolves.toBe('u1');
    await expect(
      svc.userOfActor(actorOf('u1', SECRET).replace('u1', 'u2')),
    ).resolves.toBeNull();
    await expect(svc.userOfActor(actorOf('gone', SECRET))).resolves.toBeNull();
    await expect(svc.userOfActor('u1')).resolves.toBeNull();
  });

  it('API выключен без ключа коннектора — actor не принимается', async () => {
    const { svc } = build({ ...ON, WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: '' });
    expect(svc.factsConfig()).toBeNull();
    await expect(svc.userOfActor(actorOf('u1', SECRET))).resolves.toBeNull();
  });

  it('факты своего проекта — словами, без значений полей', async () => {
    const { svc } = build();
    const v = await svc.projectFacts('u1', 'p1');
    expect(v.scenario).toBe('GREETING_VIDEO');
    expect(v.facts).toContain('повод задан');
    expect(v.facts).toContain('получатель назван');
    const text = JSON.stringify(v);
    expect(text).not.toContain('Секретная');
    expect(text).not.toContain('BIRTHDAY');
  });

  it('чужой проект — 404, факты не читаются', async () => {
    const { svc, prisma } = build();
    await expect(svc.projectFacts('u2', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });

  it('список проектов — без названий', async () => {
    const { svc } = build();
    const r = await svc.listProjects('u1', new Date('2026-10-05T12:00:00Z'));
    expect(r.projects).toEqual([
      {
        id: 'p1',
        order: 1,
        type: 'GREETING_VIDEO',
        scenario: 'GREETING_VIDEO',
        scenarioTitle: 'видеопоздравление',
        updated: 'сегодня',
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('НЕ ДОЛЖНО');
  });

  it('сводка аккаунта — тариф и число проектов этого человека', async () => {
    const { svc, prisma, plan } = build();
    await expect(svc.accountSummary('u1')).resolves.toEqual({
      plan: 'STANDARD',
      projects: 1,
    });
    expect(plan.planOfUser).toHaveBeenCalledWith('u1');
    expect(prisma.project.count).toHaveBeenCalledWith({
      where: { userId: 'u1', deletedAt: null },
    });
  });
});
