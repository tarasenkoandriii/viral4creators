/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { AdminTutorialVoiceSettingsService } from './admin-tutorial-voice-settings.service';

function build(stored: string | null = null, configured = true) {
  const settings = {
    get: jest.fn().mockResolvedValue(stored),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const provider = {
    providerKey: 'elevenlabs',
    configured: jest.fn().mockReturnValue(configured),
  };
  const tts = { resolve: jest.fn().mockResolvedValue(provider) };
  const service = new AdminTutorialVoiceSettingsService(
    settings as any,
    tts as any,
  );
  return { service, settings, tts, provider };
}

describe('AdminTutorialVoiceSettingsService', () => {
  it('ничего не задано — выключено, и сказано, что включить можно', async () => {
    const { service } = build();

    const view = await service.view();

    expect(view).toMatchObject({
      enabled: false,
      voiceId: null,
      provider: 'elevenlabs',
      providerConfigured: true,
    });
    expect(view.effect).toMatch(/выключена/);
  });

  it('провайдер не настроен — переключатель бессмыслен, и витрина это говорит', async () => {
    // Выключатель при ненастроенном провайдере выглядел бы
    // работающим и не делал бы ничего.
    const { service } = build('on', false);

    const view = await service.view();

    expect(view.providerConfigured).toBe(false);
    expect(view.effect).toMatch(/не настроен/);
  });

  it('включено с голосом — оба поля видны оператору', async () => {
    const { service } = build('on:rachel-42');

    expect(await service.view()).toMatchObject({
      enabled: true,
      voiceId: 'rachel-42',
    });
  });

  it('грамматика собирается за оператора: он присылает два поля', async () => {
    // Оператору не место в разборе формата `off|on|on:<id>`.
    const { service, settings } = build();

    await service.set(
      {
        enabled: true,
        voiceId: 'rachel-42',
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialVoice',
      'on:rachel-42',
      'op-1',
    );
  });

  it('пустой голос — это «по умолчанию», а не голос с пустым id', async () => {
    const { service, settings } = build();

    await service.set(
      {
        enabled: true,
        voiceId: '  ',
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialVoice',
      'on',
      'op-1',
    );
  });

  it('выключение стирает и голос — иначе он вернулся бы при включении', async () => {
    const { service, settings } = build();

    await service.set(
      {
        enabled: false,
        voiceId: 'rachel-42',
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialVoice',
      'off',
      'op-1',
    );
  });

  it('ответ на запись — свежая витрина, а не эхо запроса', async () => {
    const { service, settings } = build();
    settings.get.mockResolvedValue('on');

    expect(
      await service.set(
        {
          enabled: true,
          requireNarrationReview: false,
          captions: true,
          motion: 'none',
          pointer: false,
        },
        'op-1',
      ),
    ).toMatchObject({
      enabled: true,
    });
  });
});

describe('AdminTutorialVoiceSettingsService — вычитка реплик (этап D)', () => {
  function build(stored: Record<string, string | null> = {}) {
    const settings = {
      get: jest.fn(async (key: string) => stored[key] ?? null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const tts = {
      resolve: jest.fn().mockResolvedValue({
        providerKey: 'elevenlabs',
        configured: () => true,
      }),
    };
    const service = new AdminTutorialVoiceSettingsService(
      settings as never,
      tts as never,
    );
    return { service, settings };
  }

  it('по умолчанию выключено — и это ОБРАТНОЕ умолчание самой озвучки', () => {
    // Там выключатель бережёт деньги ($6 за набор). Здесь беречь
    // нечего: ошибка в реплике стоит пересборки за $0.12, а шлагбаум
    // стоит того, что роликов не будет вовсе (§3-бис.5 ТЗ).
    return expect(
      build({ 'postprod.tutorialVoice': 'on' })
        .service.view()
        .then((v) => v.requireNarrationReview),
    ).resolves.toBe(false);
  });

  it('включённое требование видно в витрине', async () => {
    const { service } = build({
      'postprod.tutorialVoice': 'on',
      'tutorial.requireNarrationReview': 'on',
    });

    expect((await service.view()).requireNarrationReview).toBe(true);
  });

  it('фраза «что произойдёт» называет запасной путь', async () => {
    // Без неё оператор, включивший требование, ждёт немыми ВСЕ
    // ролики, а немыми станут только те, у кого реплики есть и не
    // вычитаны.
    const { service } = build({
      'postprod.tutorialVoice': 'on',
      'tutorial.requireNarrationReview': 'on',
    });

    const view = await service.view();

    expect(view.effect).toMatch(/НЕвычитанными/);
    expect(view.effect).toMatch(/без реплик это не затрагивает/);
  });

  it('запись кладёт обе настройки, а не одну', async () => {
    const { service, settings } = build();

    await service.set(
      {
        enabled: true,
        requireNarrationReview: true,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialVoice',
      'on',
      'op-1',
    );
    expect(settings.set).toHaveBeenCalledWith(
      'tutorial.requireNarrationReview',
      'on',
      'op-1',
    );
  });

  it('выключение требования записывается явным off, а не отсутствием', async () => {
    // Иначе «снять требование» было бы нечем: разбор считает
    // выключенным всё, кроме `on`, но строка в базе осталась бы
    // прежней.
    const { service, settings } = build({
      'tutorial.requireNarrationReview': 'on',
    });

    await service.set(
      {
        enabled: true,
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'tutorial.requireNarrationReview',
      'off',
      'op-1',
    );
  });
});

describe('AdminTutorialVoiceSettingsService — подписи (этап E)', () => {
  function build(stored: Record<string, string | null> = {}) {
    const settings = {
      get: jest.fn(async (key: string) => stored[key] ?? null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const tts = {
      resolve: jest.fn().mockResolvedValue({
        providerKey: 'elevenlabs',
        configured: () => true,
      }),
    };
    const service = new AdminTutorialVoiceSettingsService(
      settings as never,
      tts as never,
    );
    return { service, settings };
  }

  it('по умолчанию ВКЛЮЧЕНЫ — обратное умолчание озвучки', async () => {
    // Озвучка выключена по умолчанию, потому что стоит ≈$6 за набор.
    // Подписи не стоят ничего, а без звука ролик смотрят чаще, чем со
    // звуком (§5 ТЗ).
    expect((await build().service.view()).captions).toBe(true);
  });

  it('выключаются явным off', async () => {
    const { service } = build({ 'postprod.tutorialCaptions': 'off' });

    expect((await service.view()).captions).toBe(false);
  });

  it('непонятное значение НЕ выключает подписи', async () => {
    // Терпимость к мусору смотрит в другую сторону, чем у озвучки:
    // там непонятное значение не включает трату, здесь не выключает
    // пользу. Правило одно — «человек ничего не решил».
    const { service } = build({ 'postprod.tutorialCaptions': 'ага' });

    expect((await service.view()).captions).toBe(true);
  });

  it('фраза про подписи отдельная и идёт даже при выключенной озвучке', async () => {
    // Подписи от звука не зависят (§9, четвёртый уровень отката), и
    // приписав их к любой из веток звука, витрина соврала бы в
    // остальных.
    const { service } = build({ 'postprod.tutorialVoice': 'off' });

    const view = await service.view();

    expect(view.effect).toMatch(/Озвучка выключена/);
    expect(view.captionsEffect).toMatch(/Подписи на кадрах включены/);
    // Оператор должен знать, почему немой ролик стал длиннее
    // (сквозной аудит A–G): кадр держится, пока подпись читается.
    expect(view.captionsEffect).toMatch(/прочитать подпись/);
  });

  it('запись кладёт все три настройки', async () => {
    const { service, settings } = build();

    await service.set(
      {
        enabled: true,
        requireNarrationReview: false,
        captions: false,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialCaptions',
      'off',
      'op-1',
    );
  });
});

describe('AdminTutorialVoiceSettingsService — движение (этап G)', () => {
  function build(stored: Record<string, string | null> = {}) {
    const settings = {
      get: jest.fn(async (key: string) => stored[key] ?? null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const tts = {
      resolve: jest.fn().mockResolvedValue({
        providerKey: 'elevenlabs',
        configured: () => true,
      }),
    };
    const service = new AdminTutorialVoiceSettingsService(
      settings as never,
      tts as never,
    );
    return { service, settings };
  }

  it('по умолчанию движения нет, и витрина говорит, что заказчика это не касается', async () => {
    const view = await build().service.view();
    expect(view.motion).toBe('none');
    expect(view.motionEffect).toMatch(/Без движения/);
    expect(view.motionEffect).toMatch(/по сайту заказчика/);
  });

  it('режимы читаются из настройки', async () => {
    expect(
      (await build({ 'postprod.tutorialMotion': 'fade' }).service.view())
        .motion,
    ).toBe('fade');
    expect(
      (await build({ 'postprod.tutorialMotion': 'on' }).service.view()).motion,
    ).toBe('fade+zoom');
  });

  it('фраза витрины называет цену: зум и пересборку всего набора', async () => {
    const zoom = await build({
      'postprod.tutorialMotion': 'on',
    }).service.view();
    expect(zoom.motionEffect).toMatch(/удлиняет работу внешнего ffmpeg/);
    // И о потолке: «включил, а зума нет» не должно быть загадкой.
    expect(zoom.motionEffect).toMatch(/длиннее трёх минут/);
    expect(zoom.motionEffect).toMatch(/пересобирает весь набор/);
    const fade = await build({
      'postprod.tutorialMotion': 'fade',
    }).service.view();
    expect(fade.motionEffect).toMatch(/пересобирает весь набор/);
    expect(fade.motionEffect).not.toMatch(/ffmpeg/);
    // «Ролик короче на каждом стыке» верно только для покадровой речи:
    // ролик с одной дорожкой берёт запас, иначе обрезался бы конец речи.
    expect(fade.motionEffect).toMatch(/конец речи не обрезался/);
  });

  it('запись кладёт строку грамматики, а не название режима', async () => {
    // В базе — `off | fade | on`; `fade+zoom` разбор не принял бы.
    const { service, settings } = build();

    await service.set(
      {
        enabled: false,
        requireNarrationReview: false,
        captions: true,
        motion: 'fade+zoom',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialMotion',
      'on',
      'op-1',
    );
  });

  it('выключение пишется явным off', async () => {
    const { service, settings } = build({ 'postprod.tutorialMotion': 'on' });

    await service.set(
      {
        enabled: false,
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialMotion',
      'off',
      'op-1',
    );
  });
});

describe('AdminTutorialVoiceSettingsService — указатель клика (этап H)', () => {
  function build(stored: Record<string, string | null> = {}) {
    const settings = {
      get: jest.fn(async (key: string) => stored[key] ?? null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const tts = {
      resolve: jest.fn().mockResolvedValue({
        providerKey: 'elevenlabs',
        configured: () => true,
      }),
    };
    const service = new AdminTutorialVoiceSettingsService(
      settings as never,
      tts as never,
    );
    return { service, settings };
  }

  it('по умолчанию выключен, и витрина говорит, что это значит', async () => {
    const view = await build().service.view();
    expect(view.pointer).toBe(false);
    expect(view.pointerEffect).toMatch(/Без указателя/);
  });

  it('включённый — фраза честно говорит, когда кольца не будет', async () => {
    const view = await build({
      'postprod.tutorialPointer': 'on',
    }).service.view();
    expect(view.pointer).toBe(true);
    expect(view.pointerEffect).toMatch(/на снимке ещё нет/);
    expect(view.pointerEffect).toMatch(/пересобирает/);
  });

  it('запись кладёт явные on/off', async () => {
    const { service, settings } = build();
    const input = {
      enabled: false,
      requireNarrationReview: false,
      captions: true,
      motion: 'none' as const,
    };

    await service.set({ ...input, pointer: true }, 'op-1');
    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialPointer',
      'on',
      'op-1',
    );

    await service.set({ ...input, pointer: false }, 'op-1');
    expect(settings.set).toHaveBeenCalledWith(
      'postprod.tutorialPointer',
      'off',
      'op-1',
    );
  });
});
