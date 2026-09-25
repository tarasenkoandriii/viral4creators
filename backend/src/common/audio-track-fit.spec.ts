import {
  LENGTH_TOLERANCE,
  MAX_TEMPO_CHANGE,
  overflowSeconds,
  planTrackFit,
} from './audio-track-fit';

/**
 * Правила §5 ТЗ TZ-Multilingual-YouTube.md (этап 138).
 *
 * Проверяется не арифметика, а решения: что считать дефектом, в каком
 * порядке чинить и когда перестать чинить машиной. Ошибка здесь не
 * видна ничем — зритель на чужом языке просто слышит фразу, которая
 * кончилась ничем, и никому об этом не сообщает.
 */
const VIDEO = 8;

describe('overflowSeconds', () => {
  it('считает перебор ВМЕСТЕ со сдвигом реплики от начала', () => {
    // Реплика редко начинается с нулевого кадра, и забыть про сдвиг —
    // значит проглядеть ровно тот случай, когда обрывает хвост.
    expect(
      overflowSeconds({
        voiceSeconds: 7,
        videoSeconds: VIDEO,
        speechStartSeconds: 1.5,
      }),
    ).toBeCloseTo(0.5, 2);
  });

  it('запас в хвосте — отрицательное число, а не ноль', () => {
    expect(
      overflowSeconds({ voiceSeconds: 5, videoSeconds: VIDEO }),
    ).toBeCloseTo(-3, 2);
  });
});

describe('planTrackFit', () => {
  it('короткая реплика принимается: в хвосте играет подложка', () => {
    // Недобор не дефект — тишина в конце бывает и у оригинала.
    expect(
      planTrackFit({ voiceSeconds: 4, videoSeconds: VIDEO }),
    ).toMatchObject({ action: 'accept' });
  });

  it('перебор в пределах допуска принимается', () => {
    const inTolerance = VIDEO * LENGTH_TOLERANCE - 0.01;
    expect(
      planTrackFit({ voiceSeconds: VIDEO + inTolerance, videoSeconds: VIDEO }),
    ).toMatchObject({ action: 'accept' });
  });

  it('первый ход — перевод короче, с запасом и округлением вверх', () => {
    // Запас в пять процентов: модель почти никогда не попадает ровно, а
    // недобор безвреден — в отличие от перебора.
    const fit = planTrackFit({ voiceSeconds: 10, videoSeconds: VIDEO });
    expect(fit.action).toBe('retranslate');
    if (fit.action !== 'retranslate') return;
    // 10 с против бюджета 8,4 с (ролик плюс допуск) — лишку 19,05 %.
    // Просим 25: округление вверх плюс те самые пять процентов запаса.
    // Попросить ровно столько, сколько лишку, значит почти наверняка
    // получить второй такой же перевод и потратить ход впустую.
    expect(fit.shorterByPercent).toBe(25);
  });

  it('второй раз перевод не переписывается — дальше только темп', () => {
    // Порядок ходов из ТЗ: текст правится один раз, потом звук.
    const fit = planTrackFit({
      voiceSeconds: 8.6,
      videoSeconds: VIDEO,
      retranslated: true,
    });
    expect(fit.action).toBe('retempo');
    if (fit.action !== 'retempo') return;
    // Ускорение считается от ОСТАВШЕГОСЯ бюджета, а не от длины ролика.
    expect(fit.rate).toBeGreaterThan(1);
    expect(fit.rate).toBeLessThanOrEqual(1 + MAX_TEMPO_CHANGE);
  });

  it('ускорение сверх предела — оператору, а не молча', () => {
    // Прежнее решение продукта (`common/postprod.ts`): двадцать
    // процентов звучат как испорченная запись. Здесь предел вдвое ниже.
    const fit = planTrackFit({
      voiceSeconds: 12,
      videoSeconds: VIDEO,
      retranslated: true,
    });
    expect(fit.action).toBe('handover');
    if (fit.action !== 'handover') return;
    expect(fit.reason).toMatch(/%/);
  });

  it('неизмеренная длительность — не повод решать', () => {
    // `null` это «не смогли измерить», и считать его нулём значит
    // выдать дорожку, про которую ничего не известно.
    expect(
      planTrackFit({ voiceSeconds: null, videoSeconds: VIDEO }),
    ).toMatchObject({ action: 'handover' });
    expect(
      planTrackFit({ voiceSeconds: NaN, videoSeconds: VIDEO }),
    ).toMatchObject({ action: 'handover' });
  });

  it('неизвестная длина ролика — тоже оператору', () => {
    expect(planTrackFit({ voiceSeconds: 5, videoSeconds: 0 })).toMatchObject({
      action: 'handover',
    });
  });

  it('реплика, начинающаяся позже конца ролика, не чинится сокращением', () => {
    // Сокращать нечего: бюджет отрицательный, и «перевести на 100 %
    // короче» — это не перевод.
    const fit = planTrackFit({
      voiceSeconds: 2,
      videoSeconds: VIDEO,
      speechStartSeconds: 9,
    });
    expect(fit.action).toBe('handover');
  });
});
