import { TtsProviderResolverService } from './tts-provider-resolver.service';
import { DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY } from './default-tts-provider';

function build(storedValue: string | null) {
  const settings = { get: jest.fn().mockResolvedValue(storedValue) };
  const eleven = { providerKey: 'elevenlabs', marker: 'eleven' };
  const resemble = { providerKey: 'resemble', marker: 'resemble' };
  const veo = { providerKey: 'veo', marker: 'veo' };
  const soniox = { providerKey: 'soniox', marker: 'soniox' };
  const resolver = new TtsProviderResolverService(
    settings as never,
    eleven as never,
    resemble as never,
    veo as never,
    soniox as never,
  );
  return { resolver, settings, eleven, resemble, veo, soniox };
}

describe('TtsProviderResolverService', () => {
  const keyBefore = process.env.TTS_PROVIDER;
  afterEach(() => {
    if (keyBefore === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = keyBefore;
  });

  it('читает настройку по правильному ключу', async () => {
    const { resolver, settings } = build('resemble');
    await resolver.resolve();
    expect(settings.get).toHaveBeenCalledWith(
      DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
    );
  });

  it('elevenlabs в настройке — возвращает именно ElevenLabsService', async () => {
    const { resolver, eleven } = build('elevenlabs');
    await expect(resolver.resolve()).resolves.toBe(eleven);
  });

  it('soniox в настройке — возвращает именно SonioxTtsService (решение владельца 29.09.2026)', async () => {
    const { resolver, soniox } = build('soniox');
    await expect(resolver.resolve()).resolves.toBe(soniox);
    expect(resolver.resolveByKey('soniox')).toBe(soniox);
  });

  it('resemble в настройке — возвращает именно ResembleService', async () => {
    const { resolver, resemble } = build('resemble');
    await expect(resolver.resolve()).resolves.toBe(resemble);
  });

  it('veo в настройке — возвращает VeoPassthroughService (fallback всегда доступен)', async () => {
    const { resolver, veo } = build('veo');
    await expect(resolver.resolve()).resolves.toBe(veo);
  });

  it('настройка не задана (null) — откат на TTS_PROVIDER из окружения', async () => {
    delete process.env.TTS_PROVIDER;
    process.env.TTS_PROVIDER = 'resemble';
    const { resolver, resemble } = build(null);
    await expect(resolver.resolve()).resolves.toBe(resemble);
  });

  it('ни настройка, ни окружение — умолчание resemble (решение владельца, §7.2)', async () => {
    delete process.env.TTS_PROVIDER;
    const { resolver, resemble } = build(null);
    await expect(resolver.resolve()).resolves.toBe(resemble);
  });

  it('мусор в настройке — не роняет резолвер, откатывается как «не задано»', async () => {
    delete process.env.TTS_PROVIDER;
    const { resolver, resemble } = build('cartesia');
    await expect(resolver.resolve()).resolves.toBe(resemble);
  });

  it('resolveKey отдаёт голый ключ без похода за самим провайдером повторно', async () => {
    const { resolver } = build('veo');
    await expect(resolver.resolveKey()).resolves.toBe('veo');
  });
});
