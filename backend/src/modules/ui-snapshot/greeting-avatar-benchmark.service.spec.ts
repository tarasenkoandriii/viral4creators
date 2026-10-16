import { GreetingAvatarBenchmarkService } from './greeting-avatar-benchmark.service';
import { mp3DurationSeconds } from '../../common/mp3-duration';
import { FIXTURE_IDS } from '../tutorial-runner/fixture-seed';
jest.mock('../../common/mp3-duration', () => ({
  mp3DurationSeconds: jest.fn(() => 9),
}));
const audioUrl =
  'https://store.public.blob.vercel-storage.com/sessions/source/voice.mp3';
function build() {
  const source = {
    id: 'source',
    userId: 'fixture-user',
    projectId: FIXTURE_IDS.greetingDoneProject,
    data: {
      greetingBriefSnapshot: { occasion: 'NEW_YEAR', tone: 'WARM' },
      greetingReferenceImages: [
        {
          photoUrl:
            'https://store.public.blob.vercel-storage.com/sessions/source/photo.jpg',
        },
      ],
    },
    liveData: {
      generatedVideo: {
        generatedVideoId: 'v1',
        status: 'complete',
        speechBakedIn: true,
        voiceoverUrl: audioUrl,
        voiceCharacters: 133,
      },
    },
  };
  const prisma = {
    session: {
      findFirst: jest.fn().mockResolvedValue(source),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const sessions = { updateSession: jest.fn().mockResolvedValue({}) };
  const hedra = {
    balanceUsd: jest.fn().mockResolvedValue(5),
    submit: jest.fn().mockResolvedValue({ jobId: 'job1' }),
  };
  const blob = {
    uploadBuffer: jest.fn().mockResolvedValue({
      url: 'https://store.public.blob.vercel-storage.com/sessions/bench/voice.mp3',
    }),
  };
  const usage = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new GreetingAvatarBenchmarkService(
    prisma as never,
    sessions as never,
    hedra as never,
    blob as never,
    usage as never,
  );
  return { svc, prisma, sessions, hedra, blob, usage, source };
}
const originalFetch = global.fetch;
beforeEach(() => {
  jest.mocked(mp3DurationSeconds).mockReturnValue(9);
  global.fetch = jest
    .fn()
    .mockResolvedValue(new Response(Buffer.from('same Nova bytes')));
});
afterEach(() => {
  global.fetch = originalFetch;
});
it('only accepts the known fixture project and never starts for a missing source', async () => {
  const { svc, prisma, hedra } = build();
  prisma.session.findFirst.mockResolvedValue(null);
  await expect(svc.run('customer')).rejects.toThrow('Только тестовый');
  expect(prisma.session.findFirst).toHaveBeenCalledWith({
    where: {
      id: 'customer',
      projectId: FIXTURE_IDS.greetingDoneProject,
      deletedAt: null,
    },
  });
  expect(hedra.submit).not.toHaveBeenCalled();
});
it('a repeated request returns the claimed job without another paid call', async () => {
  const { svc, prisma, hedra } = build();
  prisma.session.findUnique.mockResolvedValue({
    status: 'generating',
  } as never);
  expect(await svc.run('source')).toMatchObject({
    reused: true,
    state: 'generating',
  });
  expect(hedra.balanceUsd).not.toHaveBeenCalled();
  expect(hedra.submit).not.toHaveBeenCalled();
});
it('the unique session claim prevents a parallel paid duplicate', async () => {
  const { svc, prisma, hedra } = build();
  prisma.session.create.mockRejectedValue({ code: 'P2002' });
  expect(await svc.run('source')).toMatchObject({ reused: true });
  expect(hedra.submit).not.toHaveBeenCalled();
});
it('reuses exact audio bytes, stores its own copy and requests explicit Kling Pro', async () => {
  const { svc, sessions, hedra, blob, usage } = build();
  expect(await svc.run('source')).toMatchObject({
    state: 'processing',
    reused: false,
  });
  expect(blob.uploadBuffer.mock.calls[0][1]).toEqual(
    Buffer.from('same Nova bytes'),
  );
  expect(hedra.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'kling-ai-avatar-v2',
      quality: 'pro',
      audioUrl:
        'https://store.public.blob.vercel-storage.com/sessions/bench/voice.mp3',
    }),
  );
  expect(sessions.updateSession).toHaveBeenCalledWith(expect.any(String), {
    generatedVideo: expect.objectContaining({
      hedraJobId: 'job1',
      speechBakedIn: true,
      hedraModel: 'kling-ai-avatar-v2',
    }),
  });
  expect(usage.record).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'kling-ai-avatar-v2', calls: 1 }),
  );
});
it('rejects long audio before upload and paid submission', async () => {
  const { svc, hedra, blob } = build();
  jest.mocked(mp3DurationSeconds).mockReturnValue(13);
  await expect(svc.run('source')).rejects.toThrow('12 секундами');
  expect(blob.uploadBuffer).not.toHaveBeenCalled();
  expect(hedra.submit).not.toHaveBeenCalled();
});
it('refuses an external audio URL before download or payment', async () => {
  const { svc, source, hedra } = build();
  source.liveData.generatedVideo.voiceoverUrl = 'https://example.com/secret';
  await expect(svc.run('source')).rejects.toThrow('Нужны готовый');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(hedra.submit).not.toHaveBeenCalled();
});
