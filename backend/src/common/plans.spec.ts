import {
  allowsAspectRatio,
  DEFAULT_PLAN,
  featureDeniedMessage,
  isPlanId,
  minimalPlanFor,
  planAllows,
  planOf,
  PLAN_IDS,
  PLANS,
  plansFor,
  resolveTargetAspectRatio,
} from './plans';

describe('матрица режимов (ТЗ §23)', () => {
  it('lite — по умолчанию, и это самый узкий пакет', () => {
    expect(DEFAULT_PLAN).toBe('LITE');
    expect(planOf(null)).toBe('LITE');
    expect(planOf('GOLD')).toBe('LITE');
    expect(planOf('PREMIUM')).toBe('PREMIUM');
    expect(isPlanId('STANDARD')).toBe(true);
    expect(isPlanId('lite')).toBe(false);
  });

  it('lite: только разбор и генерация в родных форматах', () => {
    for (const f of [
      'library',
      'relevance',
      'audit',
      'publication',
      'brandManifest',
      'referenceAssets',
      'characterReplacement',
      'customAspectRatio',
      // Этап 47 (В-2.6): полная модель Veo — 2,7× к цене рендера.
      'fullQualityVideo',
      // Этап 73: клонирование голоса — тот же тариф, что brandManifest.
      'voiceCloning',
      // Доп. запрос владельца продукта: дубляж — премиальный уровень
      // озвучки, LITE его не видит по той же причине, что и остальное.
      'voiceDub',
    ] as const) {
      expect(planAllows('LITE', f)).toBe(false);
    }
    expect(allowsAspectRatio('LITE', '16:9')).toBe(true);
    expect(allowsAspectRatio('LITE', '9:16')).toBe(true);
    expect(allowsAspectRatio('LITE', '3:4')).toBe(false);
    expect(allowsAspectRatio('LITE', '21:9')).toBe(false);
  });

  it('standard: всё, кроме библиотеки; premium: всё', () => {
    expect(planAllows('STANDARD', 'library')).toBe(false);
    for (const f of [
      'relevance',
      'audit',
      'publication',
      'brandManifest',
      'referenceAssets',
      'characterReplacement',
      'customAspectRatio',
      'fullQualityVideo',
      'voiceCloning',
    ] as const) {
      expect(planAllows('STANDARD', f)).toBe(true);
      expect(planAllows('PREMIUM', f)).toBe(true);
    }
    expect(planAllows('PREMIUM', 'library')).toBe(true);
    // формат кадра не ограничен ни у одного из двух старших
    expect(allowsAspectRatio('STANDARD', '21:9')).toBe(true);
    expect(allowsAspectRatio('PREMIUM', '3:4')).toBe(true);
  });

  it('minimalPlanFor называет самый дешёвый пакет с этой возможностью', () => {
    expect(minimalPlanFor('library')).toBe('PREMIUM');
    expect(minimalPlanFor('audit')).toBe('STANDARD');
    expect(PLAN_IDS).toEqual(['LITE', 'STANDARD', 'PREMIUM']);
  });

  it('avatarLipsync — входит в PREMIUM и только в него', () => {
    // Решение владельца продукта: аватар перестал быть пилотом.
    // Раньше признак стоял `false` в базе матрицы и был выключен сразу
    // у всех трёх тарифов, а доступ существовал только у оператора
    // через ActorsController, минуя эту матрицу вовсе.
    expect(planAllows('LITE', 'avatarLipsync')).toBe(false);
    expect(planAllows('STANDARD', 'avatarLipsync')).toBe(false);
    expect(planAllows('PREMIUM', 'avatarLipsync')).toBe(true);
    // Теперь `minimalPlanFor` отвечает про него ЧЕСТНО — находит
    // настоящий тариф, а не откатывается к старшему оттого, что фичи
    // нет нигде. До этого решения обе ветки давали 'PREMIUM', и
    // отличить правду от отката было нельзя.
    expect(minimalPlanFor('avatarLipsync')).toBe('PREMIUM');
    expect(featureDeniedMessage('avatarLipsync')).toContain('Premium');
  });

  it('voiceCloning (этап 73) — тот же тариф, что brandManifest (§3.6.1 решён этим значением)', () => {
    expect(planAllows('LITE', 'voiceCloning')).toBe(false);
    expect(planAllows('STANDARD', 'voiceCloning')).toBe(true);
    expect(planAllows('PREMIUM', 'voiceCloning')).toBe(true);
    expect(minimalPlanFor('voiceCloning')).toBe('STANDARD');
    expect(featureDeniedMessage('voiceCloning')).toContain('Standard');
  });

  it('voiceDub — доп. запрос владельца продукта: дубляж только в Premium, не как voiceover (Standard)', () => {
    // voiceover сам по себе не гейтится отдельным признаком — он входит
    // в 'brandManifest' (Standard и выше); voiceDub уже, ровно premium.
    expect(planAllows('LITE', 'voiceDub')).toBe(false);
    expect(planAllows('STANDARD', 'voiceDub')).toBe(false);
    expect(planAllows('PREMIUM', 'voiceDub')).toBe(true);
    expect(minimalPlanFor('voiceDub')).toBe('PREMIUM');
    expect(featureDeniedMessage('voiceDub')).toContain('Premium');
  });

  it('siteTutorial (этап 111) — Standard и выше, как brandManifest', () => {
    // Гейт строже обычного шага визарда не из-за ИИ (его в этой фиче
    // нет), а из-за секунд владения контейнером с Chromium: раунд — это
    // свежий запуск браузера, live-вход держит его минутами.
    expect(planAllows('LITE', 'siteTutorial')).toBe(false);
    expect(planAllows('STANDARD', 'siteTutorial')).toBe(true);
    expect(planAllows('PREMIUM', 'siteTutorial')).toBe(true);
    expect(minimalPlanFor('siteTutorial')).toBe('STANDARD');
    expect(featureDeniedMessage('siteTutorial')).toContain('Standard');
  });

  it('текст отказа называет нужный режим и говорит, что сейчас бесплатно', () => {
    const msg = featureDeniedMessage('library');
    expect(msg).toContain('Premium');
    expect(msg).toContain('бесплатны');
    expect(featureDeniedMessage('audit')).toContain('Standard');
  });

  it('каждый режим описан для карточки выбора', () => {
    for (const id of PLAN_IDS) {
      expect(PLANS[id].title.length).toBeGreaterThan(0);
      expect(PLANS[id].summary.length).toBeGreaterThan(20);
    }
  });

  it('Г-5.2: plansFor переводит summary под локаль, title и features не трогает', () => {
    const ru = plansFor('ru');
    const en = plansFor('en');
    for (const id of PLAN_IDS) {
      // title — имя пакета, одинаковое во всех локалях.
      expect(en[id].title).toBe(PLANS[id].title);
      // features/aspectRatios — те же ссылки на канонические данные,
      // локаль их не переопределяет (проверки прав от локали не зависят).
      expect(en[id].features).toEqual(PLANS[id].features);
      expect(en[id].aspectRatios).toEqual(PLANS[id].aspectRatios);
      // summary — переведён и отличается от русского оригинала.
      expect(en[id].summary.length).toBeGreaterThan(20);
      expect(en[id].summary).not.toBe(PLANS[id].summary);
    }
    // 'ru' — тот же текст, что в канонической PLANS.
    expect(ru.LITE.summary).toBe(PLANS.LITE.summary);
    // незнакомая локаль в рантайме (обход типов) — русский текст, не падение.
    expect(plansFor('xx' as never).LITE.summary).toBe(PLANS.LITE.summary);
  });
});

