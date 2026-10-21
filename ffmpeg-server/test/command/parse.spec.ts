import { parseJob } from '../../src/command/parse';
import { tokenize } from '../../src/command/tokenize';
import { avGetToken, parseFiltergraph } from '../../src/command/filtergraph';
import type { JobRequestBody } from '../../src/contracts';
import { PILOT_LIMITS } from '../fixtures/limits';

const job = (
  commands: string[],
  inputs: Record<string, string> = { src: 'https://inputs.test/a.mp4' },
  outputs: string[] = ['out.mp4'],
): JobRequestBody => ({
  input_files: inputs,
  output_files: outputs,
  ffmpeg_commands: commands,
});

const parse = (b: JobRequestBody) => parseJob(b, PILOT_LIMITS);

describe('tokenize', () => {
  it('одинарные, двойные кавычки и экранирование как в sh', () => {
    expect(tokenize(`a 'b c' "d e" f\\ g "x\\"y" 'z\\n'`)).toEqual({
      ok: true,
      tokens: ['a', 'b c', 'd e', 'f g', 'x"y', 'z\\n'],
    });
    expect(tokenize(`"a\\b" "c\\\\d" a"b"'c'`)).toEqual({
      ok: true,
      tokens: ['a\\b', 'c\\d', 'abc'],
    });
  });

  it('сохраняет фильтр с двоеточиями, обратными слешами и кавычками', () => {
    const r = tokenize(
      `-vf "drawtext=text='a\\: b':x=(w-tw)/2,subtitles={{s}}:force_style='A=1,B=2'"`,
    );
    expect(r).toEqual({
      ok: true,
      tokens: [
        '-vf',
        "drawtext=text='a\\: b':x=(w-tw)/2,subtitles={{s}}:force_style='A=1,B=2'",
      ],
    });
  });

  it.each([
    ['a; rm -rf /'],
    ['a && b'],
    ['a || b'],
    ['a | b'],
    ['a > /etc/x'],
    ['a < /etc/passwd'],
    ['$(id)'],
    ['"$(id)"'],
    ['`id`'],
    ['"`id`"'],
    ['$HOME'],
    ['"${HOME}"'],
    ['a\nb'],
    ['(a)'],
    ['#comment'],
    ['~/x'],
    ['{a,b}'],
    ["'unterminated"],
    ['"unterminated'],
    ['a\\'],
    ['a\u0000b'],
    ['a\u0007b'],
  ])('отвергает %j', (cmd) => {
    expect(tokenize(cmd).ok).toBe(false);
  });

  it('буквально внутри одинарных кавычек: $ и ` не подстановка', () => {
    expect(tokenize(`'$(id) \`x\`'`)).toEqual({
      ok: true,
      tokens: ['$(id) `x`'],
    });
  });

  it('glob-символы без кавычек остаются буквальными (-map 0:a?)', () => {
    expect(tokenize('-map 0:a?')).toEqual({
      ok: true,
      tokens: ['-map', '0:a?'],
    });
  });
});

describe('filtergraph', () => {
  it('av_get_token снимает уровень экранирования и хвостовые пробелы', () => {
    expect(avGetToken(` a\\,b 'c,d'  ,x`, 0, ',')).toEqual({
      value: 'a,b c,d',
      pos: 13,
    });
  });

  it('разбирает метки, цепочки и опции двух уровней', () => {
    const r = parseFiltergraph(
      "[0:v]crop='floor(iw/2)*2':ih,subtitles=inputs/s.srt:force_style='A=1,B=2'[v];[1:a]anull[a]",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filters.map((f) => f.name)).toEqual([
      'crop',
      'subtitles',
      'anull',
    ]);
    expect(r.filters[0].inputs).toEqual(['0:v']);
    expect(r.filters[1].options).toEqual([
      { key: null, position: 0, value: 'inputs/s.srt' },
      { key: 'force_style', position: null, value: 'A=1,B=2' },
    ]);
    expect(r.filters[2].outputs).toEqual(['a']);
  });
});

