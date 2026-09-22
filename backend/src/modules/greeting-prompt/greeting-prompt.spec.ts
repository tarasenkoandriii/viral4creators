/**
 * Запрос к модели на текст сообщения — этап 2, фича №1.
 *
 * Смысл этих тестов ровно один: доказать, что повод влияет на то, ЧТО
 * модель напишет, а не только на подставленное слово. Мутационная
 * проверка этапа показала, что без них выброшенная инструкция повода не
 * роняла ничего — то есть «20 поводов» могли незаметно выродиться в «20
 * меток», против чего и написан весь `greeting-occasions.ts`.
 */
// Цепочка импортов сервиса задевает @prisma/client напрямую (через
// SessionService) — в песочнице клиент не сгенерирован, и модуль упал бы
// при ЗАГРУЗКЕ, не дойдя до теста. Тот же приём, что в
// shared-video.service.spec.ts: подменяем модули заглушками до импорта.
// Проверяемая функция чистая и ни одной из этих зависимостей не
// касается.
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  buildSceneDescription,
  buildScriptPrompt,
} from './greeting-prompt.service';
import { GREETING_OCCASIONS } from '../../common/types/greeting.types';
import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import type { GreetingBriefSnapshot } from '../../common/types/greeting.types';

const brief = (over: Partial<GreetingBriefSnapshot> = {}) =>
  ({
    sourceGreetingBriefId: 'gb1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    addedAt: '2026-09-22T10:00:00.000Z',
    ...over,
  }) as GreetingBriefSnapshot;

describe('buildScriptPrompt', () => {
  it('инструкция повода уходит в запрос — у каждого повода без исключения', () => {
    for (const occasion of GREETING_OCCASIONS) {
      const prompt = buildScriptPrompt(brief({ occasion }), 'повод');
      expect(prompt).toContain(GREETING_OCCASION_SPECS[occasion].intent);
    }
  });

  it('соболезнование просит не поздравлять, день рождения — поздравить', () => {
    const condolence = buildScriptPrompt(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
      'соболезнование',
    );
    expect(condolence).toMatch(/[Нн]е поздравляй/);

    const birthday = buildScriptPrompt(
      brief({ occasion: 'BIRTHDAY' }),
      'день рождения',
    );
    expect(birthday).toMatch(/[Пп]оздравь/);
    expect(birthday).not.toMatch(/[Нн]е поздравляй/);
  });

  /**
   * Просить «поздравление» на повод «соболезнование» — значит толкать
   * модель ровно к той ошибке, которую предотвращает инструкция ниже в
   * том же запросе. Поэтому запрос говорит «сообщение».
   */
  it('сам запрос не называет результат поздравлением', () => {
    const prompt = buildScriptPrompt(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
      'соболезнование',
    );
    expect(prompt).not.toMatch(/текст поздравления/);
  });

  it('повод, получатель, отправитель и тон попадают в запрос', () => {
    const prompt = buildScriptPrompt(brief(), 'день рождения');
    expect(prompt).toContain('Повод: день рождения.');
    expect(prompt).toContain('Получатель: Марина.');
    expect(prompt).toContain('От кого: Андрей.');
    expect(prompt).toContain('Тон: тёплый, душевный.');
  });

  it('без отправителя строка «От кого» не появляется пустой', () => {
    const prompt = buildScriptPrompt(brief({ senderName: null }), 'повод');
    expect(prompt).not.toContain('От кого');
  });
});

