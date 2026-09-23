import { canEnableAiGuide } from './wizard-guide-access';

describe('когда чекбокс ИИ ещё можно включить (§3.2)', () => {
  it('пустой прогресс — можно', () => {
    expect(canEnableAiGuide({})).toBe(true);
  });

  it('записанный раунд обучалки закрывает включение', () => {
    expect(canEnableAiGuide({ clientSiteFrames: 1 })).toBe(false);
    // Черновик без кадров — это ещё не начатый сценарий: человек ввёл
    // ссылку и может передумать.
    expect(canEnableAiGuide({ clientSiteFrames: 0 })).toBe(true);
  });

  it('созданная сессия закрывает включение', () => {
    expect(canEnableAiGuide({ hasSession: true })).toBe(false);
  });

  it('начатый разбор закрывает включение', () => {
    expect(canEnableAiGuide({ hasAnalysis: true })).toBe(false);
  });

  it('признаки складываются через ИЛИ, а не через И', () => {
    // Иначе «сессии нет, но кадры есть» считалось бы началом пути —
    // то есть включить можно было бы посреди записи.
    expect(canEnableAiGuide({ clientSiteFrames: 3, hasSession: false })).toBe(
      false,
    );
  });
});
