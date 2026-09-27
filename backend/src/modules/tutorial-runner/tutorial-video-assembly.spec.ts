import {
  framesFromSteps,
  planSlideshow,
  slideshowDurationMs,
  uniformFrames,
  SECONDS_PER_FRAME,
  MAX_SLIDESHOW_FRAMES,
} from './tutorial-video-assembly';

const url = (i: number) => `https://blob.example.com/frame-${i}.png`;

describe('planSlideshow', () => {
  it('null для пустого списка кадров', () => {
    expect(planSlideshow([])).toBeNull();
  });

  it('null, если кадров больше потолка', () => {
    const frames = uniformFrames(
      Array.from({ length: MAX_SLIDESHOW_FRAMES + 1 }, (_, i) => url(i)),
    );
    expect(planSlideshow(frames)).toBeNull();
  });

  it('один кадр — валидная команда с одним входом', () => {
    const plan = planSlideshow(uniformFrames([url(0)]));
    expect(plan).not.toBeNull();
    expect(plan!.inputs).toEqual({ frame0: url(0) });
    expect(plan!.outputs).toEqual(['tutorial.mp4']);
    expect(plan!.outputName).toBe('tutorial.mp4');
    expect(plan!.commands).toHaveLength(1);
    expect(plan!.commands[0]).toContain('{{frame0}}');
    expect(plan!.commands[0]).toContain(`-t ${SECONDS_PER_FRAME}`);
    expect(plan!.commands[0]).toContain('concat=n=1:v=1:a=0');
  });

  it('несколько кадров — по одному входу на кадр, все участвуют в concat', () => {
    const plan = planSlideshow(uniformFrames([url(0), url(1), url(2)]));
    expect(plan).not.toBeNull();
    expect(Object.keys(plan!.inputs)).toEqual(['frame0', 'frame1', 'frame2']);
    expect(plan!.commands[0]).toContain('concat=n=3:v=1:a=0');
    expect(plan!.commands[0]).toContain('[v0]');
    expect(plan!.commands[0]).toContain('[v1]');
    expect(plan!.commands[0]).toContain('[v2]');
  });

  it('каждый вход приводится к ОДНОМУ холсту — иначе concat падает целиком', () => {
    // Правка аудита 27.09.2026: раньше здесь стоял `scale=trunc(../2)*2`
    // — он делал стороны чётными, но размеры между собой не равнял. А
    // `concat` требует совпадения ширины и высоты: один кадр иного
    // размера ронял задачу ЦЕЛИКОМ, без частичного результата.
    const plan = planSlideshow(uniformFrames([url(0), url(1)]));
    const scales = plan!.commands[0].match(/scale=\d+:\d+:/g) ?? [];
    expect(scales).toHaveLength(2);
    // Один и тот же холст у обоих входов, а не «каждый по себе».
    expect(new Set(scales).size).toBe(1);
  });

  it('кадр вписывается в холст без растяжения и дополняется полями', () => {
    // Растянутый интерфейс выглядит поломкой продукта, а не кадром.
    const plan = planSlideshow(uniformFrames([url(0)]));
    expect(plan!.commands[0]).toContain('force_original_aspect_ratio=decrease');
    expect(plan!.commands[0]).toMatch(/pad=\d+:\d+:\(ow-iw\)\/2:\(oh-ih\)\/2/);
  });

  it('своё имя выходного файла пробрасывается в outputs/outputName/команду', () => {
    const plan = planSlideshow(uniformFrames([url(0)]), 'custom-name.mp4');
    expect(plan!.outputs).toEqual(['custom-name.mp4']);
    expect(plan!.outputName).toBe('custom-name.mp4');
    expect(plan!.commands[0]).toContain('custom-name.mp4');
  });
});