describe('buildSceneDescription — кто произносит реплику', () => {
  const speech = 'Марина, с днём рождения!';

  it('озвучиваем мы — сцена прямо запрещает произносить реплику в кадре', () => {
    // Иначе модель прочитает поздравление своим голосом, а наша
    // дорожка ляжет поверх приглушённого оригинала (`amix` в
    // `common/postprod.ts`) — слышно будет обе.
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [],
      'voiceover',
    );
    expect(scene).toMatch(/does NOT say the line out loud/);
    expect(scene).toMatch(/no audible speech/);
    // И звуковая дорожка модели должна остаться атмосферой, а не речью:
    // без этой строки Grok охотно добавляет реплику «за кадром».
    expect(scene).toMatch(/Audio: ambience and music only/);
    expect(scene).not.toMatch(/presenter speaks directly/);
  });

  it('дубляж — то же самое: звук всё равно наш', () => {
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [],
      'dub',
    );
    expect(scene).toMatch(/does NOT say the line out loud/);
  });

  it('говорит модель (режим veo) — прежняя формулировка сохранена', () => {
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [],
      'veo',
    );
    expect(scene).toMatch(/presenter speaks directly to the viewer/);
    expect(scene).not.toMatch(/does NOT say the line out loud/);
    expect(scene).not.toMatch(/Audio: ambience and music only/);
  });

  it('ведущий остаётся в кадре и в молчаливом режиме — это не закадровый ролик', () => {
    // `voiceModeBriefText` для товарных роликов запрещает говорящие
    // головы вообще; у поздравления ведущий в кадре и есть продукт.
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [],
      'voiceover',
    );
    expect(scene).toMatch(/camera-facing presenter/);
    expect(scene).toMatch(/gesturing and reacting/);
  });

  it('тон и декорации повода не зависят от режима озвучки', () => {
    for (const mode of ['veo', 'voiceover', 'dub'] as const) {
      const scene = buildSceneDescription(
        brief({ tone: 'FUNNY' }),
        'день рождения',
        speech,
        [],
        mode,
      );
      expect(scene).toContain('playful and lighthearted');
      expect(scene).toContain(GREETING_OCCASION_SPECS.BIRTHDAY.sceneMood);
      expect(scene).toContain('no on-screen text');
    }
  });

  it('референсы размечаются метками <IMAGE_n> в обоих режимах', () => {
    const images = [
      { id: 'a', label: 'Марина', description: null },
      { id: 'b', label: 'дача', description: 'веранда летом' },
    ] as never;
    for (const mode of ['veo', 'voiceover'] as const) {
      const scene = buildSceneDescription(
        brief(),
        'день рождения',
        speech,
        images,
        mode,
      );
      expect(scene).toContain('<IMAGE_1> — Марина');
      expect(scene).toContain('<IMAGE_2> — веранда летом');
    }
  });
});

describe('buildSceneDescription — пресетный голос xAI', () => {
  const speech = 'Марина, с днём рождения!';
  const withPreset = brief({ presetVoiceId: 'eve' } as never);

  it('ведущий произносит реплику голосом из <AUDIO_0>', () => {
    // Метка обязана стоять В ТЕКСТЕ промпта рядом с упоминанием — так
    // же, как <IMAGE_n> у картинок (docs.x.ai, Reference-to-Video).
    const scene = buildSceneDescription(
      withPreset,
      'день рождения',
      speech,
      [],
      'voiceover',
    );
    expect(scene).toContain('<AUDIO_0>');
    expect(scene).toMatch(/speaks directly to the viewer with the voice from/);
  });

  it('пресет перебивает молчаливую формулировку, даже когда режим voiceover', () => {
    // Иначе промпт просил бы молчать, а мы бы ждали от модели речь.
    const scene = buildSceneDescription(
      withPreset,
      'день рождения',
      speech,
      [],
      'voiceover',
    );
    expect(scene).not.toMatch(/does NOT say the line out loud/);
    expect(scene).not.toMatch(/Audio: ambience and music only/);
  });

  it('реплика помечена как произносимая вслух, но не экранным текстом', () => {
    const scene = buildSceneDescription(
      withPreset,
      'день рождения',
      speech,
      [],
      'voiceover',
    );
    expect(scene).toMatch(/to be said aloud by the presenter/);
    expect(scene).toContain('never rendered as on-screen text');
    expect(scene).toContain(speech);
  });

  it('пресета нет — метки <AUDIO_0> в промпте не появляется', () => {
    for (const mode of ['veo', 'voiceover', 'dub'] as const) {
      const scene = buildSceneDescription(
        brief(),
        'день рождения',
        speech,
        [],
        mode,
      );
      expect(scene).not.toContain('<AUDIO_0>');
    }
  });

  it('голос и картинки-референсы уживаются в одном промпте', () => {
    // docs.x.ai: «You can use a voice alongside reference images or on
    // its own» — обе разметки должны остаться.
    const images = [{ id: 'a', label: 'Марина', description: null }] as never;
    const scene = buildSceneDescription(
      withPreset,
      'день рождения',
      speech,
      images,
      'voiceover',
    );
    expect(scene).toContain('<AUDIO_0>');
    expect(scene).toContain('<IMAGE_1> — Марина');
  });
});
