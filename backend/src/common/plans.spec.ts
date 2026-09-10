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

  it('avatarLipsync (пилот, этап 72) — выключен на всех трёх тарифах, не только LITE', () => {
    // doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §4.1: признак существует, но
    // умышленно не дан НИ ОДНОМУ тарифу — доступ только оператору
    // напрямую через ActorsController, минуя эту матрицу вовсе.
    for (const plan of PLAN_IDS) {
      expect(planAllows(plan, 'avatarLipsync')).toBe(false);
    }
    // Ни один план не даёт признак — по определению `minimalPlanFor`
    // откатывается на самый старший ('PREMIUM'), а не молча ломается.
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
