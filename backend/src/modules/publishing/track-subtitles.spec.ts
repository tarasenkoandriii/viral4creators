import { buildTrackSubtitles } from './track-subtitles';

/**
 * Этап 141 после аудита. Субтитр дорожки идёт за САМОЙ речью: сначала
 * по разметке синтеза, а без неё — по измеренной длине речи. Прежняя
 * редакция раскладывала перевод по длине строк ОРИГИНАЛА и тянула
 * последний субтитр до конца ролика, то есть отставала от голоса тем
 * сильнее, чем короче вышла реплика.
 */
const SPEECH = 'Steel mug keeps the heat\nSix hours';

/** Разметка синтеза: «Steel…» звучит 0–2 с, «Six hours» — 2–3 с. */
const alignment = (() => {
  const characters = [...SPEECH.replace('\n', ' ')];
  const starts: number[] = [];
  const ends: number[] = [];
  const firstLen = 'Steel mug keeps the heat '.length;
  characters.forEach((_, i) => {
    const t = i < firstLen ? (i / firstLen) * 2 : 2 + ((i - firstLen) / 9) * 1;
    starts.push(Number(t.toFixed(3)));
    ends.push(Number((t + 0.05).toFixed(3)));
  });
  return { characters, starts, ends };
})();

const base = {
  speech: SPEECH,
  speechStartSeconds: 1,
  videoSeconds: 8,
  voiceSeconds: 3,
  tempoRate: null,
};

describe('buildTrackSubtitles — разметка синтеза', () => {
  it('субтитр встаёт на секунды, которые вернул синтез, со сдвигом голоса', () => {
    // Голос вступает на первой секунде (`adelay`), а разметка считается
    // от начала файла: без сдвига субтитр шёл бы впереди речи.
    const srt = buildTrackSubtitles({ ...base, alignment });

    expect(srt).toMatch(/^1\n00:00:01,000 --> /);
    // Вторая реплика начинается на третьей секунде ролика: 1 + 2.
    expect(srt).toContain('\n2\n00:00:03,0');
    expect(srt).toContain('Six hours');
  });

  it('ускорение речи сжимает и субтитр', () => {
    // `atempo` стоит ДО `adelay`: ускоряется речь, а не момент её
    // начала. Значит вторая реплика приезжает на 1 + 2/1.25 = 2.6 с.
    const srt = buildTrackSubtitles({
      ...base,
      tempoRate: 1.25,
      alignment,
    });
    expect(srt).toContain('\n2\n00:00:02,6');
  });

  it('за конец ролика субтитр не уезжает', () => {
    // Речь, которую обрежет `-t`, не должна показываться после конца.
    const srt = buildTrackSubtitles({
      ...base,
      videoSeconds: 2,
      alignment,
    });
    expect(srt).not.toMatch(/00:00:0[3-9]/);
    expect(srt).toContain('00:00:02,000');
  });

  it('нулевое ускорение секунды не делит', () => {
    // 0 и отрицательное — это не ускорение, а деление на ноль.
    const srt = buildTrackSubtitles({ ...base, tempoRate: 0, alignment });
    expect(srt).toContain('00:00:01,000');
    expect(srt).not.toContain('Infinity');
  });
});

describe('buildTrackSubtitles — без разметки', () => {
  it('строки раскладываются внутри ИЗМЕРЕННОЙ речи, а не до конца ролика', () => {
    // Недобор у альтернативной дорожки штатен: в хвосте играет
    // подложка. Тянуть субтитр до конца ролика значило бы показывать
    // вторую реплику, когда голос уже замолчал.
    const srt = buildTrackSubtitles(base);

    expect(srt).toContain('--> 00:00:04,000');
    expect(srt).not.toContain('00:00:08,000');
  });

  it('ускорение укорачивает отрезок речи', () => {
    // 3 с речи при ×1.5 звучат две: 1 + 3/1.5 = 4 → 1 + 2 = 3.
    const srt = buildTrackSubtitles({ ...base, tempoRate: 1.5 });
    expect(srt).toContain('--> 00:00:03,000');
  });

  it('длину не измерили — остаётся конец ролика', () => {
    // Растянутый субтитр хуже точного, но лучше обрезанного.
    const srt = buildTrackSubtitles({ ...base, voiceSeconds: null });
    expect(srt).toContain('--> 00:00:08,000');
  });

  it('речь длиннее ролика обрезается по ролику', () => {
    // Дорожка, ушедшая человеку: реплика не влезла и будет обрублена.
    const srt = buildTrackSubtitles({ ...base, voiceSeconds: 20 });
    expect(srt).toContain('--> 00:00:08,000');
    expect(srt).not.toMatch(/00:00:(09|1\d|2\d)/);
  });

  it('склейка в одну строку даёт один субтитр, а не разбивку наугад', () => {
    // Модель могла вернуть не то число строк, и `parseTrackTranslation`
    // откатился к склейке: резать её самим значило бы выдумать, где
    // кончается первая мысль.
    const srt = buildTrackSubtitles({
      ...base,
      speech: 'Steel mug keeps the heat for six hours',
    });
    expect(srt).not.toContain('\n2\n');
  });

  it('говорить нечего — субтитра нет', () => {
    expect(buildTrackSubtitles({ ...base, speech: '  \n ' })).toBeNull();
  });
});
