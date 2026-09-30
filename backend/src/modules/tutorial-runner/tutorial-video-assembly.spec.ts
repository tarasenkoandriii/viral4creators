import { PNG } from 'pngjs';
import {
  evenFrameSeconds,
  framesFromSteps,
  narrationFrameSeconds,
  planSlideshow,
  slideshowContentHash,
  slideshowFingerprint,
  sameSlideshowContent,
  fingerprintRest,
  TUTORIAL_FRAME_SENSITIVITY,
  slideshowDurationMs,
  uniformFrames,
  SECONDS_PER_FRAME,
  FRAME_TAIL_SECONDS,
  MIN_FRAME_SECONDS,
  MAX_SLIDESHOW_FRAMES,
  frameSpansSeconds,
  transitionFrames,
  TRANSITION_FRAMES,
  SLIDESHOW_MOTIONS,
  appliedMotion,
  ZOOM_MAX_SECONDS,
  POINTER_FRAMES,
  OUTPUT_CRF,
} from './tutorial-video-assembly';
import { createHash } from 'crypto';

const url = (i: number) => `https://blob.example.com/frame-${i}.png`;

describe('planSlideshow', () => {
  it('null для пустого списка кадров', () => {
    expect(planSlideshow([], { motion: 'none' })).toBeNull();
  });

  it('null, если кадров больше потолка', () => {
    const frames = uniformFrames(
      Array.from({ length: MAX_SLIDESHOW_FRAMES + 1 }, (_, i) => url(i)),
    );
    expect(planSlideshow(frames, { motion: 'none' })).toBeNull();
  });

  it('один кадр — валидная команда с одним входом', () => {
    const plan = planSlideshow(uniformFrames([url(0)]), { motion: 'none' });
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
    const plan = planSlideshow(uniformFrames([url(0), url(1), url(2)]), {
      motion: 'none',
    });
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
    const plan = planSlideshow(uniformFrames([url(0), url(1)]), {
      motion: 'none',
    });
    const scales = plan!.commands[0].match(/scale=\d+:\d+:/g) ?? [];
    expect(scales).toHaveLength(2);
    // Один и тот же холст у обоих входов, а не «каждый по себе».
    expect(new Set(scales).size).toBe(1);
  });

  it('кадр вписывается в холст без растяжения и дополняется полями', () => {
    // Растянутый интерфейс выглядит поломкой продукта, а не кадром.
    const plan = planSlideshow(uniformFrames([url(0)]), { motion: 'none' });
    expect(plan!.commands[0]).toContain('force_original_aspect_ratio=decrease');
    expect(plan!.commands[0]).toMatch(/pad=\d+:\d+:\(ow-iw\)\/2:\(oh-ih\)\/2/);
  });

  it('своё имя выходного файла пробрасывается в outputs/outputName/команду', () => {
    const plan = planSlideshow(uniformFrames([url(0)]), {
      motion: 'none',
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
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: url(0), seconds: 1.5 },
        { stepIndex: 1, url: url(1), seconds: 4 },
      ],
      { motion: 'none' },
    );
    expect(plan!.commands[0]).toContain('-t 1.5 -i {{frame0}}');
    expect(plan!.commands[0]).toContain('-t 4 -i {{frame1}}');
  });

  it('durationMs считается по тем же длительностям, что попали в команду', () => {
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: url(0), seconds: 1.5 },
        { stepIndex: 1, url: url(1), seconds: 4 },
      ],
      { motion: 'none' },
    );
    expect(plan!.durationMs).toBe(5500);
  });

  it('дробные секунды не округляются до кадра — суммируются как есть', () => {
    // Оценка длительности реплики приходит дробной (§4.1 ТЗ), и
    // округление каждого кадра копило бы ошибку по всему ролику.
    expect(
      slideshowDurationMs(
        [
          { stepIndex: 0, url: url(0), seconds: 0.3 },
          { stepIndex: 1, url: url(1), seconds: 0.4 },
          { stepIndex: 2, url: url(2), seconds: 0.3 },
        ],
        'none',
      ),
    ).toBe(1000);
  });

  it('пустой список — нулевая длительность, без деления и NaN', () => {
    expect(slideshowDurationMs([], 'none')).toBe(0);
  });

  it('неположительная длительность отвергается целиком, а не молча чинится', () => {
    // `-t 0` даёт сегмент без кадров, и `concat` падает целиком уже на
    // стороне внешнего сервиса — за деньги и без внятной причины.
    expect(
      planSlideshow(
        [
          { stepIndex: 0, url: url(0), seconds: 2 },
          { stepIndex: 1, url: url(1), seconds: 0 },
        ],
        { motion: 'none' },
      ),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: 0, url: url(0), seconds: -1 }], {
        motion: 'none',
      }),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: 0, url: url(0), seconds: NaN }], {
        motion: 'none',
      }),
    ).toBeNull();
    // `Infinity > 0` — правда, и без явной проверки конечности
    // `-t Infinity` ушёл бы наружу валидной командой, которая никогда
    // не завершится (аудит этапа A).
    expect(
      planSlideshow([{ stepIndex: 0, url: url(0), seconds: Infinity }], {
        motion: 'none',
      }),
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
      { motion: 'none' },
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
      planSlideshow(
        [
          { stepIndex: 2, url: url(2), seconds: 2 },
          { stepIndex: 2, url: url(3), seconds: 2 },
        ],
        { motion: 'none' },
      ),
    ).toBeNull();
    expect(
      planSlideshow(
        [
          { stepIndex: 3, url: url(3), seconds: 2 },
          { stepIndex: 1, url: url(1), seconds: 2 },
        ],
        { motion: 'none' },
      ),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: -1, url: url(0), seconds: 2 }], {
        motion: 'none',
      }),
    ).toBeNull();
    expect(
      planSlideshow([{ stepIndex: 1.5, url: url(0), seconds: 2 }], {
        motion: 'none',
      }),
    ).toBeNull();
    // Пропуск — не нарушение: кадр того шага просто не снялся.
    expect(
      planSlideshow(
        [
          { stepIndex: 0, url: url(0), seconds: 2 },
          { stepIndex: 3, url: url(3), seconds: 2 },
        ],
        { motion: 'none' },
      ),
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
    const plan = planSlideshow(uniformFrames([url(0), url(1), url(2)]), {
      motion: 'none',
    });
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
    expect(evenFrameSeconds(9, 3, 'none')).toBeCloseTo(
      (9 + FRAME_TAIL_SECONDS) / 3,
    );
  });

  it('вариант А: короткая речь не сжимает кадры ниже минимума', () => {
    expect(evenFrameSeconds(1, 10, 'none')).toBe(MIN_FRAME_SECONDS);
    expect(evenFrameSeconds(1, 10, 'fade')).toBe(MIN_FRAME_SECONDS);
  });

  it('вариант А без измеренной речи — прежняя константа', () => {
    // Не зная длины речи, делить нечего, а ролик обязан получиться.
    expect(evenFrameSeconds(null, 4, 'none')).toBe(SECONDS_PER_FRAME);
    expect(evenFrameSeconds(9, 0, 'none')).toBe(SECONDS_PER_FRAME);
    expect(evenFrameSeconds(0, 4, 'none')).toBe(SECONDS_PER_FRAME);
    // Прежняя константа и с переходами: запас на стыки нужен речи, а
    // её нет.
    expect(evenFrameSeconds(null, 4, 'fade')).toBe(SECONDS_PER_FRAME);
  });

  // Сквозной аудит A–G: переходы этапа G съедали конец общей дорожки
  // этапа B. Замерено настоящим ffmpeg — 30 с речи на десяти кадрах с
  // переходами были слышны до 27.95 с.
  it.each(['fade', 'fade+zoom'] as const)(
    'вариант А с переходами (%s): ролик не короче речи с паузой',
    (motion: 'fade' | 'fade+zoom') => {
      for (const [speech, n] of [
        [9, 4],
        [30, 10],
        [30.123, 2],
        [44.4, 30],
      ] as const) {
        const seconds = evenFrameSeconds(speech, n, motion);
        const frames = Array.from({ length: n }, (_, i) => ({
          stepIndex: i,
          url: `f${i}.png`,
          seconds,
        }));
        expect(transitionFrames(frames, motion)).toBe(TRANSITION_FRAMES);
        // Допуск — полкадра на кадр: каждый сегмент ложится на сетку
        // 30 к/с отдельно. Хвост в 0.6 с этот допуск покрывает.
        const ms = slideshowDurationMs(frames, motion);
        expect(ms).toBeGreaterThanOrEqual(
          (speech + FRAME_TAIL_SECONDS - n / 2 / 30) * 1000,
        );
        expect(ms).toBeGreaterThan(speech * 1000);
      }
    },
  );

  it('вариант А с переходами: запас ровно на стыки, а не на кадры', () => {
    // Четыре кадра — три стыка по 0.3 с. Лишний переход в запасе дал
    // бы ролик длиннее речи на 0.3 с тишины.
    expect(evenFrameSeconds(9, 4, 'fade')).toBeCloseTo(
      (9 + FRAME_TAIL_SECONDS + (3 * TRANSITION_FRAMES) / 30) / 4,
      10,
    );
  });

  it('вариант А без переходов — прежнее число символ в символ', () => {
    // Иначе деплой правки сменил бы отпечаток у всех роликов с одной
    // дорожкой и заказал бы их пересборку.
    for (const [speech, n] of [
      [9.038367, 4],
      [14.2, 7],
      [1, 10],
    ] as const) {
      expect(evenFrameSeconds(speech, n, 'none')).toBe(
        Math.max((speech + FRAME_TAIL_SECONDS) / n, MIN_FRAME_SECONDS),
      );
    }
    // Один кадр — стыков нет, прибавлять нечего.
    expect(evenFrameSeconds(9, 1, 'fade')).toBe(9 + FRAME_TAIL_SECONDS);
  });
});

