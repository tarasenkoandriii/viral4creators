import {
  joinNarrationParts,
  narrationTextForSubject,
  parseTutorialCaptionsSetting,
  parseTutorialMotionSetting,
  parseTutorialPointerSetting,
  parseTutorialVoiceSetting,
  TUTORIAL_CAPTIONS_SETTING_KEY,
  TUTORIAL_MOTION_SETTING_KEY,
  TUTORIAL_POINTER_SETTING_KEY,
  tutorialMotionSettingValue,
  TUTORIAL_VOICE_SETTING_KEY,
} from './tutorial-voice';
import { ASSISTANT_STEPS } from '../assistant/knowledge/generated';

describe('parseTutorialVoiceSetting', () => {
  it('ключ настройки лежит в пространстве postprod, как соседние решения о сборке', () => {
    expect(TUTORIAL_VOICE_SETTING_KEY).toBe('postprod.tutorialVoice');
  });

  it('ничего не задано — выключено', () => {
    // Ночной крон идёт по ВСЕМ сценариям сразу; полный набор стоит
    // ≈$6 синтеза. Включаться это обязано решением человека, а не
    // фактом деплоя.
    expect(parseTutorialVoiceSetting(null)).toEqual({
      enabled: false,
      voiceId: null,
    });
    expect(parseTutorialVoiceSetting('')).toEqual({
      enabled: false,
      voiceId: null,
    });
    expect(parseTutorialVoiceSetting('off')).toEqual({
      enabled: false,
      voiceId: null,
    });
  });

  it('непонятное значение — тоже выключено, а не «включим с голосом по умолчанию»', () => {
    // Опечатка в админке не должна начинать тратить деньги.
    for (const bad of ['ON', 'true', '1', 'enabled', 'on-elevenlabs']) {
      expect(parseTutorialVoiceSetting(bad).enabled).toBe(false);
    }
  });

  it('on — включено с голосом провайдера по умолчанию', () => {
    expect(parseTutorialVoiceSetting('on')).toEqual({
      enabled: true,
      voiceId: null,
    });
    expect(parseTutorialVoiceSetting('  on  ')).toEqual({
      enabled: true,
      voiceId: null,
    });
  });

  it('on:<voiceId> — включено с конкретным голосом', () => {
    expect(parseTutorialVoiceSetting('on:rachel-42')).toEqual({
      enabled: true,
      voiceId: 'rachel-42',
    });
    // Хвост без голоса — не «голос с пустым именем», а голос по
    // умолчанию: пустая строка ушла бы провайдеру как id.
    expect(parseTutorialVoiceSetting('on:')).toEqual({
      enabled: true,
      voiceId: null,
    });
    expect(parseTutorialVoiceSetting('on:   ')).toEqual({
      enabled: true,
      voiceId: null,
    });
  });
});

describe('narrationTextForSubject (вариант А ТЗ)', () => {
  it('текст собирается из заголовка и описания шага обучалки', () => {
    const step = ASSISTANT_STEPS.ru[0];
    const text = narrationTextForSubject('1', 'ru');
    expect(text).toContain(step.title);
    expect(text).toContain(step.text);
    // Заголовок не отбрасывается: `text` в карточке написан как
    // продолжение заголовка, без него дорожка начинается с середины
    // мысли.
    expect(text!.startsWith(step.title)).toBe(true);
  });

  it('переведённые локали берутся из того же словаря, а не переводятся заново', () => {
    for (const locale of ['ru', 'uk', 'en', 'de', 'es']) {
      expect(narrationTextForSubject('2', locale)).toContain(
        ASSISTANT_STEPS[locale][1].title,
      );
    }
  });

  it('subjectKey вне десяти шагов — текста нет, ролик соберётся немым', () => {
    // Свободный ключ воркфлоу (§4.4 ТЗ): человекочитаемого описания
    // для него взять неоткуда, и выдумывать его не надо.
    expect(narrationTextForSubject('0', 'ru')).toBeNull();
    expect(narrationTextForSubject('11', 'ru')).toBeNull();
    expect(narrationTextForSubject('client-site', 'ru')).toBeNull();
    expect(narrationTextForSubject('1.5', 'ru')).toBeNull();
  });

  it('локали нет в словаре — текста нет, а не русский текст под чужим языком', () => {
    // Молча озвучить по-русски ролик, собранный для испанского, хуже
    // немого ролика: немой виден сразу, чужой язык — нет.
    expect(narrationTextForSubject('1', 'fr')).toBeNull();
  });

  it('между заголовком и описанием ставится точка — диктору нужна пауза', () => {
    const text = narrationTextForSubject('1', 'ru')!;
    expect(text).toContain(`${ASSISTANT_STEPS.ru[0].title}.`);
    // И не две точки подряд, если заголовок уже кончался точкой.
    expect(text).not.toMatch(/\.\./);
  });
});

