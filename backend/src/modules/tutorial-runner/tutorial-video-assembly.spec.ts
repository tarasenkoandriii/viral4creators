import {
  evenFrameSeconds,
  framesFromSteps,
  narrationFrameSeconds,
  planSlideshow,
  slideshowContentHash,
  slideshowDurationMs,
  uniformFrames,
  SECONDS_PER_FRAME,
  FRAME_TAIL_SECONDS,
  MIN_FRAME_SECONDS,
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
    const plan = planSlideshow(uniformFrames([url(0)]), {
      outputName: 'custom-name.mp4',
    });
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

describe('длительность кадра под речь (этап B)', () => {
  it('кадр = реплика плюс пауза, чтобы не сменяться на последнем слоге', () => {
    expect(narrationFrameSeconds(4)).toBe(4 + FRAME_TAIL_SECONDS);
  });

  it('короткая реплика не даёт мелькающего кадра', () => {
    expect(narrationFrameSeconds(0.2)).toBe(MIN_FRAME_SECONDS);
  });

  it('длину mp3 измерить не удалось — минимум, а не ноль', () => {
    // `null` в контракте TTS значит «не измерили», и путать его с
    // нулём нельзя: на нуле кадр исчез бы, а `-t 0` уронил бы
    // `concat` целиком.
    expect(narrationFrameSeconds(null)).toBe(MIN_FRAME_SECONDS);
    expect(narrationFrameSeconds(NaN)).toBe(MIN_FRAME_SECONDS);
    expect(narrationFrameSeconds(Infinity)).toBe(MIN_FRAME_SECONDS);
  });

  it('вариант А: речь делится поровну, пауза добавляется ОДНА', () => {
    // Раздать хвост каждому кадру значило бы вставить `N × 0.6`
    // секунды тишины в середину речи.
    expect(evenFrameSeconds(9, 3)).toBeCloseTo((9 + FRAME_TAIL_SECONDS) / 3);
  });

  it('вариант А: короткая речь не сжимает кадры ниже минимума', () => {
    expect(evenFrameSeconds(1, 10)).toBe(MIN_FRAME_SECONDS);
  });

  it('вариант А без измеренной речи — прежняя константа', () => {
    // Не зная длины речи, делить нечего, а ролик обязан получиться.
    expect(evenFrameSeconds(null, 4)).toBe(SECONDS_PER_FRAME);
    expect(evenFrameSeconds(9, 0)).toBe(SECONDS_PER_FRAME);
    expect(evenFrameSeconds(0, 4)).toBe(SECONDS_PER_FRAME);
  });
});

describe('звук в плане сборки (этап B)', () => {
  const silent = () => planSlideshow(uniformFrames([url(0), url(1)]))!;

  it('немая команда закреплена ЦЕЛИКОМ, а не набором toContain', () => {
    // Набор `toContain`/`not.toContain` пропускал любую добавку:
    // проверено мутацией — дописанный `-ar 48000` тест проходил
    // (находка аудита этапа B). Путь обучалки по сайту заказчика
    // идёт по этой самой строке, и «не заметил изменений» должно
    // означать посимвольно, раз уж так написано.
    //
    // Строку положено ПЕРЕПИСЫВАТЬ осознанно: если этот тест упал,
    // значит команда изменилась, и надо решить, хотели ли вы этого.
    // Отдельной проверки «нет ни дорожки, ни кодека, ни -shortest»
    // здесь больше нет: равенство строки посимвольно поглощает её
    // целиком, и упасть отдельно она не могла (находка сквозного
    // аудита A+B+C).
    const scale =
      'scale=720:1560:force_original_aspect_ratio=decrease,' +
      'pad=720:1560:(ow-iw)/2:(oh-ih)/2,setsar=1';
    expect(silent().commands[0]).toBe(
      '-framerate 30 -loop 1 -t 2 -i {{frame0}} ' +
        '-framerate 30 -loop 1 -t 2 -i {{frame1}} ' +
        `-filter_complex "[0:v]${scale}[v0];[1:v]${scale}[v1];` +
        '[v0][v1]concat=n=2:v=1:a=0[outv]" ' +
        '-map "[outv]" -r 30 -pix_fmt yuv420p tutorial.mp4',
    );
  });

  it('реплика на кадр: сегменты подаются ПОПАРНО и склеиваются со звуком', () => {
    // `concat` с `a=1` требует звуковой поток у КАЖДОГО сегмента —
    // это не «та же строка с a=1» (§4.3 ТЗ).
    const plan = planSlideshow([
      { stepIndex: 0, url: url(0), seconds: 3, audioUrl: 'https://b/0.mp3' },
      { stepIndex: 1, url: url(1), seconds: 2 },
    ])!;
    expect(plan.inputs).toEqual({
      frame0: url(0),
      frame1: url(1),
      voice0: 'https://b/0.mp3',
    });
    expect(plan.commands[0]).toContain(
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]',
    );
    expect(plan.commands[0]).toContain('-map "[outv]" -map "[outa]"');
    expect(plan.commands[0]).toContain('-c:a aac -b:a 192k -shortest');
  });

  it('немому кадру подставляется тишина ровно его длины', () => {
    // Иначе `concat` отвергает задачу целиком: у PNG звука нет в
    // принципе.
    const plan = planSlideshow([
      { stepIndex: 0, url: url(0), seconds: 3, audioUrl: 'https://b/0.mp3' },
      { stepIndex: 1, url: url(1), seconds: 2 },
    ])!;
    expect(plan.commands[0]).toContain(
      'anullsrc=channel_layout=stereo:sample_rate=44100:d=2[a1]',
    );
    // Тишина — фильтр-ИСТОЧНИК, а не вход: входы ffmpeg-api это
    // словарь ссылок, входу без ссылки там места нет.
    expect(plan.commands[0]).not.toContain('-f lavfi');
    expect(Object.keys(plan.inputs)).not.toContain('voice1');
  });

  it('сегмент речи выравнивается по длине кадра — иначе звук уезжает', () => {
    // `concat` берёт длину сегмента по самому длинному потоку, и
    // рассинхрон копился бы от кадра к кадру.
    const plan = planSlideshow([
      { stepIndex: 0, url: url(0), seconds: 3.6, audioUrl: 'https://b/0.mp3' },
    ])!;
    expect(plan.commands[0]).toContain('apad,atrim=0:3.6,asetpts=N/SR/TB[a0]');
  });

  it('звуковые входы идут ПОСЛЕ кадров — иначе съезжают все [N:v]', () => {
    const plan = planSlideshow([
      { stepIndex: 0, url: url(0), seconds: 2 },
      { stepIndex: 1, url: url(1), seconds: 2, audioUrl: 'https://b/1.mp3' },
    ])!;
    // Два кадра — входы 0 и 1; mp3 получает вход 2.
    expect(plan.commands[0]).toContain('[0:v]scale=');
    expect(plan.commands[0]).toContain('[1:v]scale=');
    expect(plan.commands[0]).toContain('[2:a]aresample=44100');
  });

  it('одна дорожка на весь ролик: видео склеивается немым, звук ложится поверх', () => {
    const plan = planSlideshow(uniformFrames([url(0), url(1)]), {
      voiceoverUrl: 'https://b/voice.mp3',
    })!;
    expect(plan.inputs.voiceover).toBe('https://b/voice.mp3');
    expect(plan.commands[0]).toContain('concat=n=2:v=1:a=0[outv]');
    // Выравнивается по ОБЩЕЙ длине склейки, иначе длина файла
    // разойдётся с `durationMs`, который уже показан человеку.
    expect(plan.commands[0]).toContain(
      `apad,atrim=0:${plan.durationMs / 1000},asetpts=N/SR/TB[outa]`,
    );
    expect(plan.commands[0]).toContain('-map "[outv]" -map "[outa]"');
    expect(plan.commands[0]).toContain('-c:a aac -b:a 192k');
    expect(plan.commands[0]).not.toContain('anullsrc');
  });

  it('звук задан дважды — плана нет, а не «смешаем как-нибудь»', () => {
    // Два разных ответа на вопрос «что звучит на кадре N». Молчаливый
    // выбор одного из них дал бы ролик, которого никто не заказывал.
    expect(
      planSlideshow(
        [
          {
            stepIndex: 0,
            url: url(0),
            seconds: 2,
            audioUrl: 'https://b/0.mp3',
          },
        ],
        { voiceoverUrl: 'https://b/voice.mp3' },
      ),
    ).toBeNull();
  });
});