describe('покадровые длительности (этап A)', () => {
  it('каждый кадр держится СВОЮ длительность, а не общую константу', () => {
    // Ради этого этап A и существует: на этапе B длительность кадра
    // станет длительностью реплики, и она у каждого шага своя.
    const plan = planSlideshow([
      { stepIndex: 0, url: url(0), seconds: 1.5 },
      { stepIndex: 1, url: url(1), seconds: 4 },
    ]);
    expect(plan!.commands[0]).toContain('-t 1.5 -i {{frame0}}');
    expect(plan!.commands[0]).toContain('-t 4 -i {{frame1}}');
  });

  it('durationMs считается по тем же длительностям, что попали в команду', () => {
    const plan = planSlideshow([
      { stepIndex: 0, url: url(0), seconds: 1.5 },
      { stepIndex: 1, url: url(1), seconds: 4 },
    ]);
    expect(plan!.durationMs).toBe(5500);
  });

  it('дробные секунды не округляются до кадра — суммируются как есть', () => {
    // Оценка длительности реплики приходит дробной (§4.1 ТЗ), и
    // округление каждого кадра копило бы ошибку по всему ролику.
    expect(
      slideshowDurationMs([
        { stepIndex: 0, url: url(0), seconds: 0.3 },
        { stepIndex: 1, url: url(1), seconds: 0.4 },
        { stepIndex: 2, url: url(2), seconds: 0.3 },
      ]),
    ).toBe(1000);
  });

  it('пустой список — нулевая длительность, без деления и NaN', () => {
    expect(slideshowDurationMs([])).toBe(0);
  });

  it('неположительная длительность отвергается целиком, а не молча чинится', () => {
    // `-t 0` даёт сегмент без кадров, и `concat` падает целиком уже на
    // стороне внешнего сервиса — за деньги и без внятной причины.
    expect(
      planSlideshow([
        { stepIndex: 0, url: url(0), seconds: 2 },
        { stepIndex: 1, url: url(1), seconds: 0 },
      ]),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: 0, url: url(0), seconds: -1 }]),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: 0, url: url(0), seconds: NaN }]),
    ).toBeNull();
    // `Infinity > 0` — правда, и без явной проверки конечности
    // `-t Infinity` ушёл бы наружу валидной командой, которая никогда
    // не завершится (аудит этапа A).
    expect(
      planSlideshow([{ stepIndex: 0, url: url(0), seconds: Infinity }]),
    ).toBeNull();
  });

  it('ключ входа и метка потока — по номеру ШАГА, вход ffmpeg — по позиции', () => {
    // Правка аудита этапа A: до неё номер шага доезжал до имени файла
    // в Blob и терялся, в план приходил позиционный массив. Команду
    // читает человек, разбирая неудачную сборку, и `frame3` обязано
    // означать третий шаг, а не третий уцелевший кадр.
    const plan = planSlideshow(
      framesFromSteps([
        { stepIndex: 1, url: url(1) },
        { stepIndex: 4, url: url(4) },
      ]),
    );
    expect(Object.keys(plan!.inputs)).toEqual(['frame1', 'frame4']);
    expect(plan!.commands[0]).toContain('{{frame1}}');
    expect(plan!.commands[0]).toContain('{{frame4}}');
    // Метки потоков и список входов `concat` проверяются ОДНОЙ
    // строкой, а не по отдельности: `toContain('[v1]')` проходит и
    // тогда, когда метки объявлены как `[v0][v1]`, а склеиваются как
    // `[v1][v4]`, — то есть при команде, которую ffmpeg отвергнет
    // целиком. Важно не наличие меток, а их СОВПАДЕНИЕ.
    expect(plan!.commands[0]).toContain('setsar=1[v1];[1:v]scale=');
    expect(plan!.commands[0]).toContain(
      'setsar=1[v4];[v1][v4]concat=n=2:v=1:a=0[outv]',
    );
    // А вот номер ВХОДА нумерует сам ffmpeg, по порядку `-i`:
    // `[4:v]` сослалось бы на пятый вход, которого нет.
    expect(plan!.commands[0]).toContain('[0:v]scale=');
    expect(plan!.commands[0]).not.toContain('[4:v]');
  });

  it('номера шагов обязаны строго возрастать — иначе плана нет', () => {
    // Два кадра с одним номером дали бы ОДИН ключ `inputs` и ДВА
    // `-i`: подставился бы не тот файл, молча и без ошибки от
    // ffmpeg-api. Перепутанный порядок так же тихо сломал бы
    // хронологию ролика.
    expect(
      planSlideshow([
        { stepIndex: 2, url: url(2), seconds: 2 },
        { stepIndex: 2, url: url(3), seconds: 2 },
      ]),
    ).toBeNull();
    expect(
      planSlideshow([
        { stepIndex: 3, url: url(3), seconds: 2 },
        { stepIndex: 1, url: url(1), seconds: 2 },
      ]),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: -1, url: url(0), seconds: 2 }]),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: 1.5, url: url(0), seconds: 2 }]),
    ).toBeNull();
    // Пропуск — не нарушение: кадр того шага просто не снялся.
    expect(
      planSlideshow([
        { stepIndex: 0, url: url(0), seconds: 2 },
        { stepIndex: 3, url: url(3), seconds: 2 },
      ]),
    ).not.toBeNull();
  });

  it('framesFromSteps не трогает номер шага, а только добавляет длительность', () => {
    expect(framesFromSteps([{ stepIndex: 4, url: url(4) }])).toEqual([
      { stepIndex: 4, url: url(4), seconds: SECONDS_PER_FRAME },
    ]);
  });

  it('uniformFrames — прежнее поведение: все кадры по SECONDS_PER_FRAME', () => {
    // Поведение этапа A не меняется ни на кадр: сегодня все вызывающие
    // идут через `uniformFrames`.
    const plan = planSlideshow(uniformFrames([url(0), url(1), url(2)]));
    expect(plan!.durationMs).toBe(3 * SECONDS_PER_FRAME * 1000);
    expect(uniformFrames([url(0)], 7)).toEqual([
      { stepIndex: 0, url: url(0), seconds: 7 },
    ]);
  });
});
