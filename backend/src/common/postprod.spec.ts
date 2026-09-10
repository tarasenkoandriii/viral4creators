import { DEFAULT_DUCK, planPostProduction, PostProdError } from './postprod';

describe('postprod — один проход ffmpeg (ТЗ §15.4/§16.1)', () => {
  it('когда делать нечего, задача не создаётся', () => {
    // Пустая задача это оплаченное перекодирование ради того же файла.
    expect(() => planPostProduction({})).toThrow(PostProdError);
    expect(() => planPostProduction({ targetAspectRatio: '9:16' })).toThrow(
      PostProdError,
    );
  });

  it('мусор вместо формата отвергается до отправки', () => {
    for (const bad of ['16-9', 'широкий', '16:', '0:0']) {
      expect(() => planPostProduction({ targetAspectRatio: bad })).toThrow(
        PostProdError,
      );
    }
  });

  describe('только обрезка — как на этапе 34', () => {
    const plan = planPostProduction({ targetAspectRatio: '4:5' });

    it('режет кадр и пересжимает видео', () => {
      expect(plan.command).toContain('crop=');
      expect(plan.command).toContain('libx264');
      expect(plan.crop).toEqual({ target: '4:5', ratio: 0.8 });
    });

    it('звук не пересжимается', () => {
      // Veo уже отдал AAC; второе сжатие только ухудшило бы его.
      expect(plan.command).toContain('-c:a copy');
      expect(plan.audio).toBeNull();
    });

    it('входной файл один', () => {
      expect(plan.inputKeys).toEqual(['source']);
      expect(plan.command).not.toContain('{{voice');
    });
  });

  describe('только озвучка — кадр родной', () => {
    const plan = planPostProduction({
      targetAspectRatio: '16:9',
      voiceInputKey: 'voice',
      voiceDelayMs: 300,
    });

    it('видео копируется потоком, а не пересжимается', () => {
      // Перекодировать кадр ради звуковой дорожки значит потерять
      // качество на ровном месте и заплатить за рендер.
      expect(plan.command).toContain('-c:v copy');
      expect(plan.command).not.toContain('libx264');
      expect(plan.crop).toBeNull();
    });

    it('голос сдвигается по обоим каналам', () => {
      // Без all=1 adelay двигает только левый канал, и стереоголос
      // разъезжается по времени.
      expect(plan.command).toContain('adelay=300:all=1');
    });

    it('исходный звук приглушается, а не выключается', () => {
      // Атмосфера и музыка Veo — половина достоверности ролика.
      expect(plan.command).toContain(`[0:a]volume=${DEFAULT_DUCK}[bg]`);
      expect(plan.command).toContain('amix=inputs=2');
    });

    it('микс не делит громкость пополам', () => {
      // Умолчание amix — normalize=1, и микс звучит вдвое тише исходника.
      expect(plan.command).toContain('normalize=0');
    });

    it('длина ролика не меняется, даже если голос длиннее', () => {
      expect(plan.command).toContain('duration=first');
    });

    it('громкость приводится к вещательной', () => {
      expect(plan.command).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');
    });

    it('оба потока маппятся явно', () => {
      // С filter_complex ffmpeg перестаёт выбирать потоки сам.
      expect(plan.command).toContain('-map 0:v');
      expect(plan.command).toContain('-map "[a]"');
    });

    it('два входа в объявленном порядке', () => {
      expect(plan.inputKeys).toEqual(['source', 'voice']);
      expect(plan.command.indexOf('{{source}}')).toBeLessThan(
        plan.command.indexOf('{{voice}}'),
      );
    });
  });

  describe('дубляж заменяет звук, а не подмешивает', () => {
    const plan = planPostProduction({
      voiceInputKey: 'voice',
      voiceMode: 'dub',
      targetAspectRatio: '1:1',
    });

    it('исходная дорожка не участвует', () => {
      expect(plan.command).not.toContain('amix');
      expect(plan.command).not.toContain('[0:a]');
      expect(plan.audio).toEqual({ mode: 'dub', delayMs: 0 });
    });

    it('громкость всё равно выравнивается', () => {
      expect(plan.command).toContain('loudnorm');
    });
  });

  describe('обрезка и озвучка вместе — ради этого всё и затевалось', () => {
    const plan = planPostProduction({
      targetAspectRatio: '4:5',
      voiceInputKey: 'voice',
      voiceDelayMs: 500,
    });

    it('одна команда делает и то и другое', () => {
      expect(plan.command).toContain('crop=');
      expect(plan.command).toContain('amix');
      expect(plan.crop).not.toBeNull();
      expect(plan.audio).not.toBeNull();
    });

    it('видео берётся с выхода фильтра, а не из исходника', () => {
      // Иначе получился бы необрезанный кадр с наложенным голосом —
      // ровно та гонка, ради ухода от которой проход сделан одним.
      expect(plan.command).toContain('-map "[v]"');
      expect(plan.command).not.toContain('-map 0:v ');
    });

    it('выход один и с индексом в начале файла', () => {
      expect(plan.command).toContain('+faststart {{final.mp4}}');
      expect(plan.outputName).toBe('final.mp4');
    });
  });

  it('отрицательный сдвиг не уезжает в команду', () => {
    const plan = planPostProduction({
      voiceInputKey: 'voice',
      voiceDelayMs: -100,
      targetAspectRatio: '4:5',
    });
    expect(plan.command).not.toContain('adelay');
    expect(plan.audio?.delayMs).toBe(0);
  });

  describe('субтитры (этап 67) — третий ингредиент того же прохода', () => {
    it('только субтитры, кадр родной: видео всё равно перекодируется', () => {
      // `subtitles` — фильтр, а не пробрасываемый поток; `-c:v copy` для
      // него не работает, в отличие от «ничего не трогаем».
      const plan = planPostProduction({
        subtitlesInputKey: 'subs',
        subtitleForceStyle: 'FontName=Arial',
      });
      expect(plan.command).toContain(
        "subtitles={{subs}}:force_style='FontName=Arial'",
      );
      expect(plan.command).toContain('libx264');
      expect(plan.command).not.toContain('-c:v copy');
      expect(plan.subtitles).toBe(true);
      expect(plan.crop).toBeNull();
    });

    it('субтитровый фильтр без кропа применяется к исходному потоку', () => {
      const plan = planPostProduction({
        subtitlesInputKey: 'subs',
        subtitleForceStyle: 'FontName=Arial',
      });
      expect(plan.command).toContain(
        "[0:v]subtitles={{subs}}:force_style='FontName=Arial'[v]",
      );
      expect(plan.command).toContain('-map "[v]"');
    });

    it('субтитры без ключа не создают задачу и не в счёт «нечего делать»', () => {
      expect(() => planPostProduction({ subtitlesInputKey: '   ' })).toThrow(
        PostProdError,
      );
    });

    it('субтитры и кроп — фильтр субтитров идёт ПОСЛЕ кропа в той же цепочке', () => {
      // Иначе субтитры легли бы на необрезанный кадр — та же гонка за
      // порядок, ради ухода от которой сделан один проход.
      const plan = planPostProduction({
        targetAspectRatio: '4:5',
        subtitlesInputKey: 'subs',
        subtitleForceStyle: 'FontName=Arial',
      });
      const cropIdx = plan.command.indexOf('crop=');
      const subsIdx = plan.command.indexOf('subtitles=');
      expect(cropIdx).toBeGreaterThan(-1);
      expect(subsIdx).toBeGreaterThan(cropIdx);
      // Один и тот же видеофильтр — субтитры прицеплены к кропу через
      // запятую в одной цепочке, а не отдельным независимым фильтром.
      expect(plan.command).toContain('setsar=1,subtitles=');
      expect(plan.command).toContain('libx264');
      expect(plan.subtitles).toBe(true);
    });

    it('субтитры, кроп и голос вместе — три ингредиента одной команды', () => {
      const plan = planPostProduction({
        targetAspectRatio: '4:5',
        voiceInputKey: 'voice',
        subtitlesInputKey: 'subs',
        subtitleForceStyle: 'FontName=Arial',
      });
      expect(plan.command).toContain('crop=');
      expect(plan.command).toContain('subtitles=');
      expect(plan.command).toContain('amix');
      expect(plan.crop).not.toBeNull();
      expect(plan.audio).not.toBeNull();
      expect(plan.subtitles).toBe(true);
      // Видео и звук маппятся из фильтра, входов ровно два — субтитры не
      // отдельный `-i`, а путь внутри фильтра.
      expect(plan.inputKeys).toEqual(['source', 'voice']);
      expect(plan.command).not.toContain('-i {{subs}}');
    });

    it('без субтитров команда не меняется — обратная совместимость', () => {
      const plan = planPostProduction({ targetAspectRatio: '4:5' });
      expect(plan.subtitles).toBe(false);
      expect(plan.command).not.toContain('subtitles=');
    });
  });
});