describe('длина файла совпадает с durationMs (§11 п.4)', () => {
  // Измерено настоящим ffmpeg 6.1.1 при аудите этапа B: без правок
  // ниже ролик из трёх кадров 3.1/1.5/2.7 давал 7.367 с при
  // объявленных 7.300, и расхождение росло с числом кадров.
  it('частота входа задана явно — иначе -t квантуется по 25 к/с ВВЕРХ', () => {
    // Для PNG ffmpeg берёт 25 к/с по умолчанию: `-t 2.7` превращался
    // в 68 кадров, то есть 2.72 с. На целых двойках это сходилось, на
    // дробных длительностях этапа B — нет.
    const plan = planSlideshow([{ stepIndex: 0, url: url(0), seconds: 2.7 }])!;
    expect(plan.commands[0]).toContain('-framerate 30 -loop 1 -t 2.7 -i');
  });

  it('со звуком добавляется -shortest — aac пакует по 1024 сэмпла', () => {
    // Звуковой поток всегда чуть длиннее заказанного (до 23 мс), и
    // без `-shortest` эта добавка попадала бы в длину файла.
    const plan = planSlideshow(uniformFrames([url(0)]), {
      voiceoverUrl: 'https://b/v.mp3',
    })!;
    expect(plan.commands[0]).toContain('-shortest');
  });
});

