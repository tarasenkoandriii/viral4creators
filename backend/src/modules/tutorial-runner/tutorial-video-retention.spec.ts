import {
  selectSweepableAssets,
  SweepableAsset,
} from './tutorial-video-retention';

/** Строка в том виде, в каком её отдаёт выборка подметальщика. */
function asset(over: Partial<SweepableAsset> & { id: string }): SweepableAsset {
  return {
    subjectKey: '1',
    locale: 'ru',
    reviewed: false,
    blobUrl: `https://blob.example.com/tutorial-videos/1/${over.id}.mp4`,
    ...over,
  };
}

/** Что удалять — списком id, в порядке возврата. */
function doomed(rows: SweepableAsset[]): string[] {
  return selectSweepableAssets(rows).map((r) => r.id);
}

describe('selectSweepableAssets', () => {
  it('пусто на входе — пусто на выходе', () => {
    expect(doomed([])).toEqual([]);
  });

  it('одна строка в паре не удаляется никогда', () => {
    expect(doomed([asset({ id: 'a' })])).toEqual([]);
  });

  it('три ночи подряд собранных — остаётся одна, свежая', () => {
    // Ради этого всё и заведено: без уборки пара растёт на строку и
    // на mp4 каждую ночь, навсегда.
    expect(
      doomed([asset({ id: 'n3' }), asset({ id: 'n2' }), asset({ id: 'n1' })]),
    ).toEqual(['n2', 'n1']);
  });

  it('одобренный ролик не удаляется, сколько бы свежих ни накопилось', () => {
    // Он — то, что видит посетитель. «Оставить первые три» удалило
    // бы его на четвёртую ночь без одобрения, и обучалка пропала бы
    // с экрана молча.
    expect(
      doomed([
        asset({ id: 'n4' }),
        asset({ id: 'n3' }),
        asset({ id: 'n2' }),
        asset({ id: 'old-approved', reviewed: true }),
      ]),
    ).toEqual(['n3', 'n2']);
  });

  it('свежий провал не вытесняет последний собранный ролик', () => {
    // Иначе одна неудачная ночь оставляла бы пару вовсе без
    // проигрываемого файла.
    expect(
      doomed([
        asset({ id: 'fail-today', blobUrl: null }),
        asset({ id: 'ok-yesterday' }),
        asset({ id: 'ok-earlier' }),
      ]),
    ).toEqual(['ok-earlier']);
  });

  it('свежий провал остаётся — в нём единственная запись о причине', () => {
    expect(
      doomed([
        asset({ id: 'fail-today', blobUrl: null }),
        asset({ id: 'fail-yesterday', blobUrl: null }),
      ]),
    ).toEqual(['fail-yesterday']);
  });

  it('три роли на трёх разных строках — остаются все три', () => {
    expect(
      doomed([
        asset({ id: 'fail-today', blobUrl: null }),
        asset({ id: 'ok-yesterday' }),
        asset({ id: 'approved-week-ago', reviewed: true }),
        asset({ id: 'ok-month-ago' }),
      ]),
    ).toEqual(['ok-month-ago']);
  });

  it('пары не смешиваются: другой шаг — свой счёт', () => {
    expect(
      doomed([
        asset({ id: 'a2', subjectKey: '1' }),
        asset({ id: 'a1', subjectKey: '1' }),
        asset({ id: 'b2', subjectKey: '2' }),
        asset({ id: 'b1', subjectKey: '2' }),
      ]),
    ).toEqual(['a1', 'b1']);
  });

  it('пары не смешиваются: другая локаль — своя пара', () => {
    // Тот же шаг на пяти языках — пять разных роликов, а не пять
    // попыток снять один (этап C). Считать их одной парой значило бы
    // удалять четыре языка из пяти каждую ночь.
    expect(
      doomed([
        asset({ id: 'ru2', locale: 'ru' }),
        asset({ id: 'ru1', locale: 'ru' }),
        asset({ id: 'en2', locale: 'en' }),
        asset({ id: 'en1', locale: 'en' }),
      ]),
    ).toEqual(['ru1', 'en1']);
  });

  it('одобренный, но без файла — не роль, а мусор в данных', () => {
    // Одобрять нечего, пока файла нет (§4.6 ТЗ). Флаг `reviewed` на
    // строке без `blobUrl` не должен давать ей бессрочную прописку.
    expect(
      doomed([
        asset({ id: 'ok-today' }),
        asset({ id: 'weird', blobUrl: null, reviewed: true }),
      ]),
    ).toEqual(['weird']);
  });

  it('провалившаяся строка с живым файлом считается проигрываемой', () => {
    // Состояние `failed` + `blobUrl` реально достижимо (икота Blob на
    // уборке кадров после успешной перезаливки), и именно такую
    // строку оператор одобряет, а консультант отдаёт посетителю: оба
    // читают `blobUrl`, а не статус. Правило обязано читать то же
    // самое, иначе подметальщик сносит показываемый ролик (находка
    // повторного сквозного аудита A+B+C).
    expect(
      doomed([
        asset({ id: 'today-no-file', blobUrl: null }),
        asset({ id: 'shown-to-visitor', reviewed: true }),
        asset({ id: 'older' }),
      ]),
    ).toEqual(['older']);
  });

  it('несколько одобренных — остаётся только самый свежий из них', () => {
    expect(
      doomed([
        asset({ id: 'approved-new', reviewed: true }),
        asset({ id: 'approved-old', reviewed: true }),
      ]),
    ).toEqual(['approved-old']);
  });
});