describe('звук в плане сборки (этап B)', () => {
  const silent = () =>
    planSlideshow(uniformFrames([url(0), url(1)]), { motion: 'none' })!;

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
        '-map "[outv]" -r 30 ' +
        '-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p ' +
        '-movflags +faststart {{tutorial.mp4}}',
    );
  });

  it('ВЫХОД пишется плейсхолдером, а не голым именем файла', () => {
    // Находка боевого прогона 29.09.2026. Голым именем ffmpeg клал mp4
    // в свой рабочий каталог, а хостед-сервис забирал выход по тому
    // пути, который сам подставил бы вместо `{{имя}}`, — и отвечал
    // «1 output upload(s) failed: expected output was not created».
    // Ни один ролик обучалки не собрался ни разу, при том что команда
    // валидна и локально даёт правильный mp4.
    const withVoice = planSlideshow(
      [
        { stepIndex: 0, url: url(0), seconds: 3, audioUrl: 'https://b/0.mp3' },
        { stepIndex: 1, url: url(1), seconds: 3, audioUrl: 'https://b/1.mp3' },
      ],
      { motion: 'none' },
    )!;
    for (const plan of [silent(), withVoice]) {
      expect(plan.commands[0]).toContain(`{{${plan.outputName}}}`);
      // И ровно один раз, в самом конце: имя выхода, встреченное ещё
      // где-то, означало бы вторую запись того же файла.
      expect(plan.commands[0].endsWith(`{{${plan.outputName}}}`)).toBe(true);
      // Голого имени в команде быть не должно вовсе — иначе тест
      // проходил бы и на строке, где есть оба написания.
      expect(
        plan.commands[0].replace(`{{${plan.outputName}}}`, ''),
      ).not.toContain(plan.outputName);
      // Имя, объявленное сервису, и имя в команде — одно и то же.
      expect(plan.outputs).toEqual([plan.outputName]);
    }
  });

  it('кодек задан ЯВНО — умолчание ffmpeg это догадка о чужом контейнере', () => {
    expect(silent().commands[0]).toContain('-c:v libx264 -preset veryfast');
    // Тот же crf, что у проверенного пути постобработки: своё число
    // означало бы, что ролики обучалки выглядят иначе без причины.
    expect(silent().commands[0]).toContain(`-crf ${OUTPUT_CRF}`);
    expect(OUTPUT_CRF).toBe(18);
    // `+faststart` — как у соседей: без него плеер ждёт полной загрузки.
    expect(silent().commands[0]).toContain('-movflags +faststart');
  });

  it('реплика на кадр: сегменты подаются ПОПАРНО и склеиваются со звуком', () => {
    // `concat` с `a=1` требует звуковой поток у КАЖДОГО сегмента —
    // это не «та же строка с a=1» (§4.3 ТЗ).
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: url(0), seconds: 3, audioUrl: 'https://b/0.mp3' },
        { stepIndex: 1, url: url(1), seconds: 2 },
      ],
      { motion: 'none' },
    )!;
    expect(plan.inputs).toEqual({
      frame0: url(0),
      frame1: url(1),
      voice0: 'https://b/0.mp3',
    });
    expect(plan.commands[0]).toContain(
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][acat];' +
        // Хвост тишины в кадр после склейки (аудит этапа G): без него
        // `-shortest` на части раскладок срезал последний кадр.
        '[acat]apad=pad_len=1470[outa]',
    );
    expect(plan.commands[0]).toContain('-map "[outv]" -map "[outa]"');
    expect(plan.commands[0]).toContain('-c:a aac -b:a 192k -shortest');
  });

  it('немому кадру подставляется тишина ровно его длины', () => {
    // Иначе `concat` отвергает задачу целиком: у PNG звука нет в
    // принципе.
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: url(0), seconds: 3, audioUrl: 'https://b/0.mp3' },
        { stepIndex: 1, url: url(1), seconds: 2 },
      ],
      { motion: 'none' },
    )!;
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
    const plan = planSlideshow(
      [
        {
          stepIndex: 0,
          url: url(0),
          seconds: 3.6,
          audioUrl: 'https://b/0.mp3',
        },
      ],
      { motion: 'none' },
    )!;
    expect(plan.commands[0]).toContain('apad,atrim=0:3.6,asetpts=N/SR/TB[a0]');
  });

  it('звуковые входы идут ПОСЛЕ кадров — иначе съезжают все [N:v]', () => {
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: url(0), seconds: 2 },
        { stepIndex: 1, url: url(1), seconds: 2, audioUrl: 'https://b/1.mp3' },
      ],
      { motion: 'none' },
    )!;
    // Два кадра — входы 0 и 1; mp3 получает вход 2.
    expect(plan.commands[0]).toContain('[0:v]scale=');
    expect(plan.commands[0]).toContain('[1:v]scale=');
    expect(plan.commands[0]).toContain('[2:a]aresample=44100');
  });

  it('одна дорожка на весь ролик: видео склеивается немым, звук ложится поверх', () => {
    const plan = planSlideshow(uniformFrames([url(0), url(1)]), {
      motion: 'none',
      voiceoverUrl: 'https://b/voice.mp3',
    })!;
    expect(plan.inputs.voiceover).toBe('https://b/voice.mp3');
    expect(plan.commands[0]).toContain('concat=n=2:v=1:a=0[outv]');
    // Выравнивается по ОБЩЕЙ длине склейки, иначе длина файла
    // разойдётся с `durationMs`, который уже показан человеку.
    // Число выписано, а не собрано из `plan.durationMs`: прежняя
    // редакция проверяла резку той же формулой, по которой она
    // делалась, и пропустила дефект (аудит этапа G). 2 × 2 с = 120
    // кадров × 1470 сэмплов плюс хвост в кадр (`-shortest` обязан
    // резать звук, а не картинку): 121 × 1470.
    expect(plan.commands[0]).toContain(
      'apad,atrim=end_sample=177870,asetpts=N/SR/TB[outa]',
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
        { motion: 'none', voiceoverUrl: 'https://b/voice.mp3' },
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
    const plan = planSlideshow([{ stepIndex: 0, url: url(0), seconds: 2.7 }], {
      motion: 'none',
    })!;
    expect(plan.commands[0]).toContain('-framerate 30 -loop 1 -t 2.7 -i');
  });

  it('со звуком добавляется -shortest — aac пакует по 1024 сэмпла', () => {
    // Звуковой поток всегда чуть длиннее заказанного (до 23 мс), и
    // без `-shortest` эта добавка попадала бы в длину файла.
    const plan = planSlideshow(uniformFrames([url(0)]), {
      motion: 'none',
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
      slideshowContentHash([frame(1, 7), frame(2, 8)], 'a.mp3', null, 'none'),
    ).toBe(
      slideshowContentHash([frame(1, 7), frame(2, 8)], 'a.mp3', null, 'none'),
    );
  });

  it('изменился ПИКСЕЛЬ кадра — отпечаток другой', () => {
    // Вторая причина пересборки из §7.2 — «изменился интерфейс». Она
    // ловится только байтами: шаги при этом те же самые, и номер
    // версии сценария не сдвинулся бы.
    expect(slideshowContentHash([frame(1, 7)], null, null, 'none')).not.toBe(
      slideshowContentHash([frame(1, 8)], null, null, 'none'),
    );
  });

  it('другая дорожка — другой ролик, даже при тех же кадрах', () => {
    expect(slideshowContentHash([frame(1, 7)], 'a.mp3', null, 'none')).not.toBe(
      slideshowContentHash([frame(1, 7)], 'b.mp3', null, 'none'),
    );
  });

  it('немой и озвученный не совпадают', () => {
    expect(slideshowContentHash([frame(1, 7)], null, null, 'none')).not.toBe(
      slideshowContentHash([frame(1, 7)], 'a.mp3', null, 'none'),
    );
  });

  it('другая длительность кадра — другой отпечаток', () => {
    // Речь стала длиннее, картинка та же: ролик всё равно другой.
    expect(slideshowContentHash([frame(1, 7, 2)], null, null, 'none')).not.toBe(
      slideshowContentHash([frame(1, 7, 3)], null, null, 'none'),
    );
  });

  it('пропавший кадр меняет отпечаток, а не «сдвигает» его', () => {
    expect(
      slideshowContentHash([frame(1, 7), frame(2, 7)], null, null, 'none'),
    ).not.toBe(slideshowContentHash([frame(1, 7)], null, null, 'none'));
  });

  it('перестановка кадров различима', () => {
    expect(
      slideshowContentHash([frame(1, 7), frame(2, 8)], null, null, 'none'),
    ).not.toBe(
      slideshowContentHash([frame(2, 8), frame(1, 7)], null, null, 'none'),
    );
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

    expect(slideshowContentHash(asOne, null, null, 'none')).not.toBe(
      slideshowContentHash(asTwo, null, null, 'none'),
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
      slideshowDurationMs(
        [frame(3.605, 0), frame(1.5, 1), frame(9.612, 2)],
        'none',
      ),
    ).toBe(14700);
  });

  it('округление к ближайшему, а не вниз', () => {
    // Вторая неверная редакция округляла вниз: план 14733 при
    // реальных 14767. Ошибка сменила знак, но не исчезла. 108.906 →
    // 109, 45 → 45, 289.151 → 289 = 443 кадра.
    expect(
      slideshowDurationMs(
        [frame(3.630204, 0), frame(1.5, 1), frame(9.638367, 2)],
        'none',
      ),
    ).toBe(14767);
  });

  it('целые длины считаются как раньше', () => {
    // Немой ролик по две секунды на кадр — путь, по которому ходит
    // обучалка по сайту заказчика. Правка не должна была его
    // тронуть.
    expect(slideshowDurationMs([frame(2, 0), frame(2, 1)], 'none')).toBe(4000);
  });

  it('одна дорожка на четыре кадра — тоже ровно', () => {
    const seconds = evenFrameSeconds(9.038367, 4, 'none');
    expect(
      slideshowDurationMs(
        [0, 1, 2, 3].map((i) => frame(seconds, i)),
        'none',
      ),
    ).toBe(9600);
  });

  it('кадров нет — нулевая длительность, а не NaN', () => {
    expect(slideshowDurationMs([], 'none')).toBe(0);
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
      motion: 'none',
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
    const withOut = planSlideshow([shot(0), shot(1)], { motion: 'none' });
    const withNull = planSlideshow([shot(0), shot(1)], {
      motion: 'none',
      captionsUrl: null,
    });

    expect(withNull?.commands[0]).toBe(withOut?.commands[0]);
    expect(withOut?.commands[0]).not.toContain('subtitles');
    expect(Object.keys(withOut?.inputs ?? {})).toEqual(['frame0', 'frame1']);
  });

  it('подписи поверх общей дорожки: нумерация входов не сдвигается', () => {
    // `[frames.length:a]` у варианта А обязан по-прежнему указывать
    // на mp3, а не на `.ass`.
    const plan = planSlideshow([shot(0), shot(1)], {
      motion: 'none',
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
      { motion: 'none', captionsUrl: 'https://blob/c.ass' },
    );

    expect(plan?.commands[0]).toContain('-map "[outc]" -map "[outa]"');
    expect(plan?.commands[0]).toContain('concat=n=2:v=1:a=1[outv][acat]');
    expect(plan?.commands[0]).toContain('[acat]apad=pad_len=1470[outa]');
  });

  it('один кадр с подписью — тоже рабочий план', () => {
    const plan = planSlideshow([shot(0)], {
      motion: 'none',
      captionsUrl: 'c.ass',
    });

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
    const plan = planSlideshow(
      [{ stepIndex: 0, url: 'f0.png', seconds: 3.649, audioUrl: 'a0.mp3' }],
      { motion: 'none' },
    );

    expect(plan?.commands[0]).toContain('atrim=0:3.6333333333333333');
    expect(plan?.commands[0]).not.toContain('atrim=0:3.649');
  });

  it('тишина немого кадра — той же длины, что его картинка', () => {
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: 'f0.png', seconds: 2, audioUrl: 'a0.mp3' },
        { stepIndex: 1, url: 'f1.png', seconds: 3.649 },
      ],
      { motion: 'none' },
    );

    expect(plan?.commands[0]).toContain('d=3.6333333333333333[a1]');
  });
});