describe('slideshowContentHash', () => {
  const frame = (stepIndex: number, byte: number, seconds = 2) => ({
    stepIndex,
    bytes: new Uint8Array([byte, byte, byte]),
    seconds,
  });

  it('те же кадры и та же дорожка — тот же отпечаток', () => {
    // На этом держится обещание §7.2 ТЗ: «ролики пересобираются,
    // когда меняется интерфейс или текст шага, а не по расписанию».
    expect(
      slideshowContentHash([frame(1, 7), frame(2, 8)], 'a.mp3', null),
    ).toBe(slideshowContentHash([frame(1, 7), frame(2, 8)], 'a.mp3', null));
  });

  it('изменился ПИКСЕЛЬ кадра — отпечаток другой', () => {
    // Вторая причина пересборки из §7.2 — «изменился интерфейс». Она
    // ловится только байтами: шаги при этом те же самые, и номер
    // версии сценария не сдвинулся бы.
    expect(slideshowContentHash([frame(1, 7)], null, null)).not.toBe(
      slideshowContentHash([frame(1, 8)], null, null),
    );
  });

  it('другая дорожка — другой ролик, даже при тех же кадрах', () => {
    expect(slideshowContentHash([frame(1, 7)], 'a.mp3', null)).not.toBe(
      slideshowContentHash([frame(1, 7)], 'b.mp3', null),
    );
  });

  it('немой и озвученный не совпадают', () => {
    expect(slideshowContentHash([frame(1, 7)], null, null)).not.toBe(
      slideshowContentHash([frame(1, 7)], 'a.mp3', null),
    );
  });

  it('другая длительность кадра — другой отпечаток', () => {
    // Речь стала длиннее, картинка та же: ролик всё равно другой.
    expect(slideshowContentHash([frame(1, 7, 2)], null, null)).not.toBe(
      slideshowContentHash([frame(1, 7, 3)], null, null),
    );
  });

  it('пропавший кадр меняет отпечаток, а не «сдвигает» его', () => {
    expect(
      slideshowContentHash([frame(1, 7), frame(2, 7)], null, null),
    ).not.toBe(slideshowContentHash([frame(1, 7)], null, null));
  });

  it('перестановка кадров различима', () => {
    expect(
      slideshowContentHash([frame(1, 7), frame(2, 8)], null, null),
    ).not.toBe(slideshowContentHash([frame(2, 8), frame(1, 7)], null, null));
  });

  it('граница между кадрами не размывается', () => {
    // Без разделителя `\u0000` поток склеивается встык, и «один кадр,
    // в байтах которого лежит текст следующего заголовка» становится
    // неотличим от «двух кадров». Выдуманный случай — но ровно от
    // него разделитель и стоит: с ним пересборка пропускалась бы на
    // РАЗНЫХ входах, то есть ролик перестал бы обновляться молча.
    const asOne = [
      {
        stepIndex: 1,
        bytes: Buffer.from('3:4:\u0001\u0002'),
        seconds: 2,
      },
    ];
    const asTwo = [
      { stepIndex: 1, bytes: Buffer.alloc(0), seconds: 2 },
      { stepIndex: 3, bytes: Buffer.from('\u0001\u0002'), seconds: 4 },
    ];

    expect(slideshowContentHash(asOne, null, null)).not.toBe(
      slideshowContentHash(asTwo, null, null),
    );
  });
});

