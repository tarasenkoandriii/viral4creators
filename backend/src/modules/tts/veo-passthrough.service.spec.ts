import { VeoPassthroughService } from './veo-passthrough.service';

describe('VeoPassthroughService', () => {
  it('providerKey — "veo"', () => {
    expect(new VeoPassthroughService().providerKey).toBe('veo');
  });

  it('всегда "не настроен" — нечего настраивать, не "сломан"', () => {
    expect(new VeoPassthroughService().configured()).toBe(false);
  });

  it('synthesize всегда мягко пропускает, без сетевых вызовов', async () => {
    const svc = new VeoPassthroughService();
    const result = await svc.synthesize({ text: 'привіт' });
    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: expect.any(String),
    });
  });

  it('voices — пустой каталог с пояснением, не ошибка', async () => {
    const { voices, error } = await new VeoPassthroughService().voices();
    expect(voices).toEqual([]);
    expect(error).toEqual(expect.any(String));
  });
});