describe('движение: переходы и зум (этап G)', () => {
  // 3 с, 2 с, 4 с → 90, 60, 120 кадров. Переход — 9 кадров.
  const three = [
    { stepIndex: 0, url: 'f0.png', seconds: 3 },
    { stepIndex: 1, url: 'f1.png', seconds: 2 },
    { stepIndex: 2, url: 'f2.png', seconds: 4 },
  ];

  it('переход — 0.3 с, как в §6 ТЗ, и считается в кадрах', () => {
    expect(TRANSITION_FRAMES).toBe(9);
    expect(transitionFrames(three, 'fade')).toBe(9);
    expect(transitionFrames(three, 'fade+zoom')).toBe(9);
    expect(transitionFrames(three, 'none')).toBe(0);
  });

  it('один кадр — переходить не к чему', () => {
    expect(transitionFrames([three[0]], 'fade')).toBe(0);
  });

  it('кадр короче двух переходов отменяет переходы у всего ролика, а не роняет сборку', () => {
    // 0.5 с = 15 кадров < 18: въезд и выезд делили бы одни и те же
    // кадры, и `xfade` смешивал бы три экрана сразу.
    const short = [...three, { stepIndex: 3, url: 'f3.png', seconds: 0.5 }];
    expect(transitionFrames(short, 'fade')).toBe(0);
    const plan = planSlideshow(short, { motion: 'fade' })!;
    expect(plan.commands[0]).not.toContain('xfade');
    expect(plan.commands[0]).toBe(
      planSlideshow(short, { motion: 'none' })!.commands[0],
    );
    expect(plan.durationMs).toBe(9500);
  });

  it('каждый стык съедает переход: кадр начинается там, где начинается въезд', () => {
    const spans = frameSpansSeconds(three, 'fade');
    // 0 → 81 → 132 → 252 кадров.
    expect(spans.map((s) => Math.round(s.start * 30))).toEqual([0, 81, 132]);
    expect(spans.map((s) => Math.round(s.end * 30))).toEqual([81, 132, 252]);
  });

  it('длительность ролика короче на переход × (кадров − 1) — §6: «slideshowDurationMs придётся поправить»', () => {
    expect(slideshowDurationMs(three, 'none')).toBe(9000);
    expect(slideshowDurationMs(three, 'fade')).toBe(8400);
    expect(slideshowDurationMs(three, 'fade+zoom')).toBe(8400);
    expect(planSlideshow(three, { motion: 'fade' })!.durationMs).toBe(8400);
  });

  it('без движения команда та же, что до этапа, — символ в символ', () => {
    // Строка, собранная руками: путь обучалки по сайту заказчика и
    // режим по умолчанию обязаны получать прежнюю команду.
    expect(planSlideshow(three, { motion: 'none' })!.commands[0]).toContain(
      '[v0][v1][v2]concat=n=3:v=1:a=0[outv]',
    );
    expect(planSlideshow(three, { motion: 'none' })!.commands[0]).not.toMatch(
      /xfade|perspective/,
    );
  });

  it('переходы — цепочка xfade со смещениями по той же сетке, без concat картинки', () => {
    const cmd = planSlideshow(three, { motion: 'fade' })!.commands[0];
    expect(cmd).toContain(
      '[v0][v1]xfade=transition=fade:duration=0.3:offset=2.7[xf1]',
    );
    expect(cmd).toContain(
      '[xf1][v2]xfade=transition=fade:duration=0.3:offset=4.4[outv]',
    );
    expect(cmd).not.toContain('concat');
    expect(cmd).not.toContain('perspective');
  });

  it('пропуск в нумерации шагов не ломает цепочку: метки по шагу, стыки по позиции', () => {
    const gappy = [three[0], { ...three[2], stepIndex: 5 }];
    const cmd = planSlideshow(gappy, { motion: 'fade' })!.commands[0];
    expect(cmd).toContain(
      '[v0][v5]xfade=transition=fade:duration=0.3:offset=2.7[outv]',
    );
  });

  it('звук при переходах — встык, сегментами «до начала следующего кадра»', () => {
    // Картинка идёт внахлёст, звук — нет. Озвученный кадр теряет
    // только хвост паузы, речь не режется.
    const voiced = three.map((f, i) =>
      i === 1 ? f : { ...f, audioUrl: `a${i}.mp3` },
    );
    const cmd = planSlideshow(voiced, { motion: 'fade' })!.commands[0];
    // Целыми сэмплами: 81 кадр × 1470; немой второй — 51 кадр;
    // последний целиком — 120 кадров.
    expect(cmd).toContain('apad,atrim=end_sample=119070,asetpts=N/SR/TB[a0]');
    expect(cmd).toContain(
      'anullsrc=channel_layout=stereo:sample_rate=44100,atrim=end_sample=74970[a1]',
    );
    expect(cmd).toContain('apad,atrim=end_sample=176400,asetpts=N/SR/TB[a2]');
    expect(cmd).toContain(
      '[a0][a1][a2]concat=n=3:v=0:a=1,apad=pad_len=1470[outa]',
    );
    // Сумма сегментов звука — ровно длина ролика, в сэмплах: 252 кадра;
    // хвост в один кадр — отдельно, после склейки.
    expect(119070 + 74970 + 176400).toBe(252 * 1470);
  });

  it('одна дорожка на весь ролик режется по НОВОЙ длине', () => {
    const cmd = planSlideshow(three, {
      motion: 'fade',
      voiceoverUrl: 'v.mp3',
    })!.commands[0];
    // (252 кадра + хвост в кадр) × 1470 сэмплов.
    expect(cmd).toContain('apad,atrim=end_sample=371910,asetpts=N/SR/TB[outa]');
  });

  it('подписи прожигаются поверх цепочки переходов', () => {
    const cmd = planSlideshow(three, {
      motion: 'fade',
      captionsUrl: 'c.ass',
    })!.commands[0];
    expect(cmd).toContain('[outv]subtitles={{captions}}[outc]');
    expect(cmd).toContain('-map "[outc]"');
  });

  it('зум — perspective у каждого кадра со своей длиной, без мусорных знаков', () => {
    const cmd = planSlideshow(three, { motion: 'fade+zoom' })!.commands[0];
    // Последний кадр показа: 89, 59, 119.
    expect(cmd).toContain('(1+0.04*in/89)');
    expect(cmd).toContain('(1+0.04*in/59)');
    expect(cmd).toContain('(1+0.04*in/119)');
    expect(cmd).not.toMatch(/0\.0400000/);
    expect(cmd.match(/perspective=/g)).toHaveLength(3);
    expect(cmd).toContain('interpolation=cubic:eval=frame');
  });

  it('зум без кавычек и запятых внутри выражений — строку разбирает чужой сервис', () => {
    const cmd = planSlideshow([three[0]], { motion: 'fade+zoom' })!.commands[0];
    const zoom = /perspective=[^\[]*/.exec(cmd)![0];
    expect(zoom).not.toMatch(/['",]/);
  });

  it('режимов ровно три — витрина и DTO берут их отсюда', () => {
    expect([...SLIDESHOW_MOTIONS]).toEqual(['none', 'fade', 'fade+zoom']);
  });
});

describe('отпечаток и движение (этап G)', () => {
  const frame = (stepIndex: number, byte: number) => ({
    stepIndex,
    bytes: new Uint8Array([byte]),
    seconds: 2,
  });

  it('режим входит в отпечаток: переключатель обязан заказывать пересборку', () => {
    const frames = [frame(0, 1), frame(1, 2)];
    const none = slideshowContentHash(frames, null, null, 'none');
    const fade = slideshowContentHash(frames, null, null, 'fade');
    const zoom = slideshowContentHash(frames, null, null, 'fade+zoom');
    expect(new Set([none, fade, zoom]).size).toBe(3);
  });

  it('режим «без движения» не меняет отпечаток, посчитанный до этапа G', () => {
    // Иначе сам деплой сменил бы отпечаток у всех роликов, и первая же
    // ночь пересобрала бы весь набор за деньги ради того же mp4.
    // Формула до этапа — выписана здесь буквально.
    const frames = [frame(0, 1), frame(1, 2)];
    const h = createHash('sha256');
    h.update('a.mp3');
    h.update('\u0000');
    h.update('');
    for (const f of frames) {
      h.update('\u0000');
      h.update(`${f.stepIndex}:${f.seconds}::`);
      h.update(Buffer.from(f.bytes));
    }
    expect(slideshowContentHash(frames, 'a.mp3', null, 'none')).toBe(
      h.digest('hex'),
    );
  });
});

describe('звук режется целыми сэмплами (аудит этапа G)', () => {
  it('одна дорожка: durationMs, округлённый вниз, больше не укорачивает звук', () => {
    // 94 + 93 = 187 кадров = 6233.33 мс → durationMs 6233. Прежняя
    // резка `atrim=0:6.233` давала звук на треть миллисекунды КОРОЧЕ
    // картинки, `-shortest` отрезал последний кадр, и в файле было
    // 186 кадров при 187 в плане (замерено ffmpeg 6.1.1 на исходном
    // коде этапа B).
    const plan = planSlideshow(
      [
        { stepIndex: 0, url: 'a.png', seconds: 94 / 30 },
        { stepIndex: 1, url: 'b.png', seconds: 93 / 30 },
      ],
      { motion: 'none', voiceoverUrl: 'v.mp3' },
    )!;
    expect(plan.durationMs).toBe(6233);
    // (187 + хвост в кадр) × 1470 — звук заведомо длиннее картинки.
    expect(plan.commands[0]).toContain('atrim=end_sample=276360,');
    expect(plan.commands[0]).not.toContain('atrim=0:6.233');
  });

  it('без переходов покадровый звук режется по-прежнему — там его выравнивает пара [v][a]', () => {
    const plan = planSlideshow(
      [{ stepIndex: 0, url: 'a.png', seconds: 3.649, audioUrl: 'x.mp3' }],
      { motion: 'none' },
    )!;
    expect(plan.commands[0]).toContain('atrim=0:3.6333333333333333');
    expect(plan.commands[0]).not.toContain('end_sample');
  });
});

describe('потолок зума (аудит этапа G)', () => {
  const frames = (n: number, seconds = 6) =>
    Array.from({ length: n }, (_, i) => ({
      stepIndex: i,
      url: `f${i}.png`,
      seconds,
    }));

  it('потолок — три минуты: вдвое ниже десяти минут сборки по замеру', () => {
    expect(ZOOM_MAX_SECONDS).toBe(180);
  });

  it('обычный ролик — зум как заказан', () => {
    expect(appliedMotion(frames(6), 'fade+zoom')).toBe('fade+zoom');
    const plan = planSlideshow(frames(6), { motion: 'fade+zoom' })!;
    expect(plan.motion).toBe('fade+zoom');
    expect(plan.commands[0]).toContain('perspective=');
  });

  it('длиннее потолка — зум снят, переходы остались, сетка та же', () => {
    // 30 кадров по 6.5 с — 195 с минус 29 переходов по 0.3 с = 186.3 с.
    const long = frames(30, 6.5);
    expect(appliedMotion(long, 'fade+zoom')).toBe('fade');
    const plan = planSlideshow(long, { motion: 'fade+zoom' })!;
    expect(plan.motion).toBe('fade');
    expect(plan.commands[0]).not.toContain('perspective=');
    expect(plan.commands[0]).toContain('xfade');
    // Сетка — та же, что и с зумом: подписи, посчитанные с ним, верны.
    expect(plan.durationMs).toBe(slideshowDurationMs(long, 'fade+zoom'));
    expect(plan.durationMs).toBeGreaterThan(ZOOM_MAX_SECONDS * 1000);
  });

  it('потолок трогает только зум: остальные режимы не меняются', () => {
    const long = frames(30, 6.5);
    expect(appliedMotion(long, 'fade')).toBe('fade');
    expect(appliedMotion(long, 'none')).toBe('none');
  });
});

describe('указатель клика (этап H)', () => {
  const two = (pointer?: { x: number; y: number }) => [
    { stepIndex: 0, url: 'a.png', seconds: 3, ...(pointer ? { pointer } : {}) },
    { stepIndex: 1, url: 'b.png', seconds: 2 },
  ];

  it('без указателя команда прежняя: `null` и отсутствие поля — одно и то же', () => {
    // Сама прежняя строка немой команды закреплена целиком выше
    // (этап B); здесь — что `pointer: null` её не трогает.
    const withNull = two().map((f) => ({ ...f, pointer: null }));
    const cmd = planSlideshow(two(), { motion: 'none' })!.commands[0];
    expect(planSlideshow(withNull, { motion: 'none' })!.commands[0]).toBe(cmd);
    expect(cmd).not.toMatch(/overlay|geq|color=/);
  });

  it('кольцо ложится по долям снимка, до полей холста', () => {
    const cmd = planSlideshow(two({ x: 0.5, y: 0.9064 }), { motion: 'none' })!
      .commands[0];
    // Сначала вписать снимок, потом кольцо, потом поля: `main_w` у
    // `overlay` — размер картинки снимка без полей.
    expect(cmd).toContain(
      '[0:v]scale=720:1560:force_original_aspect_ratio=decrease[sc0]',
    );
    expect(cmd).toContain(
      '[sc0][pr0]overlay=x=main_w*0.5-overlay_w/2+1:y=main_h*0.9064-overlay_h/2+1:',
    );
    expect(cmd).toMatch(
      /overlay=[^;]*,pad=720:1560:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1\[v0\]/,
    );
    // Второй кадр без указателя — прежняя цепочка.
    expect(cmd).toContain(
      '[1:v]scale=720:1560:force_original_aspect_ratio=decrease,pad=',
    );
  });

  it('кольцо видно в последнюю секунду кадра, с порогом на полкадра раньше', () => {
    // 3 с = 90 кадров: указатель с 60-го; порог (60 − 0.5) / 30.
    const cmd = planSlideshow(two({ x: 0.5, y: 0.5 }), { motion: 'none' })!
      .commands[0];
    expect(POINTER_FRAMES).toBe(30);
    expect(cmd).toContain('enable=1+sgn(t-1.9833)');
  });

  it('на коротком кадре — не дольше половины показа', () => {
    // 1.5 с = 45 кадров: половина — 22 кадра, порог (23 − 0.5) / 30.
    const cmd = planSlideshow(
      [
        {
          stepIndex: 0,
          url: 'a.png',
          seconds: 1.5,
          pointer: { x: 0.5, y: 0.5 },
        },
        { stepIndex: 1, url: 'b.png', seconds: 2 },
      ],
      { motion: 'none' },
    )!.commands[0];
    expect(cmd).toContain('enable=1+sgn(t-0.75)');
  });

  it('кольцо — источник внутри графа, длиной в кадр, без запятых внутри значений', () => {
    const cmd = planSlideshow(two({ x: 0.5, y: 0.5 }), { motion: 'none' })!
      .commands[0];
    const ring = /color=[^;]*\[pr0\]/.exec(cmd)![0];
    expect(ring).toContain('color=c=black@0:s=96x96:r=30:d=3,format=rgba,geq=');
    expect(ring).toContain('r=255:g=106:b=0');
    // Запятые — только между фильтрами цепочки (две), не внутри значений.
    expect(ring.split(',')).toHaveLength(3);
    expect(
      Object.keys(
        planSlideshow(two({ x: 0.5, y: 0.5 }), { motion: 'none' })!.inputs,
      ),
    ).toEqual(['frame0', 'frame1']);
  });

  it('с зумом кольцо ложится ДО приближения — и уезжает вместе с кнопкой', () => {
    const cmd = planSlideshow(two({ x: 0.5, y: 0.9 }), {
      motion: 'fade+zoom',
    })!.commands[0];
    const chain = /\[sc0\]\[pr0\]overlay=[^;]*\[v0\]/.exec(cmd)![0];
    expect(chain.indexOf('overlay=')).toBeLessThan(
      chain.indexOf('perspective='),
    );
  });

  it('указатель не двигает сетку времени: длительность та же', () => {
    expect(
      planSlideshow(two({ x: 0.5, y: 0.5 }), { motion: 'fade' })!.durationMs,
    ).toBe(planSlideshow(two(), { motion: 'fade' })!.durationMs);
  });

  it('указатель входит в отпечаток, но кадры без него хешируются как раньше', () => {
    const f = (pointer?: { x: number; y: number }) => [
      {
        stepIndex: 0,
        bytes: new Uint8Array([7]),
        seconds: 2,
        ...(pointer ? { pointer } : {}),
      },
    ];
    const none = slideshowContentHash(f(), null, null, 'none');
    const withNull = slideshowContentHash(
      [{ ...f()[0], pointer: null }],
      null,
      null,
      'none',
    );
    const a = slideshowContentHash(f({ x: 0.5, y: 0.5 }), null, null, 'none');
    const b = slideshowContentHash(f({ x: 0.5, y: 0.6 }), null, null, 'none');
    expect(withNull).toBe(none);
    expect(new Set([none, a, b]).size).toBe(3);
    // Формула до этапа H — буквально.
    const h = createHash('sha256');
    h.update('');
    h.update('\u0000');
    h.update('');
    h.update('\u0000');
    h.update('0:2::');
    h.update(Buffer.from([7]));
    expect(none).toBe(h.digest('hex'));
  });
});

describe('slideshowFingerprint / sameSlideshowContent — кадры сличаются перцептивно', () => {
  // Кадр 390×844 (как CAPTURE_VIEWPORT): белый фон, серый «блок
  // интерфейса» и прямоугольник, которым рисуем разницу.
  function png(patch?: {
    x: number;
    y: number;
    w: number;
    h: number;
    v: number;
  }): Uint8Array {
    const W = 390;
    const H = 844;
    const img = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = y > 100 && y < 300 && x > 20 && x < 370 ? 120 : 255;
        if (
          patch &&
          x >= patch.x &&
          x < patch.x + patch.w &&
          y >= patch.y &&
          y < patch.y + patch.h
        ) {
          v = patch.v;
        }
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    return new Uint8Array(PNG.sync.write(img));
  }
  const f = (bytes: Uint8Array, stepIndex = 0) => ({
    stepIndex,
    bytes,
    seconds: 2,
  });
  const base = png();
  // Мигающий курсор / сменившаяся минута — одна крошечная область.
  const jitter = png({ x: 200, y: 400, w: 2, h: 14, v: 0 });
  // Появилась целая строка текста (≈ 20 знаков) — это правка экрана.
  const newLine = png({ x: 20, y: 500, w: 200, h: 16, v: 0 });

  it('точная часть — прежний slideshowContentHash: строки до правки совпадают', () => {
    const fp = slideshowFingerprint([f(base)], 'a.mp3', null, 'none');
    const legacy = slideshowContentHash([f(base)], 'a.mp3', null, 'none');
    expect(fp.split('|')[0]).toBe(legacy);
    expect(sameSlideshowContent(legacy, fp)).toBe(true);
  });

  it('дрожание кадра — тот же ролик, новая строка текста — другой', () => {
    const a = slideshowFingerprint([f(base)], null, null, 'none');
    const b = slideshowFingerprint([f(jitter)], null, null, 'none');
    const c = slideshowFingerprint([f(newLine)], null, null, 'none');
    expect(a).not.toBe(b);
    expect(sameSlideshowContent(a, b)).toBe(true);
    expect(sameSlideshowContent(a, c)).toBe(false);
  });

  it('всё, кроме картинки, сличается точно', () => {
    const a = slideshowFingerprint([f(base)], 'a.mp3', null, 'none');
    expect(
      sameSlideshowContent(
        a,
        slideshowFingerprint([f(jitter)], 'b.mp3', null, 'none'),
      ),
    ).toBe(false);
    expect(
      sameSlideshowContent(
        a,
        slideshowFingerprint([f(jitter)], 'a.mp3', 'подписи', 'none'),
      ),
    ).toBe(false);
    expect(
      sameSlideshowContent(
        a,
        slideshowFingerprint([f(jitter)], 'a.mp3', null, 'fade'),
      ),
    ).toBe(false);
    expect(
      sameSlideshowContent(
        a,
        slideshowFingerprint(
          [{ ...f(jitter), seconds: 3 }],
          'a.mp3',
          null,
          'none',
        ),
      ),
    ).toBe(false);
  });

  it('другое число кадров или другой шаг — другой ролик', () => {
    const a = slideshowFingerprint([f(base)], null, null, 'none');
    expect(
      sameSlideshowContent(
        a,
        slideshowFingerprint([f(base), f(base, 1)], null, null, 'none'),
      ),
    ).toBe(false);
    expect(
      sameSlideshowContent(
        a,
        slideshowFingerprint([f(jitter, 1)], null, null, 'none'),
      ),
    ).toBe(false);
  });

  it('не-PNG кадр сличается только точно', () => {
    const raw1 = slideshowFingerprint(
      [f(new Uint8Array([1, 2]))],
      null,
      null,
      'none',
    );
    const raw2 = slideshowFingerprint(
      [f(new Uint8Array([1, 3]))],
      null,
      null,
      'none',
    );
    expect(raw1.split('|')[2]).toMatch(/^raw:/);
    expect(sameSlideshowContent(raw1, raw2)).toBe(false);
  });

  it('пустой или чужой прежний отпечаток — не совпадение', () => {
    const a = slideshowFingerprint([f(base)], null, null, 'none');
    expect(sameSlideshowContent(null, a)).toBe(false);
    expect(sameSlideshowContent('', a)).toBe(false);
    expect(sameSlideshowContent('старый-sha', a)).toBe(false);
  });

  it('порог строже снимка интерфейса: тумблер/значок в одной ячейке — «другой»', () => {
    // Значок 16×16 в одной ячейке сетки: ночной снимок (3 ячейки) счёл
    // бы экран прежним, ролик обязан пересобраться.
    const icon = png({ x: 40, y: 360, w: 16, h: 16, v: 0 });
    const a = slideshowFingerprint([f(base)], null, null, 'none');
    const b = slideshowFingerprint([f(icon)], null, null, 'none');
    expect(sameSlideshowContent(a, b)).toBe(false);
    expect(
      sameSlideshowContent(a, b, { cellDelta: 12, minChangedCells: 3 }),
    ).toBe(true);
    expect(TUTORIAL_FRAME_SENSITIVITY).toEqual({
      cellDelta: 8,
      minChangedCells: 1,
    });
  });

  it('чувствительность передаётся явно', () => {
    const a = slideshowFingerprint([f(base)], null, null, 'none');
    const b = slideshowFingerprint([f(jitter)], null, null, 'none');
    expect(
      sameSlideshowContent(a, b, { cellDelta: 1, minChangedCells: 1 }),
    ).toBe(false);
  });

  it('указатель: субпиксельный сдвиг — тот же ролик, заметный — другой', () => {
    const at = (x: number, y: number) =>
      slideshowFingerprint(
        [{ ...f(base), pointer: { x, y } }],
        null,
        null,
        'none',
      );
    expect(sameSlideshowContent(at(0.5, 0.5), at(0.5001, 0.4999))).toBe(true);
    expect(sameSlideshowContent(at(0.5, 0.5), at(0.52, 0.5))).toBe(false);
    // Точная часть указатель по-прежнему видит полностью.
    expect(at(0.5, 0.5).split('|')[0]).not.toBe(at(0.5001, 0.5).split('|')[0]);
  });

  it('средняя часть — без картинки', () => {
    const a = slideshowFingerprint([f(base)], 'a.mp3', null, 'none');
    const c = slideshowFingerprint([f(newLine)], 'a.mp3', null, 'none');
    expect(fingerprintRest(a)).toBe(fingerprintRest(c));
    expect(fingerprintRest('голый-sha')).toBeNull();
  });
});