describe('какой формат кадра будет отрендерен (Б-2.4)', () => {
  it('выбранный явно формат сверх режима — отказ, а не тихая подмена', () => {
    // Осознанное действие: человек выбрал 1:1 и должен узнать, что этот
    // формат в его режиме закрыт. Подменить молча — значит отдать не то,
    // что заказано, и не сказать об этом.
    const r = resolveTargetAspectRatio('LITE', '1:1', '9:16');
    expect(r.denied).toBe('1:1');
    // `target` при этом всё равно разрешённый: вызывающий обязан
    // смотреть на `denied`, но если однажды забудет — отрендерится
    // доступный формат, а не закрытый.
    expect(r.target).toBe('9:16');
  });

  it('приведение проверяется по списку режима, а не «нативный доступен всем»', () => {
    // Списки форматов — данные, а не константа: режим «только
    // вертикаль» вполне возможен, и тогда ландшафтный референс нельзя
    // приводить к 16:9. Проверяем на выдуманном режиме через тот же
    // канонический справочник.
    const vertical = { ...PLANS.LITE, aspectRatios: ['9:16'] };
    const original = PLANS.LITE;
    (PLANS as Record<string, typeof original>).LITE = vertical;
    try {
      expect(resolveTargetAspectRatio('LITE', undefined, '4:3').target).toBe(
        '9:16',
      );
    } finally {
      (PLANS as Record<string, typeof original>).LITE = original;
    }
  });

  it('формат из референса, закрытый режимом, приводится к нативному', () => {
    // Человек ничего не выбирал — он загрузил своё видео. Отказывать не
    // за что, но и рендерить в закрытом формате нельзя: до этапа 120
    // Lite получал ролик 4:5 и оплаченную обрезку ffmpeg.
    const r = resolveTargetAspectRatio('LITE', undefined, '4:5');
    expect(r.target).toBe('9:16');
    expect(r.clamped).toBe(true);
    expect(r.denied).toBeNull();
  });

  it('ландшафтный референс приводится к ландшафтному нативному', () => {
    // Приведение не должно разворачивать кадр: 4:3 — это горизонталь.
    expect(resolveTargetAspectRatio('LITE', null, '4:3').target).toBe('16:9');
  });

  it('режим без ограничений оставляет формат референса как есть', () => {
    const r = resolveTargetAspectRatio('PREMIUM', undefined, '4:5');
    expect(r).toEqual({ target: '4:5', denied: null, clamped: false });
  });

  it('нет ни выбора, ни референса — вертикаль (§16)', () => {
    expect(resolveTargetAspectRatio('LITE', null, null).target).toBe('9:16');
  });

  it('мусор вместо формата не проходит за «выбор»', () => {
    // Иначе непарсимая строка притворилась бы явным выбором и получила
    // бы 403 вместо честного разбора референса.
    const r = resolveTargetAspectRatio('LITE', 'широкий', '9:16');
    expect(r.denied).toBeNull();
    expect(r.target).toBe('9:16');
  });

  it('размер в пикселях приводится к формату, а не считается чужим', () => {
    // `normaliseAspectRatio` умеет сводить 1080:1350 к 4:5 — проверка
    // режима обязана смотреть на результат, а не на исходную строку.
    expect(resolveTargetAspectRatio('LITE', '1080:1350', null).denied).toBe(
      '4:5',
    );
  });
});
