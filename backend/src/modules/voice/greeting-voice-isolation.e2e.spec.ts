/** Real voice controller + global owner guard; DB, identity and paid services are fixtures. */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { PrismaService } from '../../prisma/prisma.service';
import { RateLimitGuard } from '../../common/rate-limit';
import { SessionOwnerGuard } from '../telegram-auth/session-owner.guard';
import { GreetingVoiceController } from './greeting-voice.controller';
import { GreetingVoiceService } from './greeting-voice.service';
import { GreetingVoiceUnderstandService } from './greeting-voice-understand.service';

const routes = ['upload-url', 'transcribe', 'understand'];

describe('session voice HTTP isolation', () => {
  let app: INestApplication;
  const prisma = {
    session: { findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  const voice = { createUploadUrl: jest.fn() };
  const understanding = {
    transcribeForSession: jest.fn(),
    understandForSession: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [GreetingVoiceController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: GreetingVoiceService, useValue: voice },
        { provide: GreetingVoiceUnderstandService, useValue: understanding },
        { provide: APP_GUARD, useClass: SessionOwnerGuard },
      ],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    // Test-only identity seam, not a production authentication mechanism.
    app.use(
      (
        req: { headers: Record<string, string>; telegramUserId?: string },
        _res: unknown,
        next: () => void,
      ) => {
        req.telegramUserId = req.headers['x-test-identity'];
        next();
      },
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({ userId: 'owner-A' });
    voice.createUploadUrl.mockResolvedValue({ pathname: 'fixture' });
    understanding.transcribeForSession.mockResolvedValue({ status: 'ok' });
    understanding.understandForSession.mockResolvedValue({ status: 'ok' });
  });

  function expectNoPaidOrUploadWork() {
    expect(voice.createUploadUrl).not.toHaveBeenCalled();
    expect(understanding.transcribeForSession).not.toHaveBeenCalled();
    expect(understanding.understandForSession).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  }

  it.each(routes)(
    '%s: another user cannot reach upload/provider services',
    async (route) => {
      await request(app.getHttpServer())
        .post(`/api/sessions/s-A/voice/${route}`)
        .set('x-test-identity', 'user-B')
        .send({ userId: 'owner-A' })
        .expect(403);
      expectNoPaidOrUploadWork();
    },
  );

  it.each(routes)(
    '%s: UUID and spoofed body/header identity do not authorize an anonymous caller',
    async (route) => {
      await request(app.getHttpServer())
        .post(`/api/sessions/s-A/voice/${route}`)
        .set('x-user-id', 'owner-A')
        .send({ userId: 'owner-A', telegramUserId: 'owner-A' })
        .expect(403);
      expectNoPaidOrUploadWork();
    },
  );

  it.each(routes)(
    '%s: authenticated owner reaches only the intended service',
    async (route) => {
      await request(app.getHttpServer())
        .post(`/api/sessions/s-A/voice/${route}`)
        .set('x-test-identity', 'owner-A')
        .send({ pathname: 'fixture', screen: { step: 'brief' } })
        .expect(201);
      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { id: 's-A' },
        select: { userId: true },
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      const calls = [
        voice.createUploadUrl,
        understanding.transcribeForSession,
        understanding.understandForSession,
      ];
      expect(calls.reduce((sum, fn) => sum + fn.mock.calls.length, 0)).toBe(1);
      expect(calls[routes.indexOf(route)]).toHaveBeenCalled();
    },
  );

  it('retains anonymous capability access for an unowned session without assigning another owner', async () => {
    prisma.session.findUnique.mockResolvedValue({ userId: null });
    await request(app.getHttpServer())
      .post('/api/sessions/guest/voice/understand')
      .send({ pathname: 'fixture', screen: { step: 'brief' } })
      .expect(201);
    expect(understanding.understandForSession).toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
