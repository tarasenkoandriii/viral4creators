import { QaStandsGenerator } from './qa-stands-generator.service';
import { generatedFixture } from './generated-fixture.testing';
import { AccountMembership } from '../site-core/account/roles';
import { GEMINI_MODEL } from '../../shared/gemini-model';
const m = { accountId: 'a', memberId: 'm' } as AccountMembership;
function fixture() {
  const catalog = { scoped: jest.fn().mockResolvedValue({}) },
    model = {
      generate: jest.fn().mockResolvedValue({
        text: JSON.stringify(generatedFixture()),
        model: GEMINI_MODEL,
        inputTokens: 100,
        outputTokens: 500,
        cachedInputTokens: 0,
      }),
    },
    budget = {
      reserve: jest.fn().mockResolvedValue(true),
      adjust: jest.fn().mockResolvedValue(undefined),
    },
    usage = { record: jest.fn().mockResolvedValue({ costMicroUsd: 100 }) },
    stt = {
      configured: () => true,
      transcribe: jest.fn().mockResolvedValue({
        text: 'Создай кабинет заказов',
        language: 'ru',
        speechConfidence: 0.95,
        seconds: 2,
        billable: true,
      }),
    };
  return {
    catalog,
    model,
    budget,
    usage,
    stt,
    service: new QaStandsGenerator(
      catalog as never,
      model as never,
      budget as never,
      usage as never,
      stt as never,
    ),
  };
}
function audio() {
  const b = Buffer.alloc(128);
  b.write('RIFF');
  b.write('WAVE', 8);
  return b.toString('base64');
}
describe('stand providers accounting and boundaries', () => {
  it('checks access and reserves before generation, charges valid reply', async () => {
    const f = fixture();
    const c = await f.service.generate(m, 'site', {
      description: 'Кабинет заказов и клиентов',
    });
    expect(c.template).toBe('generated');
    expect(f.usage.record.mock.calls[0][1].operation).toBe('qa-stand-plan');
    expect(f.budget.adjust).toHaveBeenCalled();
  });
  it('preserves the explicit user title and rejects oversized title before provider', async () => {
    const f = fixture();
    const c = await f.service.generate(m, 'site', {
      description: 'Кабинет заказов и клиентов',
      title: 'Мой стенд',
    });
    expect(c.title).toBe('Мой стенд');
    f.model.generate.mockClear();
    await expect(
      f.service.generate(m, 'site', {
        description: 'Кабинет заказов и клиентов',
        title: 'x'.repeat(101),
      }),
    ).rejects.toThrow('Название');
    expect(f.model.generate).not.toHaveBeenCalled();
  });
  it('never calls provider without scope or budget', async () => {
    const f = fixture();
    f.catalog.scoped.mockRejectedValue(new Error('denied'));
    await expect(
      f.service.generate(m, 'site', {
        description: 'Кабинет заказов и клиентов',
      }),
    ).rejects.toThrow('denied');
    expect(f.model.generate).not.toHaveBeenCalled();
    const g = fixture();
    g.budget.reserve.mockResolvedValue(false);
    await expect(
      g.service.generate(m, 'site', {
        description: 'Кабинет заказов и клиентов',
      }),
    ).rejects.toThrow('Бюджет');
    expect(g.model.generate).not.toHaveBeenCalled();
  });
  it('rejects paid malformed output and sanitizes unavailable provider', async () => {
    const f = fixture();
    f.model.generate.mockResolvedValue({
      ...(await f.model.generate()),
      text: '{"broken":true}',
    });
    await expect(
      f.service.generate(m, 'site', {
        description: 'Кабинет заказов и клиентов',
      }),
    ).rejects.toThrow('Контракт');
    expect(f.usage.record).toHaveBeenCalled();
    const g = fixture();
    g.model.generate.mockRejectedValue(new Error('SECRET provider body'));
    await expect(
      g.service.generate(m, 'site', {
        description: 'Кабинет заказов и клиентов',
      }),
    ).rejects.toThrow('Генерация временно');
    expect(g.budget.adjust).toHaveBeenCalled();
  });
  it('transcribes, charges seconds and erases audio buffer', async () => {
    const f = fixture();
    const r = await f.service.transcribe(m, 'site', { audio: audio() });
    expect(r.text).toContain('заказов');
    expect(
      f.stt.transcribe.mock.calls[0][0].audio.every((x: number) => x === 0),
    ).toBe(true);
    expect(f.usage.record.mock.calls[0][1].operation).toBe('qa-stand-stt');
  });
  it('rejects invalid audio before provider and charges no-speech paid result', async () => {
    const f = fixture();
    await expect(
      f.service.transcribe(m, 'site', { audio: 'not audio' }),
    ).rejects.toThrow();
    expect(f.stt.transcribe).not.toHaveBeenCalled();
    f.stt.transcribe.mockResolvedValue({
      text: null,
      language: null,
      seconds: 3,
      billable: true,
      reason: 'no_speech',
    } as never);
    await expect(
      f.service.transcribe(m, 'site', { audio: audio() }),
    ).rejects.toThrow('Речь не обнаружена');
    expect(f.usage.record).toHaveBeenCalled();
    expect(f.budget.adjust).toHaveBeenCalled();
  });
});
