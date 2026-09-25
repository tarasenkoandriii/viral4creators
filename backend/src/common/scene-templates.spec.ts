import {
  MAX_TEMPLATE_BEATS,
  PRODUCT_CLIP_SECONDS,
  SCENE_TEMPLATES,
  SCENE_TEMPLATE_IDS,
  isSceneTemplateId,
  sceneTemplate,
  speaksOnCamera,
  splitBeatDurations,
  templateBreakdown,
  templateFraming,
  usesTemplate,
} from './scene-templates';

/**
 * Этап 149. Шаблон заменяет референс — значит всё, что промпт брал у
 * разбора, он должен взять здесь, и ни одной строкой меньше.
 */
describe('каталог', () => {
  it('в каталоге ровно те приёмы, что объявлены', () => {
    expect(Object.keys(SCENE_TEMPLATES).sort()).toEqual(
      [...SCENE_TEMPLATE_IDS].sort(),
    );
  });

  it('у каждого приёма id совпадает с ключом — иначе выбор уедет на соседний', () => {
    for (const id of SCENE_TEMPLATE_IDS) {
      expect(SCENE_TEMPLATES[id].id).toBe(id);
    }
  });

  it('кадров от одного до трёх: в восьми секундах четвёртый — это нарезка', () => {
    for (const id of SCENE_TEMPLATE_IDS) {
      const spec = SCENE_TEMPLATES[id];
      expect(spec.beats.length).toBeGreaterThan(0);
      expect(spec.beats.length).toBeLessThanOrEqual(MAX_TEMPLATE_BEATS);
    }
  });

  it('у каждого приёма есть ремесло — ради него шаблон и нужен', () => {
    // Приём без правил формата — это просто слово в списке: человек и
    // сам напишет «распаковка», а вот что при этом нельзя рвать
    // коробку в первом кадре, он не знает.
    for (const id of SCENE_TEMPLATE_IDS) {
      expect(SCENE_TEMPLATES[id].craft.length).toBeGreaterThan(0);
    }
  });

  it('незнакомый идентификатор не проходит', () => {
    expect(isSceneTemplateId('unboxing')).toBe(true);
    expect(isSceneTemplateId('распаковка')).toBe(false);
    expect(isSceneTemplateId('')).toBe(false);
    expect(isSceneTemplateId(null)).toBe(false);
    expect(isSceneTemplateId(1)).toBe(false);
  });
});

describe('озвучка и человек в кадре', () => {
  it('ни один приём не требует речи на камеру', () => {
    // Аудит этапа 149 (А-1): первая версия писала в кадры отзыва «talks
    // directly to the lens» и тем создавала конфликт с брифом §15.1 —
    // а тот запрещает не человека в кадре, а РЕЧЬ на камеру. Конфликт
    // был свой собственный, и снят он правкой формулировки.
    for (const id of SCENE_TEMPLATE_IDS) {
      const text = JSON.stringify(sceneTemplate(id)).toLowerCase();
      expect(text).not.toContain('talks directly');
      expect(text).not.toContain('speaking straight to camera');
    }
  });

  it('при нашей озвучке человек в кадре не говорит', () => {
    // Это информация экрану, а не запрет: слова несёт наша дорожка.
    expect(speaksOnCamera(sceneTemplate('testimonial'), true)).toBe(false);
    expect(speaksOnCamera(sceneTemplate('testimonial'), false)).toBe(true);
  });

  it('там, где лица нет, говорить некому в любом режиме', () => {
    expect(speaksOnCamera(sceneTemplate('unboxing'), false)).toBe(false);
    expect(speaksOnCamera(sceneTemplate('before-after'), false)).toBe(false);
    expect(speaksOnCamera(sceneTemplate('vs-competitor'), false)).toBe(false);
  });
});

