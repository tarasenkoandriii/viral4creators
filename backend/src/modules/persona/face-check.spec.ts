import {
  buildFaceCheckPrompt,
  checkFaces,
  FACE_CHECK_MAX_INLINE_BYTES,
  FaceCheckGenerator,
  mayContainFace,
  parseFaceCheck,
} from './face-check';

const GOOD = {
  faces: 1,
  frontal: true,
  quality: 'good',
  screenOrPrint: false,
  sameAsSelfie: true,
  liveMotion: true,
  ageMin: 28,
  ageMax: 34,
};

function gen(text: unknown, fail = false) {
  const generateContent = jest.fn(async () => {
    if (fail) throw new Error('network');
    return { text, usageMetadata: { promptTokenCount: 10 } };
  });
  return { models: { generateContent } } as unknown as FaceCheckGenerator & {
    models: { generateContent: jest.Mock };
  };
}

const photo = { data: Buffer.from('jpeg'), mimeType: 'image/jpeg' };
const video = { data: Buffer.from('webm'), mimeType: 'video/webm;codecs=vp9' };

describe('parseFaceCheck — ответу модели не доверяем по форме', () => {
  it('полный ответ персоны разбирается как есть', () => {
    expect(parseFaceCheck(JSON.stringify(GOOD), 'persona', true)).toEqual(GOOD);
  });

  it('обёртка ```json и текст вокруг не мешают', () => {
    const raw = 'Here:\n```json\n' + JSON.stringify(GOOD) + '\n```';
    expect(parseFaceCheck(raw, 'persona', true)?.faces).toBe(1);
  });

  it('числа строками и булевы строками приводятся', () => {
    const r = parseFaceCheck(
      JSON.stringify({
        ...GOOD,
        faces: '1',
        frontal: 'true',
        screenOrPrint: 'no',
        ageMin: '30',
        ageMax: 36.4,
      }),
      'persona',
      true,
    );
    expect(r).toMatchObject({
      faces: 1,
      frontal: true,
      screenOrPrint: false,
      ageMin: 30,
      ageMax: 36,
    });
  });

  it('нет числа лиц, не JSON, пусто, отрицательное — null', () => {
    expect(parseFaceCheck('{"frontal":true}', 'persona', true)).toBeNull();
    expect(parseFaceCheck('not json', 'persona', true)).toBeNull();
    expect(parseFaceCheck('', 'persona', true)).toBeNull();
    expect(parseFaceCheck(null, 'persona', true)).toBeNull();
    expect(parseFaceCheck('{"faces":-1}', 'persona', true)).toBeNull();
    expect(parseFaceCheck('{"faces": 1', 'persona', true)).toBeNull();
  });

  it('отсутствующие поля — осторожные умолчания', () => {
    const r = parseFaceCheck('{"faces":1}', 'persona', true);
    expect(r).toEqual({
      faces: 1,
      frontal: false,
      quality: 'unknown',
      screenOrPrint: true,
      sameAsSelfie: false,
      liveMotion: false,
    });
  });

  it('незнакомое качество — unknown', () => {
    expect(
      parseFaceCheck('{"faces":1,"quality":"great"}', 'persona', false)
        ?.quality,
    ).toBe('unknown');
  });

  it('перевёрнутый диапазон возраста выпрямляется, неправдоподобный — отбрасывается', () => {
    expect(
      parseFaceCheck('{"faces":1,"ageMin":40,"ageMax":30}', 'persona', false),
    ).toMatchObject({ ageMin: 30, ageMax: 40 });
    const r = parseFaceCheck(
      '{"faces":1,"ageMin":0,"ageMax":300}',
      'persona',
      false,
    );
    expect(r?.ageMin).toBeUndefined();
    expect(r?.ageMax).toBeUndefined();
    // Только одна граница — возраста нет.
    expect(
      parseFaceCheck('{"faces":1,"ageMin":30}', 'persona', false)?.ageMin,
    ).toBeUndefined();
  });

  it('референс: возраст и живость не читаются, даже если модель прислала (§4.4)', () => {
    const r = parseFaceCheck(JSON.stringify(GOOD), 'reference', false);
    expect(r).toEqual({
      faces: 1,
      frontal: true,
      quality: 'good',
      screenOrPrint: false,
    });
  });

  it('массив с объектом — первый объект; толпа ограничена потолком', () => {
    expect(parseFaceCheck('[{"faces":500}]', 'reference', false)?.faces).toBe(
      20,
    );
  });
});

