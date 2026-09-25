import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SceneTemplateService } from './scene-template.service';

/**
 * Этап 149. Три отказа сервиса — и каждый про то, что иначе сломалось
 * бы молча, уже после того, как ролик снят.
 */
function build(session: Record<string, unknown> | null = {}) {
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new SceneTemplateService(sessions as never),
    sessions,
  };
}

describe('каталог', () => {
  it('отдаёт все приёмы с тем, что экран должен знать до нажатия', () => {
    const { service } = build();
    const rows = service.catalogue();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.id).toBe('string');
      expect(row.beats).toBeGreaterThan(0);
      expect(typeof row.speaksOnCamera).toBe('boolean');
    }
    // По умолчанию озвучиваем мы — значит человек в кадре молчит, и
    // экран должен сказать это сам, а не выяснять отказом на нажатие.
    expect(rows.find((r) => r.id === 'testimonial')?.speaksOnCamera).toBe(
      false,
    );
    expect(
      service.catalogue(false).find((r) => r.id === 'testimonial')
        ?.speaksOnCamera,
    ).toBe(true);
  });
});

describe('выбор приёма', () => {
  it('записывается в сессию со временем выбора', async () => {
    const { service, sessions } = build({});
    await service.put('s1', 'unboxing');
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      sceneTemplate: expect.objectContaining({ templateId: 'unboxing' }),
    });
  });

  it('незнакомый приём — отказ, а не молчаливая запись', async () => {
    // Опечатка записалась бы в сессию, промпт собрался бы вообще без
    // описания сцены, и узнать об этом можно было бы только по готовому
    // ролику (та же ошибка, что аудиты ловили в `locale` на этапах 147
    // и 148).
    const { service, sessions } = build({});
    await expect(service.put('s1', 'распаковка')).rejects.toThrow(
      BadRequestException,
    );
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('поверх разобранного референса приём не выбирается', async () => {
    // В сборке промпта разбор сильнее: запись легла бы в сессию и не
    // сделала бы ничего, а человек считал бы, что снимает по приёму.
    const { service, sessions } = build({
      videoAnalysis: { status: 'complete' },
    });
    await expect(service.put('s1', 'unboxing')).rejects.toThrow(
      ConflictException,
    );
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('отзыв выбирается и при нашей озвучке', async () => {
    // Аудит этапа 149 (А-1): здесь стоял отказ — а `DEFAULT_VOICE_MODE`
    // это `voiceover`, и сессия без бренд-манифеста читается как «наша
    // озвучка». Приём был закрыт почти для всех, и в первую очередь
    // для анонимного новичка, ради которого шаблоны и делались.
    const { service, sessions } = build({
      brandManifestSnapshot: { voiceMode: 'voiceover' },
    });
    await service.put('s1', 'testimonial');
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  it('и в сессии вообще без бренд-манифеста', async () => {
    const { service, sessions } = build({});
    await service.put('s1', 'testimonial');
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  it('провалившийся разбор выбору не мешает', async () => {
    // Наоборот: это первый человек, которому приём и нужен (А-5).
    const { service, sessions } = build({
      videoAnalysis: { status: 'failed' },
    });
    await service.put('s1', 'unboxing');
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  it('null снимает выбор — передумать можно', async () => {
    const { service, sessions } = build({
      sceneTemplate: { templateId: 'unboxing', chosenAt: 'now' },
    });
    await service.put('s1', null);
    // `undefined`, а не `null`: у `updateSession` стирание ключа — это
    // именно `undefined`.
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', {
      sceneTemplate: undefined,
    });
  });

  it('снять выбор можно и при разобранном референсе', async () => {
    // Отказ стоит на ВЫБОРЕ приёма, а не на любом обращении: иначе
    // человек, выбравший приём и потом загрузивший референс, остался бы
    // с выбором, который снять нечем.
    const { service, sessions } = build({
      videoAnalysis: { status: 'complete' },
      sceneTemplate: { templateId: 'unboxing', chosenAt: 'now' },
    });
    await service.put('s1', null);
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  it('чужой сессии нет', async () => {
    const { service } = build(null);
    await expect(service.get('s1')).rejects.toThrow(NotFoundException);
    await expect(service.put('s1', 'unboxing')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('что видно экрану', () => {
  it('выбранный приём и признак разобранного референса', async () => {
    const { service } = build({
      sceneTemplate: { templateId: 'vs-competitor', chosenAt: 'now' },
      videoAnalysis: { status: 'complete' },
    });
    const view = await service.get('s1');
    expect(view.chosen).toBe('vs-competitor');
    expect(view.analysed).toBe(true);
  });

  it('мусор в сессии не выдаётся за выбор', async () => {
    const { service } = build({ sceneTemplate: { templateId: 'нечто' } });
    const view = await service.get('s1');
    expect(view.chosen).toBeNull();
    expect(view.analysed).toBe(false);
  });
});