describe('slideshowDurationMs — сетка кадров', () => {
  // Все числа ниже сверены с настоящим ffmpeg 6.1.1: команда
  // собиралась, файл измерялся `ffprobe`. Формула переписывалась
  // дважды, и обе первые редакции проходили бы тесты «на глаз».
  const frame = (seconds: number, stepIndex = 0) => ({
    stepIndex,
    url: `f${stepIndex}.png`,
    seconds,
  });

  it('дробные длины округляются ПОКАДРОВО, а не суммой', () => {
    // Сумма сырых длительностей (3.605 + 1.5 + 9.612 = 14.717)
    // обещала 14717 мс, а файл вышел 14700: ffmpeg округлил каждый
    // сегмент к ближайшему кадру ДО `concat` — 108 + 45 + 288 = 441
    // кадр при 30 fps.
    expect(
      slideshowDurationMs([frame(3.605, 0), frame(1.5, 1), frame(9.612, 2)]),
    ).toBe(14700);
  });

  it('округление к ближайшему, а не вниз', () => {
    // Вторая неверная редакция округляла вниз: план 14733 при
    // реальных 14767. Ошибка сменила знак, но не исчезла. 108.906 →
    // 109, 45 → 45, 289.151 → 289 = 443 кадра.
    expect(
      slideshowDurationMs([
        frame(3.630204, 0),
        frame(1.5, 1),
        frame(9.638367, 2),
      ]),
    ).toBe(14767);
  });

  it('целые длины считаются как раньше', () => {
    // Немой ролик по две секунды на кадр — путь, по которому ходит
    // обучалка по сайту заказчика. Правка не должна была его
    // тронуть.
    expect(slideshowDurationMs([frame(2, 0), frame(2, 1)])).toBe(4000);
  });

  it('одна дорожка на четыре кадра — тоже ровно', () => {
    const seconds = evenFrameSeconds(9.038367, 4);
    expect(
      slideshowDurationMs([0, 1, 2, 3].map((i) => frame(seconds, i))),
    ).toBe(9600);
  });

  it('кадров нет — нулевая длительность, а не NaN', () => {
    expect(slideshowDurationMs([])).toBe(0);
  });
});