describe('buildFaceCheckPrompt', () => {
  it('референс не спрашивает возраст и живость', () => {
    const p = buildFaceCheckPrompt('reference', false);
    expect(p).not.toMatch(/age/i);
    expect(p).not.toMatch(/sameAsSelfie|liveMotion/);
  });

  it('персона с роликом спрашивает всё', () => {
    const p = buildFaceCheckPrompt('persona', true);
    for (const f of ['ageMin', 'ageMax', 'sameAsSelfie', 'liveMotion']) {
      expect(p).toContain(f);
    }
  });
});

describe('checkFaces', () => {
  it('фото и ролик уходят inline, тип без параметров; расход записан', async () => {
    const g = gen(JSON.stringify(GOOD));
    const onResponse = jest.fn();
    const r = await checkFaces(
      g,
      { purpose: 'persona', photo, liveness: video },
      { model: 'm', onResponse },
    );
    expect(r).toEqual(GOOD);
    expect(onResponse).toHaveBeenCalledTimes(1);
    const req = g.models.generateContent.mock.calls[0][0];
    expect(req.model).toBe('m');
    expect(req.contents[0].inlineData.mimeType).toBe('image/jpeg');
    expect(req.contents[1].inlineData.mimeType).toBe('video/webm');
    expect(req.contents[1].inlineData.data).toBe(
      Buffer.from('webm').toString('base64'),
    );
    expect(req.config.responseMimeType).toBe('application/json');
  });

  it('референс: ролик игнорируется', async () => {
    const g = gen('{"faces":0}');
    await checkFaces(
      g,
      { purpose: 'reference', photo, liveness: video },
      { model: 'm' },
    );
    const req = g.models.generateContent.mock.calls[0][0];
    expect(req.contents).toHaveLength(2);
  });

  it('никогда не бросает: нет клиента, сбой сети, сбой записи расхода, велик файл', async () => {
    expect(
      await checkFaces(null, { purpose: 'persona', photo }, { model: 'm' }),
    ).toBeNull();
    expect(
      await checkFaces(
        gen('', true),
        { purpose: 'persona', photo },
        { model: 'm' },
      ),
    ).toBeNull();
    const r = await checkFaces(
      gen('{"faces":1}'),
      { purpose: 'reference', photo },
      {
        model: 'm',
        onResponse: () => {
          throw new Error('db down');
        },
      },
    );
    expect(r?.faces).toBe(1);
    const big = {
      data: Buffer.alloc(FACE_CHECK_MAX_INLINE_BYTES + 1),
      mimeType: 'image/jpeg',
    };
    const g = gen('{"faces":1}');
    expect(
      await checkFaces(g, { purpose: 'reference', photo: big }, { model: 'm' }),
    ).toBeNull();
    expect(g.models.generateContent).not.toHaveBeenCalled();
  });

  it('геттер text бросает (блок безопасности) — null', async () => {
    const g = {
      models: {
        generateContent: async () => ({
          get text(): string {
            throw new Error('blocked');
          },
        }),
      },
    } as unknown as FaceCheckGenerator;
    expect(
      await checkFaces(g, { purpose: 'reference', photo }, { model: 'm' }),
    ).toBeNull();
  });
});

describe('mayContainFace', () => {
  it('нет проверки — осторожно «возможно лицо»', () => {
    expect(mayContainFace(null)).toBe(true);
    expect(
      mayContainFace({
        faces: 0,
        frontal: false,
        quality: 'good',
        screenOrPrint: false,
      }),
    ).toBe(false);
    expect(
      mayContainFace({
        faces: 2,
        frontal: false,
        quality: 'good',
        screenOrPrint: false,
      }),
    ).toBe(true);
  });
});