describe('parseJob — корректные запросы', () => {
  it('подставляет {{key}}, {{output}}, inputs/x и outputs/x', () => {
    const r = parse(
      job(['ffmpeg -i inputs/src -vf "scale=2:2" outputs/out.mp4'], {
        src: 'https://inputs.test/a.mp4',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.inputs).toEqual([
      {
        key: 'src',
        url: 'https://inputs.test/a.mp4',
        localName: 'inputs/src.mp4',
      },
    ]);
    const argv = r.plan.steps[0].argv;
    expect(argv).toContain('inputs/src.mp4');
    expect(argv[argv.length - 1]).toBe('outputs/out.mp4');
  });

  it('цепочка: промежуточный файл уходит в work/ и читается следующей командой', () => {
    const r = parse(
      job([
        '-i {{src}} -t 1 -c:v libx264 {{tmp.mp4}}',
        '-i {{tmp.mp4}} -vf "scale=320:-2" -c:v libx264 {{out.mp4}}',
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.intermediates).toEqual(['work/tmp.mp4']);
    expect(r.plan.steps[0].argv.at(-1)).toBe('work/tmp.mp4');
    expect(r.plan.steps[1].argv).toContain('work/tmp.mp4');
    expect(r.plan.steps[1].argv.at(-1)).toBe('outputs/out.mp4');
  });

  it('следующая команда может читать объявленный результат предыдущей', () => {
    const r = parse(
      job(
        [
          '-i {{src}} -c:v copy {{a.mp4}}',
          '-ss 1 -i {{a.mp4}} -frames:v 1 -q:v 3 {{p.jpg}}',
        ],
        undefined,
        ['a.mp4', 'p.jpg'],
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps[1].argv).toContain('outputs/a.mp4');
  });

  it('путь внутри subtitles= подставляется, остальной фильтр не меняется', () => {
    const r = parse(
      job(
        [
          `-i {{src}} -vf "subtitles={{subs}}:force_style='FontName=Arial,FontSize=22'" -c:v libx264 {{out.mp4}}`,
        ],
        {
          src: 'https://inputs.test/a.mp4',
          subs: 'https://inputs.test/s.srt?sig=1',
        },
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const argv = r.plan.steps[0].argv;
    expect(argv[argv.indexOf('-vf') + 1]).toBe(
      "subtitles=inputs/subs.srt:force_style='FontName=Arial,FontSize=22'",
    );
  });

  it('-threads не дублируется и не превышает лимит', () => {
    const r = parse(
      job(['-threads 16 -i {{src}} -threads 1 -c:v libx264 {{out.mp4}}']),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const argv = r.plan.steps[0].argv;
    const values = argv
      .map((a, i) => (a === '-threads' ? argv[i + 1] : null))
      .filter((v) => v !== null);
    expect(values).toEqual(['2', '1']);
    expect(argv.filter((a) => a === '-y')).toHaveLength(1);
  });
});

describe('parseJob — отказ', () => {
  const unsupported = (
    cmds: string[],
    inputs?: Record<string, string>,
    outs?: string[],
  ) => {
    const r = parse(job(cmds, inputs, outs));
    expect(r).toMatchObject({ ok: false, code: 'UNSUPPORTED_COMMAND' });
  };

  it.each([
    ['shell ;', '-i {{src}} {{out.mp4}}; rm -rf /'],
    ['shell &&', '-i {{src}} {{out.mp4}} && curl x'],
    ['$(...)', '-i {{src}} -metadata "title=$(id)" {{out.mp4}}'],
    ['обратные кавычки', '-i {{src}} -metadata "title=`id`" {{out.mp4}}'],
    ['..', '-i inputs/../../etc/passwd {{out.mp4}}'],
    ['абсолютный путь входа', '-i /etc/passwd {{out.mp4}}'],
    ['абсолютный путь выхода', '-i {{src}} /tmp/out.mp4'],
    ['/dev/*', '-i /dev/zero {{out.mp4}}'],
    ['URL в -i', '-i https://evil.test/x.mp4 {{out.mp4}}'],
    ['file: в -i', '-i file:/etc/passwd {{out.mp4}}'],
    ['concat: протокол', '-i concat:inputs/a|inputs/b {{out.mp4}}'],
    [
      'movie=',
      '-i {{src}} -vf "movie=/etc/passwd[m];[0:v][m]overlay" {{out.mp4}}',
    ],
    [
      'amovie=',
      '-i {{src}} -filter_complex "amovie=inputs/src.mp4[a]" -map "[a]" {{out.mp4}}',
    ],
    ['-f concat с внешним путём', '-f concat -safe 0 -i {{src}} {{out.mp4}}'],
    ['-f lavfi вход', '-f lavfi -i testsrc {{out.mp4}}'],
    ['-f hls выход', '-i {{src}} -f hls {{out.mp4}}'],
    ['неизвестная опция', '-i {{src}} -dump_attachment:t x {{out.mp4}}'],
    [
      'protocol_whitelist от клиента',
      '-protocol_whitelist file,http -i {{src}} {{out.mp4}}',
    ],
    ['запрещённый кодек', '-i {{src}} -c:v libx265 {{out.mp4}}'],
    [
      'запрещённый фильтр',
      '-i {{src}} -vf "sendcmd=f=/etc/passwd" {{out.mp4}}',
    ],
    [
      'fontfile drawtext',
      `-i {{src}} -vf "drawtext=fontfile=/etc/passwd:text=x" {{out.mp4}}`,
    ],
    [
      'textfile drawtext',
      `-i {{src}} -vf "drawtext=textfile=/etc/passwd" {{out.mp4}}`,
    ],
    [
      'subtitles с абсолютным путём',
      '-i {{src}} -vf "subtitles=/etc/passwd" {{out.mp4}}',
    ],
    [
      'subtitles с URL',
      `-i {{src}} -vf "subtitles='http\\://x/s.srt'" {{out.mp4}}`,
    ],
    [
      'subtitles fontsdir',
      '-i {{src}} -vf "subtitles={{src}}:fontsdir=/" {{out.mp4}}',
    ],
    [
      'плейсхолдер вне файловой опции',
      `-i {{src}} -vf "drawtext=text='{{src}}'" {{out.mp4}}`,
    ],
    [
      'плейсхолдер, спрятанный экранированием',
      '-i {{src}} -vf "subtitles={\\{src}}" {{out.mp4}}',
    ],
    [
      'metadata пишет не .txt',
      '-i {{src}} -vf "metadata=mode=print:file={{x.mp4}}" -f null -',
    ],
    ['запись во вход', '-i {{src}} {{src}}'],
    ['чтение непроизведённого файла', '-i {{nope}} {{out.mp4}}'],
    ['выход без расширения', '-i {{src}} {{out}}'],
    ['"-" без -f null', '-i {{src}} -'],
    ['висящие опции', '-i {{src}} {{out.mp4}} -c:v libx264'],
    ['ведущий бинарник не ffmpeg', 'ffprobe -i {{src}} {{out.mp4}}'],
    ['абсолютный бинарник', '/usr/bin/ffmpeg -i {{src}} {{out.mp4}}'],
    ['sh -c', 'sh -c "ffmpeg -i x y"'],
    ['входная опция перед выходом', '-i {{src}} -loop 1 {{out.mp4}}'],
    ['плейсхолдер как часть токена', '-i x{{src}} {{out.mp4}}'],
  ])('%s', (_name, cmd) => {
    unsupported([cmd]);
  });

  it('файл пишется дважды', () => {
    unsupported(['-i {{src}} {{out.mp4}}', '-i {{src}} {{out.mp4}}']);
  });

  it('чтение собственного результата в той же команде', () => {
    unsupported(['-i {{src}} -i {{out.mp4}} {{out.mp4}}']);
  });

  it.each([
    [
      'пересечение имён входов и выходов',
      job(
        ['-i {{a.mp4}} {{a.mp4}}'],
        { 'a.mp4': 'https://inputs.test/a.mp4' },
        ['a.mp4'],
      ),
    ],
    [
      'неизвестное поле',
      {
        ...job(['-i {{src}} {{out.mp4}}']),
        webhook: 'x',
      } as unknown as JobRequestBody,
    ],
    [
      'ключ входа с ..',
      job(['-i {{src}} {{out.mp4}}'], { '..': 'https://inputs.test/a' }),
    ],
    [
      'ключ входа со слешем',
      job(['-i {{src}} {{out.mp4}}'], { 'a/b': 'https://inputs.test/a' }),
    ],
    [
      'имя выхода с путём',
      job(['-i {{src}} {{out.mp4}}'], undefined, ['../out.mp4']),
    ],
    [
      'абсолютное имя выхода',
      job(['-i {{src}} {{out.mp4}}'], undefined, ['/tmp/out.mp4']),
    ],
    [
      'выход не создаётся',
      job(['-i {{src}} {{out.mp4}}'], undefined, ['out.mp4', 'b.mp4']),
    ],
    ['пустые команды', job([])],
    ['слишком много команд', job(Array(11).fill('-i {{src}} {{o.mp4}}'))],
    [
      'URL не строка',
      {
        input_files: { a: 1 },
        output_files: ['o.mp4'],
        ffmpeg_commands: ['x'],
      } as unknown as JobRequestBody,
    ],
  ])('%s → INVALID_REQUEST', (_n, body) => {
    expect(parse(body)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('лимит размера текста команд', () => {
    const r = parseJob(job(['-i {{src}} {{out.mp4}}']), {
      ...PILOT_LIMITS,
      maxCommandsTextBytes: 10,
    });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
});

describe('аудит SEC: регрессии FF-SEC-01/02/03', () => {
  const v = { v: 'https://a.test/v.mp4' };
  const rejected = (
    cmd: string,
    inputs: Record<string, string> = v,
    outs = ['o.mp4'],
  ) =>
    expect(parse(job([cmd], inputs, outs))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_COMMAND',
    });

  it.each([
    // FF-SEC-01: `/key=` — значение опции из файла (пробы аудитора p1-parse.js).
    [
      'drawtext /text=',
      'ffmpeg -i {{v}} -vf "drawtext=/text=/etc/passwd" {{o.mp4}}',
    ],
    [
      'drawtext /text= в чужой workspace',
      'ffmpeg -i {{v}} -vf "drawtext=/text=../../other-job/outputs/x.mp4" {{o.mp4}}',
    ],
    [
      'drawtext /fontfile=',
      'ffmpeg -i {{v}} -vf "drawtext=text=a:/fontfile=inputs/v.mp4" {{o.mp4}}',
    ],
    [
      'filter_complex /text=',
      'ffmpeg -i {{v}} -filter_complex "[0:v]drawtext=/text=/proc/self/environ[x]" -map [x] {{o.mp4}}',
    ],
    [
      'экранированный /text=',
      'ffmpeg -i {{v}} -vf "drawtext=expansion=none:\\\\/text=x" {{o.mp4}}',
    ],
    [
      'неизвестный ключ фильтра',
      'ffmpeg -i {{v}} -vf "scale=320:240:flags=bicubic" {{o.mp4}}',
    ],
    ['лишняя позиционная', 'ffmpeg -i {{v}} -vf "setsar=1:2" {{o.mp4}}'],
    [
      'drawtext: % без expansion=none',
      'ffmpeg -i {{v}} -vf "drawtext=text=\'%{pts}\'" {{o.mp4}}',
    ],
    [
      'enum вне корпуса',
      'ffmpeg -i {{v}} -vf "xfade=transition=dissolve:duration=1:offset=0" {{o.mp4}}',
    ],
    [
      'выражение с while/st',
      'ffmpeg -i {{v}} -vf "geq=r=\'st(0,0);while(lt(ld(0),1e9),st(0,ld(0)+1))\'" {{o.mp4}}',
    ],
    ['ключ lum у geq', 'ffmpeg -i {{v}} -vf "geq=lum=\'p(X,Y)\'" {{o.mp4}}'],
    // FF-SEC-02: размеры кадров.
    [
      'scale=100000:100000',
      'ffmpeg -i {{v}} -vf scale=100000:100000 {{o.mp4}}',
    ],
    ['scale 1920x1920', 'ffmpeg -i {{v}} -vf scale=1920:1920 {{o.mp4}}'],
    ['scale выражением', 'ffmpeg -i {{v}} -vf scale=iw*2:ih*2 {{o.mp4}}'],
    ['scale с одной стороной', 'ffmpeg -i {{v}} -vf scale=720 {{o.mp4}}'],
    ['pad больше профиля', 'ffmpeg -i {{v}} -vf "pad=4000:4000:0:0" {{o.mp4}}'],
    [
      'color=s=30000x30000',
      'ffmpeg -i {{v}} -filter_complex "color=s=30000x30000:d=1[c];[0:v][c]overlay[x]" -map [x] {{o.mp4}}',
    ],
    ['fps выше профиля', 'ffmpeg -i {{v}} -vf fps=240 {{o.mp4}}'],
    ['-r выше профиля', 'ffmpeg -i {{v}} -r 120 {{o.mp4}}'],
    // FF-SEC-03: бесконечные источники и длительности.
    ['-stream_loop -1 без -t', 'ffmpeg -stream_loop -1 -i {{v}} {{o.mp4}}'],
    ['-loop 1 -t 999999', 'ffmpeg -loop 1 -t 999999 -i {{v}} {{o.mp4}}'],
    ['-loop 1 без -t', 'ffmpeg -loop 1 -i {{v}} {{o.mp4}}'],
    ['-ss больше профиля', 'ffmpeg -ss 601 -i {{v}} {{o.mp4}}'],
    ['-t HH:MM:SS больше профиля', 'ffmpeg -i {{v}} -t 01:00:00 {{o.mp4}}'],
    [
      'color без d',
      'ffmpeg -i {{v}} -filter_complex "color=c=black@0:s=96x96[c];[0:v][c]overlay[x]" -map [x] {{o.mp4}}',
    ],
    [
      'anullsrc без границы',
      'ffmpeg -i {{v}} -filter_complex "anullsrc=channel_layout=stereo[a]" -map 0:v -map [a] {{o.mp4}}',
    ],
    [
      'apad без границы',
      'ffmpeg -i {{v}} -filter_complex "[0:a]apad[a]" -map 0:v -map [a] {{o.mp4}}',
    ],
    [
      'atrim больше профиля',
      'ffmpeg -i {{v}} -filter_complex "[0:a]apad,atrim=0:9999[a]" -map 0:v -map [a] {{o.mp4}}',
    ],
  ])('%s', (_n, cmd) => {
    rejected(cmd);
  });

  it('metadata /file= и subtitles /force_style= отвергаются', () => {
    rejected(
      'ffmpeg -i {{v}} -vf "metadata=mode=print:/file=inputs/p.txt" {{o.mp4}}',
      {
        ...v,
        p: 'https://a.test/p.txt',
      },
    );
    rejected(
      'ffmpeg -i {{v}} -vf "subtitles={{s}}:/force_style=/etc/hostname" {{o.mp4}}',
      {
        ...v,
        s: 'https://a.test/s.srt',
      },
    );
  });

  it.each([
    ['вертикальный 1080x1920', 'ffmpeg -i {{v}} -vf scale=1080:1920 {{o.mp4}}'],
    ['scale с -2', 'ffmpeg -i {{v}} -vf scale=302:-2 {{o.mp4}}'],
    [
      'drawtext без expansion и без %',
      'ffmpeg -i {{v}} -vf "drawtext=text=\'viral4creators\':fontsize=h/14" {{o.mp4}}',
    ],
    [
      'drawtext с % и expansion=none',
      'ffmpeg -i {{v}} -vf "drawtext=expansion=none:text=\'100\\%\'" {{o.mp4}}',
    ],
    [
      '-loop 1 с -t у выхода',
      'ffmpeg -loop 1 -framerate 25 -i {{v}} -t 5 {{o.mp4}}',
    ],
    [
      '-stream_loop -1 с -t 600',
      'ffmpeg -stream_loop -1 -i {{v}} -t 600 {{o.mp4}}',
    ],
    [
      'apad + atrim',
      'ffmpeg -i {{v}} -filter_complex "[0:a]apad,atrim=end_sample=44100[a]" -map 0:v -map [a] {{o.mp4}}',
    ],
  ])('допустимо: %s', (_n, cmd) => {
    expect(parse(job([cmd], v, ['o.mp4']))).toMatchObject({ ok: true });
  });
});