describe('planSlideshow — подписи (этап E)', () => {
  const shot = (i: number, over: Record<string, unknown> = {}) => ({
    stepIndex: i,
    url: `f${i}.png`,
    seconds: 2,
    ...over,
  });

  it('подписи — ФИЛЬТР над склейкой, а не вход `-i`', () => {
    // Хостед-сервис подставляет `{{ключ}}` везде в строке команды, а
    // `subtitles=` читает файл по пути. Поданный входом `.ass` стал
    // бы ещё одним потоком и сдвинул бы нумерацию `[N:a]` дорожек —
    // молча, потому что номера остались бы валидными.
    const plan = planSlideshow([shot(0), shot(1)], {
      captionsUrl: 'https://blob/captions.ass',
    });

    expect(plan?.inputs.captions).toBe('https://blob/captions.ass');
    expect(plan?.commands[0]).not.toContain('-i {{captions}}');
    expect(plan?.commands[0]).toContain('[outv]subtitles={{captions}}[outc]');
    expect(plan?.commands[0]).toContain('-map "[outc]"');
    expect(plan?.commands[0]).not.toContain('-map "[outv]"');
  });

  it('без подписей команда не меняется ни на символ', () => {
    // Тот же приём, что у немой команды этапа B: набор `toContain`
    // пропустил бы дописанный флаг, целая строка — нет.
    const withOut = planSlideshow([shot(0), shot(1)]);
    const withNull = planSlideshow([shot(0), shot(1)], { captionsUrl: null });

    expect(withNull?.commands[0]).toBe(withOut?.commands[0]);
    expect(withOut?.commands[0]).not.toContain('subtitles');
    expect(Object.keys(withOut?.inputs ?? {})).toEqual(['frame0', 'frame1']);
  });

  it('подписи поверх общей дорожки: нумерация входов не сдвигается', () => {
    // `[frames.length:a]` у варианта А обязан по-прежнему указывать
    // на mp3, а не на `.ass`.
    const plan = planSlideshow([shot(0), shot(1)], {
      voiceoverUrl: 'https://blob/v.mp3',
      captionsUrl: 'https://blob/c.ass',
    });

    expect(plan?.commands[0]).toContain('[2:a]aresample=');
    expect(plan?.commands[0]).toContain('-map "[outc]" -map "[outa]"');
    // Вход дорожки есть, входа подписей — нет.
    expect(plan?.commands[0]).toContain('-i {{voiceover}}');
    expect(plan?.commands[0]).not.toContain('-i {{captions}}');
  });

  it('подписи поверх покадрового звука: порядок карт верный', () => {
    const plan = planSlideshow(
      [
        shot(0, { audioUrl: 'https://blob/a0.mp3' }),
        shot(1, { audioUrl: 'https://blob/a1.mp3' }),
      ],
      { captionsUrl: 'https://blob/c.ass' },
    );

    expect(plan?.commands[0]).toContain('-map "[outc]" -map "[outa]"');
    expect(plan?.commands[0]).toContain('concat=n=2:v=1:a=1[outv][outa]');
  });

  it('один кадр с подписью — тоже рабочий план', () => {
    const plan = planSlideshow([shot(0)], { captionsUrl: 'c.ass' });

    expect(plan).not.toBeNull();
    expect(plan?.commands[0]).toContain('[outv]subtitles={{captions}}[outc]');
  });
});

describe('planSlideshow — звук выравнивается ПО СЕТКЕ кадров', () => {
  it('atrim режет дорожку по реальной длине кадра, а не по заказанной', () => {
    // `-t N` даёт ближайшее ЦЕЛОЕ число кадров, а `atrim=0:N` резал
    // ровно по N: сегменты выходили разной длины, `concat` брал
    // длину по самому длинному, и сдвиг копился. Замерено настоящим
    // ffmpeg: на тридцати кадрах +133 мс, картинка отставала от
    // речи (находка аудита этапа E).
    //
    // 3.649 × 30 = 109.47 → 109 кадров → 3.6333…
    const plan = planSlideshow([
      { stepIndex: 0, url: 'f0.png', seconds: 3.649, audioUrl: 'a0.mp3' },
    ]);

    expect(plan?.commands[0]).toContain('atrim=0:3.6333333333333333');
    expect(plan?.commands[0]).not.toContain('atrim=0:3.649');
  });

  it('тишина немого кадра — той же длины, что его картинка', () => {
    const plan = planSlideshow([
      { stepIndex: 0, url: 'f0.png', seconds: 2, audioUrl: 'a0.mp3' },
      { stepIndex: 1, url: 'f1.png', seconds: 3.649 },
    ]);

    expect(plan?.commands[0]).toContain('d=3.6333333333333333[a1]');
  });
});