describe('разбор против приёма', () => {
  it('приём работает, пока разбор НЕ завершён', () => {
    // Ключ — завершённость, а не наличие записи (аудит этапа 149,
    // А-5). При `!videoAnalysis` провалившийся разбор перебивал приём,
    // и промпт уходил в модель с пустым описанием сцены, а следом шёл
    // платный рендер.
    expect(usesTemplate(undefined, 'unboxing')).toBe(true);
    expect(usesTemplate(null, 'unboxing')).toBe(true);
    expect(usesTemplate('failed', 'unboxing')).toBe(true);
    expect(usesTemplate('pending', 'unboxing')).toBe(true);
    expect(usesTemplate('processing', 'unboxing')).toBe(true);
  });

  it('завершённый разбор сильнее приёма', () => {
    expect(usesTemplate('complete', 'unboxing')).toBe(false);
  });

  it('без приёма разбор решает в любом случае', () => {
    expect(usesTemplate('failed', undefined)).toBe(false);
    expect(usesTemplate('failed', 'распаковка')).toBe(false);
    expect(usesTemplate(undefined, null)).toBe(false);
  });
});

describe('деление секунд', () => {
  it('сумма всегда равна длине ролика', () => {
    for (let n = 1; n <= MAX_TEMPLATE_BEATS; n++) {
      const parts = splitBeatDurations(PRODUCT_CLIP_SECONDS, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(PRODUCT_CLIP_SECONDS);
    }
  });

  it('остаток достаётся первым кадрам, а не последнему', () => {
    // Последний кадр — развязка, лишняя секунда там читается паузой.
    expect(splitBeatDurations(8, 3)).toEqual([3, 3, 2]);
    expect(splitBeatDurations(8, 2)).toEqual([4, 4]);
  });

  it('мусор на входе не даёт нулевых и отрицательных кадров', () => {
    expect(splitBeatDurations(8, 0)).toEqual([8]);
    expect(splitBeatDurations(8, -5)).toEqual([8]);
    expect(splitBeatDurations(8, 99)).toHaveLength(MAX_TEMPLATE_BEATS);
    expect(splitBeatDurations(0, 2)).toEqual([1, 1]);
  });
});

describe('текст вместо разбора', () => {
  it('в тексте есть все кадры, их порядок и их секунды', () => {
    const spec = sceneTemplate('unboxing');
    const text = templateBreakdown(spec);
    for (const beat of spec.beats) expect(text).toContain(beat);
    expect(text).toContain('Shot 1 (~3s)');
    expect(text).toContain('Shot 3 (~2s)');
    expect(text.indexOf(spec.beats[0])).toBeLessThan(
      text.indexOf(spec.beats[1]),
    );
  });

  it('правила формата доезжают до промпта дословно', () => {
    // Ремесло приёма — единственное, чего человек не знает сам; если
    // оно останется в каталоге и не дойдёт до модели, шаблон
    // бесполезен.
    const spec = sceneTemplate('before-after');
    const text = templateBreakdown(spec);
    for (const rule of spec.craft) expect(text).toContain(rule);
  });

  it('односценовый приём не получает раскадровки', () => {
    const text = templateBreakdown({
      ...sceneTemplate('unboxing'),
      beats: ['one long take of the product on a table'],
    });
    expect(text).toContain('single continuous shot');
    expect(text).not.toContain('Shot 1');
    expect(text).not.toContain('hard cuts');
  });

  it('лишние кадры сверх потолка не уезжают в промпт', () => {
    const text = templateBreakdown({
      ...sceneTemplate('unboxing'),
      beats: ['a', 'b', 'c', 'd-fourth-beat'],
    });
    expect(text).not.toContain('d-fourth-beat');
    expect(text).toContain('3 consecutive shots');
  });

  it('у всех приёмов каталога текст собирается и непуст', () => {
    for (const id of SCENE_TEMPLATE_IDS) {
      expect(templateBreakdown(sceneTemplate(id)).length).toBeGreaterThan(100);
    }
  });
});

describe('как промпт представляет вход', () => {
  it('не выдаёт шаблон за существующий ролик', () => {
    // Рядом в промпте стоят «recreate» и «following the reference's
    // rhythm»: сказать модели «ниже описание существующего вирусного
    // ролика» значило бы отправить её искать ритм того, чего нет.
    const framing = templateFraming();
    expect(framing).toContain('no reference video');
    expect(framing).not.toContain('existing');
  });
});
