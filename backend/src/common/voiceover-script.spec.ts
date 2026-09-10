import {
  cueTimings,
  dialogueFromPrompt,
  estimateSpeechSeconds,
  firstCueSeconds,
  heuristicCueTimings,
  parsePromptResponse,
  speakableText,
} from './voiceover-script';

describe('voiceover-script (ТЗ §15.2)', () => {
  describe('разбор ответа модели', () => {
    it('обычный случай: объект с двумя ключами', () => {
      const r = parsePromptResponse(
        JSON.stringify({
          prompt: '8 seconds; UGC.',
          voiceoverScript: 'Привет.',
        }),
      );
      expect(r).toEqual({
        prompt: '8 seconds; UGC.',
        script: 'Привет.',
        source: 'field',
      });
    });

    it('объект в блоке кода — тоже объект', () => {
      const r = parsePromptResponse(
        'Вот результат:\n```json\n{"prompt":"p","voiceoverScript":"s"}\n```',
      );
      expect(r.prompt).toBe('p');
      expect(r.script).toBe('s');
    });

    it('не-JSON ответ остаётся промптом целиком', () => {
      // Промпт — то, что уходит в Veo; менять его ради новой функции
      // значило бы подменить предмет.
      const raw = '8 seconds; UGC smartphone realism. Camera: static.';
      expect(parsePromptResponse(raw)).toEqual({
        prompt: raw,
        script: null,
        source: 'none',
      });
    });

    it('без ключа реплики берутся из самого промпта', () => {
      // Ступень для промптов, сгенерированных до этапа 35: они уже лежат
      // в сессиях, и озвучка должна работать и для них.
      const r = parsePromptResponse(
        JSON.stringify({
          prompt:
            '8 seconds; UGC.\nDialogue (timed to scenes):\n- Scene 1 (0:00–0:01.5, female VO): "Это работает."\n- Scene 2 (0:01.5–0:03.5, male): "Берите сейчас."\nEnd with: CTA overlay.',
        }),
      );
      expect(r.source).toBe('dialogue');
      expect(r.script).toContain('Это работает');
      expect(r.script).not.toContain('CTA overlay');
    });

    it('пустая строка не роняет разбор', () => {
      expect(parsePromptResponse('')).toMatchObject({ script: null });
    });
  });

  describe('реплики из промпта', () => {
    it('однострочный формат тоже читается', () => {
      const text =
        'Colors: warm. Dialogue: "Мы сделали это за неделю." End with: CTA.';
      expect(dialogueFromPrompt(text)).toBe('"Мы сделали это за неделю."');
    });

    it('раздел заканчивается на следующем разделе, а не на конце текста', () => {
      const text =
        'Dialogue:\n- "Первая."\n- "Вторая."\nVisual direction by scene:\n- Scene 1: кухня.';
      const d = dialogueFromPrompt(text)!;
      expect(d).toContain('Вторая');
      expect(d).not.toContain('кухня');
    });

    it('нет реплик — нет и выдумки', () => {
      expect(dialogueFromPrompt('8 seconds; static camera.')).toBeNull();
    });
  });

  describe('текст для синтезатора', () => {
    it('пометки о сценах и таймингах не читаются вслух', () => {
      // Синтезатор прочитает всё, что ему дадут, включая «Scene 2».
      const s = speakableText(
        'Dialogue (timed to scenes):\n' +
          '- Scene 1 (0:00–0:01.5, female VO over unboxing): "Это работает."\n' +
          '- Scene 2 (0:01.5–0:03.5, male on-camera): "Берите сейчас."',
      );
      expect(s).toBe('Это работает.\nБерите сейчас.');
    });

    it('кавычки вокруг реплики снимаются', () => {
      expect(speakableText('«Привет, мир»')).toBe('Привет, мир');
    });

    it('русская разметка тоже узнаётся', () => {
      expect(speakableText('Сцена 1: Привет.\nГолос: Пока.')).toBe(
        'Привет.\nПока.',
      );
    });

    it('пустой вход даёт пустой выход, а не «undefined»', () => {
      expect(speakableText(null)).toBe('');
      expect(speakableText('   ')).toBe('');
    });

    it('обычный текст без разметки не портится', () => {
      const plain = 'Первое предложение.\nВторое предложение.';
      expect(speakableText(plain)).toBe(plain);
    });
  });

  describe('начало речи по таймкоду (§15.4, этап 36)', () => {
    it('сдвиг берётся из первой реплики, а не из заголовка', () => {
      // «Dialogue (timed to scenes):» тоже со скобками — считать его за
      // реплику значило бы сдвинуть голос в никуда.
      expect(
        firstCueSeconds(
          'Dialogue (timed to scenes):\n' +
            '- Scene 2 (0:01.5–0:03.5, female VO): "Это работает."',
        ),
      ).toBe(1.5);
    });

    it('реплика с нулевой секунды — нулевой сдвиг', () => {
      expect(firstCueSeconds('- Scene 1 (0:00–0:01.5): "Это работает."')).toBe(
        0,
      );
    });

    it('текст без таймкодов сдвига не даёт', () => {
      // Пользователь, переписавший реплики своими словами, ничего про
      // тайминг не сказал — выдумывать за него нечего.
      expect(firstCueSeconds('Это работает.\nБерите сейчас.')).toBe(0);
      expect(firstCueSeconds(null)).toBe(0);
      expect(firstCueSeconds('   ')).toBe(0);
    });

    it('таймкод за пределами ролика игнорируется', () => {
      // «1:05» вместо «0:01.05» — обычная описка модели. Сдвинуть на
      // 65 секунд значит выдать немую восьмисекундную дорожку.
      expect(firstCueSeconds('- (1:05): "Через минуту."')).toBe(0);
      expect(firstCueSeconds('- (99:00): "Поздно."')).toBe(0);
    });

    it('дробные доли секунды сохраняются', () => {
      expect(firstCueSeconds('- (0:02.4): "Сейчас."')).toBe(2.4);
    });
  });

  describe('оценка длительности', () => {
    it('пустой текст — ноль секунд', () => {
      expect(estimateSpeechSeconds('')).toBe(0);
    });

    it('текст на восьмисекундный ролик укладывается в его длину', () => {
      const s = estimateSpeechSeconds(
        'Это средство убрало пятна за один заход. Берите сейчас.',
      );
      expect(s).toBeGreaterThan(2);
      expect(s).toBeLessThan(8);
    });

    it('разметка в оценку не попадает', () => {
      const withNoise = estimateSpeechSeconds(
        '- Scene 1 (0:00–0:01.5, female VO over unboxing): "Коротко."',
      );
      expect(withNoise).toBe(estimateSpeechSeconds('Коротко.'));
    });
  });

  describe('тайминг субтитров: реальное выравнивание (этап 67)', () => {
    // Синтетический alignment: посимвольно по 0.1с, как если бы
    // ElevenLabs отдал «Привет. Пока.» ровно тем же текстом, что и
    // реплики — самый частый случай, без нормализации.
    function evenAlignment(text: string, step = 0.1) {
      const characters = [...text];
      const starts = characters.map((_, i) => Math.round(i * step * 10) / 10);
      const ends = starts.map((s) => Math.round((s + step) * 10) / 10);
      return { characters, starts, ends };
    }

    it('дословное совпадение — тайминг берётся из якорей без интерполяции', () => {
      const alignment = evenAlignment('привет. пока.');
      const cues = cueTimings('Привет.\nПока.', alignment);
      expect(cues).toEqual([
        { startSeconds: 0, endSeconds: 0.8, text: 'Привет.' },
        { startSeconds: 0.8, endSeconds: 1.3, text: 'Пока.' },
      ]);
    });

    it('не найденная подстрокой реплика получает интерполированный тайминг', () => {
      // Имитация нормализации ElevenLabs: реплика «two» в озвучке звучит
      // иначе и не находится дословно — тайминг для неё интерполируется
      // между соседними найденными репликами, а не выбрасывается.
      const alignment = evenAlignment('one xxxxx three');
      const cues = cueTimings('one\ntwo\nthree', alignment);
      expect(cues).toHaveLength(3);
      expect(cues[0]).toEqual({
        startSeconds: 0,
        endSeconds: 0.5,
        text: 'one',
      });
      // Между «one» (конец 0.5) и «three» (начало 1.0) — где-то посередине.
      expect(cues[1].startSeconds).toBeGreaterThan(cues[0].startSeconds);
      expect(cues[1].startSeconds).toBeLessThan(1.0);
      expect(cues[1].text).toBe('two');
      expect(cues[2]).toEqual({
        startSeconds: 1.0,
        endSeconds: 1.5,
        text: 'three',
      });
    });

    it('ни одна реплика не нашлась — равномерная сетка, а не пустой список', () => {
      const alignment = evenAlignment('совершенно другой текст целиком');
      const cues = cueTimings('Первая.\nВторая.', alignment);
      expect(cues).toHaveLength(2);
      expect(cues[0].startSeconds).toBe(0);
      expect(cues[1].startSeconds).toBeGreaterThan(cues[0].startSeconds);
    });

    it('нет реплик или пустое выравнивание — пустой список, не ошибка', () => {
      expect(cueTimings(null, evenAlignment('текст'))).toEqual([]);
      expect(
        cueTimings('Реплика.', { characters: [], starts: [], ends: [] }),
      ).toEqual([]);
    });

    it('последняя реплика тянется до конца озвучки', () => {
      const alignment = evenAlignment('привет. пока.');
      const cues = cueTimings('Привет.\nПока.', alignment);
      expect(cues[cues.length - 1].endSeconds).toBe(
        alignment.ends[alignment.ends.length - 1],
      );
    });
  });

  describe('тайминг субтитров: эвристика для veo (этап 67)', () => {
    it('реплики делят диапазон пропорционально длине в символах', () => {
      // «abcd» вдвое длиннее «ab» — и должна занять примерно вдвое
      // больше времени из общего диапазона.
      const cues = heuristicCueTimings('ab\nabcd', 0, 8);
      expect(cues).toHaveLength(2);
      const firstSpan = cues[0].endSeconds - cues[0].startSeconds;
      const secondSpan = cues[1].endSeconds - cues[1].startSeconds;
      expect(secondSpan).toBeGreaterThan(firstSpan);
      expect(cues[0].startSeconds).toBe(0);
    });

    it('последняя реплика заканчивается ровно на границе ролика', () => {
      // Не «почти» — иначе субтитр последней реплики обрывается
      // раньше конца видео или продолжается по чёрному кадру.
      const cues = heuristicCueTimings('Первая.\nВторая.\nТретья.', 0.5, 8);
      expect(cues[cues.length - 1].endSeconds).toBe(8);
    });

    it('диапазон начинается со сдвига первой реплики, как и у синтеза', () => {
      // Тот же приём, что даёт voiceDelayMs для voiceover/dub (§15.4) —
      // здесь секунда первой реплики просто не совпадает с нулём ролика.
      const cues = heuristicCueTimings('Одна реплика.', 1.5, 8);
      expect(cues[0].startSeconds).toBe(1.5);
    });

    it('одна реплика занимает весь диапазон целиком', () => {
      const cues = heuristicCueTimings('Единственная.', 0, 8);
      expect(cues).toEqual([
        { startSeconds: 0, endSeconds: 8, text: 'Единственная.' },
      ]);
    });

    it('пустой текст — пустой список, не ошибка', () => {
      expect(heuristicCueTimings(null, 0, 8)).toEqual([]);
      expect(heuristicCueTimings('   ', 0, 8)).toEqual([]);
    });

    it('разметка в реплики не попадает — тот же текст, что уходит в синтез', () => {
      const cues = heuristicCueTimings(
        '- Scene 1 (0:00–0:01.5, female VO): "Коротко."',
        0,
        8,
      );
      expect(cues[0].text).toBe('Коротко.');
    });
  });
});