describe('joinNarrationParts', () => {
  it('точка ставится на стыке — диктору нужна пауза', () => {
    expect(joinNarrationParts(['Заведите товар', 'Проект и товар'])).toBe(
      'Заведите товар. Проект и товар',
    );
  });

  it('заголовок уже кончался точкой — второй не ставим', () => {
    expect(joinNarrationParts(['Готово.', 'Дальше'])).toBe('Готово. Дальше');
  });

  it('многоточие ВНУТРИ текста не трогается', () => {
    // Первая редакция схлопывала точки по всей строке и портила бы
    // текст шага при первой же переводческой правке — молча, потому
    // что многоточий в словаре пока нет (находка аудита этапа B).
    expect(joinNarrationParts(['Шаг', 'Ждём… и продолжаем...'])).toBe(
      'Шаг. Ждём… и продолжаем...',
    );
  });
});

describe('parseTutorialCaptionsSetting (этап E)', () => {
  it('ключ лежит там же, где решение об озвучке', () => {
    expect(TUTORIAL_CAPTIONS_SETTING_KEY).toBe('postprod.tutorialCaptions');
  });

  it('ничего не задано — ВКЛЮЧЕНО, и это обратное умолчание озвучки', () => {
    // Озвучка по умолчанию выключена: набор стоит ≈$6. Подписи не
    // стоят вызова провайдера, а без звука ролик смотрят чаще, чем со
    // звуком (§5 ТЗ).
    expect(parseTutorialCaptionsSetting(null)).toBe(true);
  });

  it('выключается ровно строкой off', () => {
    expect(parseTutorialCaptionsSetting('off')).toBe(false);
    expect(parseTutorialCaptionsSetting('  OFF  ')).toBe(false);
  });

  it('непонятное значение НЕ выключает подписи', () => {
    // Правило то же, что у озвучки, — «человек ничего не решил», —
    // но смотрит оно в другую сторону: там мусор не включает трату,
    // здесь не выключает пользу.
    expect(parseTutorialCaptionsSetting('ага')).toBe(true);
    expect(parseTutorialCaptionsSetting('')).toBe(true);
  });
});

describe('parseTutorialMotionSetting (этап G)', () => {
  it('ключ — рядом с остальными решениями о сборке файла', () => {
    expect(TUTORIAL_MOTION_SETTING_KEY).toBe('postprod.tutorialMotion');
  });

  it('ничего не задано — БЕЗ движения: косметику включает тот, кто её видел', () => {
    expect(parseTutorialMotionSetting(null)).toBe('none');
    expect(parseTutorialMotionSetting('')).toBe('none');
  });

  it('грамматика: off / fade / on', () => {
    expect(parseTutorialMotionSetting('off')).toBe('none');
    expect(parseTutorialMotionSetting('fade')).toBe('fade');
    expect(parseTutorialMotionSetting(' ON ')).toBe('fade+zoom');
  });

  it('непонятное значение — без движения, как у озвучки, а не как у подписей', () => {
    // «Не разобрали — человек ничего не решил», а решение меняет и
    // картинку, и время работы внешнего сервиса.
    expect(parseTutorialMotionSetting('zoom')).toBe('none');
    expect(parseTutorialMotionSetting('fade+zoom')).toBe('none');
    expect(parseTutorialMotionSetting('yes')).toBe('none');
  });

  it('запись и разбор — взаимно обратны на всех трёх режимах', () => {
    for (const motion of ['none', 'fade', 'fade+zoom'] as const) {
      expect(
        parseTutorialMotionSetting(tutorialMotionSettingValue(motion)),
      ).toBe(motion);
    }
  });
});

describe('parseTutorialPointerSetting (этап H)', () => {
  it('ключ — рядом с остальными решениями о сборке файла', () => {
    expect(TUTORIAL_POINTER_SETTING_KEY).toBe('postprod.tutorialPointer');
  });

  it('по умолчанию выключен, включается ровно строкой on', () => {
    expect(parseTutorialPointerSetting(null)).toBe(false);
    expect(parseTutorialPointerSetting('off')).toBe(false);
    expect(parseTutorialPointerSetting(' ON ')).toBe(true);
  });

  it('непонятное значение — выключено: человек ничего не решил', () => {
    expect(parseTutorialPointerSetting('yes')).toBe(false);
    expect(parseTutorialPointerSetting('1')).toBe(false);
  });
});
