import {
  APPROVAL_GRACE_MS,
  pairsInApprovalGrace,
  parseApprovalStamps,
  recordApprovalStamp,
  selectSweepableAssets,
  sweepPairKey,
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

  describe('свежие провалы — для потолка попыток (аудит 01.10.2026)', () => {
    const failed = (id: string) =>
      asset({ id, blobUrl: null, assemblyStatus: 'failed' });

    it('держит до failedKeep провалов свежее проигрываемого ролика', () => {
      const rows = [
        failed('f1'),
        failed('f2'),
        failed('f3'),
        failed('f4'),
        asset({ id: 'ok', assemblyStatus: 'complete' }),
        failed('old'),
      ];
      // f1 — ещё и «последняя попытка»; f4 — сверх потолка; old —
      // старше удачной сборки, считать его незачем.
      expect(doomed2(rows, 3)).toEqual(['f4', 'old']);
    });

    it('без failedKeep — прежнее правило (одна свежая строка)', () => {
      expect(doomed2([failed('f1'), failed('f2')], 0)).toEqual(['f2']);
    });

    it('провалы считаются по парам отдельно', () => {
      const rows = [
        failed('a1'),
        failed('a2'),
        asset({
          id: 'b1',
          subjectKey: '2',
          blobUrl: null,
          assemblyStatus: 'failed',
        }),
        asset({
          id: 'b2',
          subjectKey: '2',
          blobUrl: null,
          assemblyStatus: 'failed',
        }),
      ];
      expect(doomed2(rows, 2)).toEqual([]);
      expect(doomed2(rows, 1)).toEqual(['a2', 'b2']);
    });

    it('провал с файлом — не «попытка», а проигрываемый ролик', () => {
      const rows = [
        failed('f1'),
        asset({ id: 'fb', assemblyStatus: 'failed' }),
        failed('f2'),
      ];
      expect(doomed2(rows, 3)).toEqual(['f2']);
    });
  });
});

function doomed2(rows: SweepableAsset[], keep: number): string[] {
  return selectSweepableAssets(rows, keep).map((r) => r.id);
}

describe('прежний одобренный ролик и сутки после одобрения нового (аудит кронов 06.10.2026)', () => {
  const NOW = Date.UTC(2026, 9, 6, 12);
  const rows = () => [
    asset({ id: 'new', reviewed: true }),
    asset({ id: 'old', reviewed: true }),
    asset({ id: 'older', reviewed: true }),
  ];

  it('без отсрочки — прежний одобренный уходит (как раньше)', () => {
    expect(doomed(rows())).toEqual(['old', 'older']);
  });

  it('в отсрочке — держится ровно ОДИН прежний одобренный', () => {
    const grace = new Set([sweepPairKey({ subjectKey: '1', locale: 'ru' })]);
    expect(selectSweepableAssets(rows(), 0, grace).map((r) => r.id)).toEqual([
      'older',
    ]);
  });

  it('отсрочка — по отметке САМОГО СВЕЖЕГО одобренного и не дольше суток', () => {
    const fresh = new Map([['new', NOW - 60 * 60 * 1000]]);
    expect([...pairsInApprovalGrace(rows(), fresh, NOW)]).toEqual([
      sweepPairKey({ subjectKey: '1', locale: 'ru' }),
    ]);
    const stale = new Map([['new', NOW - APPROVAL_GRACE_MS - 1]]);
    expect(pairsInApprovalGrace(rows(), stale, NOW).size).toBe(0);
    // Отметка у прежнего, а не у свежего, отсрочки не даёт.
    const wrong = new Map([['old', NOW - 1000]]);
    expect(pairsInApprovalGrace(rows(), wrong, NOW).size).toBe(0);
  });

  it('одобренный без файла в отсрочку не идёт', () => {
    const r = [asset({ id: 'nofile', reviewed: true, blobUrl: null })];
    expect(pairsInApprovalGrace(r, new Map([['nofile', NOW]]), NOW).size).toBe(
      0,
    );
  });

  it('карта отметок: запись добавляет, старше недели выпадает, мусор — пустая карта', () => {
    const old = recordApprovalStamp(null, 'a', NOW - 8 * 24 * 3600_000);
    const raw = recordApprovalStamp(old, 'b', NOW);
    const parsed = parseApprovalStamps(raw);
    expect(parsed.get('b')).toBe(NOW);
    expect(parsed.has('a')).toBe(false);
    expect(parseApprovalStamps('не json').size).toBe(0);
    expect(parseApprovalStamps('[1,2]').size).toBe(0);
  });
});

describe('пара — с темой (заход 3 «Актуального демо», 06.10.2026)', () => {
  it('свежий тёмный ролик не вытесняет единственный светлый', () => {
    // Без темы в ключе тёмный занимал роли «последняя попытка» и
    // «проигрываемый» за всю пару, и светлый уходил — чередование тем
    // стирало бы ролики друг друга каждый тик.
    expect(
      doomed([
        asset({ id: 'dark', theme: 'dark' }),
        asset({ id: 'light', theme: 'light' }),
      ]),
    ).toEqual([]);
  });

  it('одобренный светлый держится при свежем одобренном тёмном', () => {
    expect(
      doomed([
        asset({ id: 'dark-ok', theme: 'dark', reviewed: true }),
        asset({ id: 'dark-old', theme: 'dark' }),
        asset({ id: 'light-ok', theme: 'light', reviewed: true }),
        asset({ id: 'light-old', theme: 'light' }),
      ]),
    ).toEqual(['dark-old', 'light-old']);
  });

  it('строка без темы — светлая (до тем всё снималось светлым)', () => {
    expect(sweepPairKey({ subjectKey: '1', locale: 'ru', theme: null })).toBe(
      sweepPairKey({ subjectKey: '1', locale: 'ru', theme: 'light' }),
    );
    expect(sweepPairKey({ subjectKey: '1', locale: 'ru' })).not.toBe(
      sweepPairKey({ subjectKey: '1', locale: 'ru', theme: 'dark' }),
    );
    // Прежний светлый без темы уходит, когда есть свежий светлый с темой.
    expect(
      doomed([
        asset({ id: 'new', theme: 'light' }),
        asset({ id: 'legacy', theme: null }),
      ]),
    ).toEqual(['legacy']);
  });

  it('отсрочка одобрения — тоже по теме: тёмное одобрение не держит прежний светлый', () => {
    const rows = [
      asset({ id: 'dark-ok', theme: 'dark', reviewed: true }),
      asset({ id: 'light-ok', theme: 'light', reviewed: true }),
      asset({ id: 'light-prev', theme: 'light', reviewed: true }),
    ];
    const now = Date.now();
    const grace = pairsInApprovalGrace(
      rows,
      new Map([['dark-ok', now - 60_000]]),
      now,
    );
    expect(selectSweepableAssets(rows, 0, grace).map((r) => r.id)).toEqual([
      'light-prev',
    ]);
  });
});
