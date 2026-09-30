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
  MAX_STYLE_NOTE_PROMPT_LENGTH,
  buildSceneDescription,
  buildScriptPrompt,
  promptSafeNote,
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

  it('голос Soniox (S2): ведущий молчит, речь поверх — даже при режиме бренда veo', () => {
    // Сцена обязана совпасть с рендером Grok (`generateAudio: false`) и
    // постобработкой — та же `greetingVoiceMode` у всех трёх.
    for (const voiceId of [null, 'Maya']) {
      const scene = buildSceneDescription(
        brief({ sonioxVoice: { voiceId, label: null } }),
        'день рождения',
        speech,
        [],
        'veo',
      );
      expect(scene).toMatch(/does NOT say the line out loud/);
      expect(scene).toMatch(/Audio: ambience and music only/);
      expect(scene).not.toMatch(/presenter speaks directly/);
      expect(scene).not.toContain('<AUDIO_0>');
    }
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
      {
        id: 'a',
        label: 'Марина',
        description: null,
        photoUrl: 'https://b/a.jpg',
      },
      {
        id: 'b',
        label: 'дача',
        description: 'веранда летом',
        photoUrl: 'https://b/b.jpg',
      },
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
    const images = [
      {
        id: 'a',
        label: 'Марина',
        description: null,
        photoUrl: 'https://b/a.jpg',
      },
    ] as never;
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

/**
 * Этап B (Г-1, Г-2 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md):
 * «Особый повод» с трауром больше не собирается как праздник — ни в
 * сцене видео, ни в запросе текста.
 */
describe('регистр «Особого повода» в промптах (этап B)', () => {
  const mourning = brief({
    occasion: 'OTHER',
    customOccasionText: 'похороны бабушки',
    occasionRegister: 'MOURNING',
    tone: 'RESPECTFUL',
  });

  it('сцена: без улыбки и без праздничных декораций', () => {
    const scene = buildSceneDescription(
      mourning,
      'похороны бабушки',
      'Марина, мы рядом.',
      [],
      'voiceover',
    );
    expect(scene).not.toMatch(/smiling/);
    expect(scene).toMatch(/no smile/);
    expect(scene).not.toMatch(/festive decor/);
    expect(scene).toMatch(/no confetti/);
  });

  it('праздничная сцена больше не «smiling» по умолчанию, но улыбается по тону', () => {
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      'Марина, с днём рождения!',
      [],
      'voiceover',
    );
    expect(scene).toMatch(/smile/);
  });

  it('запрос текста получает траурный замысел', () => {
    const prompt = buildScriptPrompt(mourning, 'похороны бабушки');
    expect(prompt).toMatch(/ТРАУРНЫЙ повод/);
    expect(prompt).toMatch(/[Нн]е поздравляй/);
  });

  it('у каталожного повода замысел регистра не дублируется', () => {
    const prompt = buildScriptPrompt(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
      'соболезнование',
    );
    expect(prompt).not.toMatch(/ТРАУРНЫЙ повод/);
  });
});

describe('язык поздравления в запросе (этап C, §3.8)', () => {
  it('по умолчанию — русский, как до этапа C', () => {
    expect(buildScriptPrompt(brief(), 'повод')).toContain(
      'на русском языке (Russian)',
    );
  });

  it('язык из брифа уходит в запрос явным названием', () => {
    const p = buildScriptPrompt(brief({ scriptLanguage: 'uk' }), 'повод');
    expect(p).toContain('на украинском языке (Ukrainian)');
    expect(p).not.toContain('на русском языке');
  });

  /**
   * Подписи повода и тона — по-русски. Без отдельной строки модель
   * отвечала на языке подписей, а не на выбранном.
   */
  it('для нерусского языка отдельно требует писать только на нём', () => {
    const p = buildScriptPrompt(
      brief({ scriptLanguage: 'es' }),
      'День рождения',
    );
    expect(p).toContain('строго на испанском языке (Spanish)');
  });

  it('без языка в брифе берётся переданный язык интерфейса сессии', () => {
    expect(buildScriptPrompt(brief(), 'повод', 'de')).toContain('German');
  });
});

describe('ведущий-образ и бренд-бук в сцене (этап G, §4.8, Т-17, Г-6)', () => {
  const afterFlag: Array<() => void> = [];
  afterEach(() => afterFlag.splice(0).forEach((f) => f()));
  const speech = 'Марина, с днём рождения!';
  const PRESENTER = {
    lookId: 'l1',
    label: 'Деловой',
    url: 'https://blob/look.png',
    pathname: 'users/u1/personas/p1/looks/l1.png',
    variant: 'photo' as const,
  };
  const ref = (over: Record<string, unknown> = {}) =>
    ({
      id: 'a',
      label: 'дача',
      description: null,
      photoUrl: 'https://blob/a.jpg',
      hasFace: false,
      ...over,
    }) as never;

  it('образ — <IMAGE_1>, и промпт прямо говорит, кто ведущий; свои фото — со второй метки', () => {
    const scene = buildSceneDescription(
      brief({ presenter: PRESENTER }),
      'день рождения',
      speech,
      [ref()],
      'voiceover',
    );
    expect(scene).toContain('The presenter is the person shown in <IMAGE_1>');
    expect(scene).toContain('<IMAGE_2> — дача');
    expect(scene).not.toContain('<IMAGE_1> — ');
  });

  it('скетч-ведущий — рисованный облик сохраняется', () => {
    const scene = buildSceneDescription(
      brief({ presenter: { ...PRESENTER, variant: 'sketch' } }),
      'день рождения',
      speech,
      [],
      'voiceover',
    );
    expect(scene).toContain('keeping their drawn, illustrated look');
  });

  it('без образа — строки про ведущего нет, метки как раньше', () => {
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [ref()],
      'voiceover',
    );
    expect(scene).not.toContain('The presenter is the person shown');
    expect(scene).toContain('<IMAGE_1> — дача');
  });

  it('фото с лицом без согласия в промпт не попадает (Г-8)', () => {
    const OLD = process.env.PERSONA_ENABLED;
    process.env.PERSONA_ENABLED = 'true';
    afterFlag.push(() => (process.env.PERSONA_ENABLED = OLD));
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [ref({ id: 'x', label: 'соседка', hasFace: true }), ref()],
      'voiceover',
    );
    expect(scene).not.toContain('соседка');
    expect(scene).toContain('<IMAGE_1> — дача');
  });

  it('бренд-бук: стиль и сцены доходят до промпта (Г-6)', () => {
    const scene = buildSceneDescription(
      brief(),
      'день рождения',
      speech,
      [],
      'voiceover',
      {
        styleNotes: 'тёплые "пастельные"\nтона',
        scenes: [
          {
            sourceSceneId: 's1',
            label: 'Офис',
            photoUrl: 'https://blob/o.jpg',
            description: null,
          },
          {
            sourceSceneId: 's2',
            label: 'Пляж',
            photoUrl: null,
            description: 'пляж на закате',
          },
        ],
      },
    );
    // CONTRACT6 п.8 (G-B2): при выключенном `PERSONA_ENABLED` фото сцены
    // бренд-бука картинкой в модель не уходит — только словами.
    expect(scene).not.toContain('<IMAGE_1>');
    expect(scene).toContain(
      'Possible settings from the brand: Офис; пляж на закате.',
    );
    // Кавычки и переводы строк из заметки не ломают реплику в кавычках.
    expect(scene).toContain(
      'Visual style of the brand: тёплые пастельные тона.',
    );
  });

  it('заметка стиля обрезается по потолку', () => {
    expect(promptSafeNote('x'.repeat(1000))).toHaveLength(
      MAX_STYLE_NOTE_PROMPT_LENGTH,
    );
    expect(promptSafeNote(null)).toBe('');
  });
});
