import {
  cropBox,
  cropExpression,
  planBatchReframe,
  planReframe,
  ReframeError,
} from './reframe';

describe('reframe (ТЗ §16.1)', () => {
  it('родные форматы обрезать нечего — задача не создаётся', () => {
    // Отправить такую задачу значит заплатить за перекодирование ради
    // того же кадра.
    for (const native of ['16:9', '9:16']) {
      expect(() => planReframe({ targetAspectRatio: native })).toThrow(
        ReframeError,
      );
    }
  });

  it('мусор вместо формата отвергается до отправки', () => {
    for (const bad of ['', '  ', '16-9', 'широкий', '16:', ':9', '0:0']) {
      expect(() => planReframe({ targetAspectRatio: bad })).toThrow(
        ReframeError,
      );
    }
  });

  it('команда содержит вход, обрезку и выход', () => {
    const plan = planReframe({ targetAspectRatio: '4:5' });
    expect(plan.command).toContain('-i {{source}}');
    expect(plan.command).toContain('crop=');
    expect(plan.command).toContain('{{reframed.mp4}}');
    expect(plan.outputName).toBe('reframed.mp4');
    expect(plan.ratio).toBeCloseTo(0.8, 6);
  });

  it('звук не пересжимается', () => {
    // Veo уже отдал AAC; второе сжатие только ухудшило бы его.
    expect(planReframe({ targetAspectRatio: '1:1' }).command).toContain(
      '-c:a copy',
    );
  });

  it('индекс двигается в начало файла', () => {
    // Без +faststart ролик в браузере начинает играть только после
    // полной загрузки.
    expect(planReframe({ targetAspectRatio: '1:1' }).command).toContain(
      '+faststart',
    );
  });

  it('выражение обрезки центрирует и приводит к чётным размерам', () => {
    const expr = cropExpression(0.8);
    expect(expr).toContain('floor(');
    expect(expr).toContain('/2)*2');
    expect(expr).toContain('(iw-out_w)/2');
    expect(expr).toContain('(ih-out_h)/2');
  });

  describe('cropBox — то же правило, но проверяемое числами', () => {
    it('вертикальный формат из горизонтального кадра режет по ширине', () => {
      // 1920×1080 → 9:16 не бывает (это уже родной), берём 4:5 из 16:9:
      // высота вся, ширина = 1080 × 0.8.
      expect(cropBox(1920, 1080, 0.8)).toEqual({ width: 864, height: 1080 });
    });

    it('горизонтальный формат из вертикального кадра режет по высоте', () => {
      // 1080×1920 → 4:5: ширина вся, высота = 1080 / 0.8 = 1350.
      expect(cropBox(1080, 1920, 0.8)).toEqual({ width: 1080, height: 1350 });
    });

    it('квадрат из любого кадра — меньшая сторона', () => {
      expect(cropBox(1920, 1080, 1)).toEqual({ width: 1080, height: 1080 });
      expect(cropBox(1080, 1920, 1)).toEqual({ width: 1080, height: 1080 });
    });

    it('обрезка никогда не увеличивает кадр', () => {
      // Апскейл не добавляет резкости, зато растит вес и время рендера.
      for (const [w, h] of [
        [1920, 1080],
        [1280, 720],
        [1080, 1920],
        [720, 1280],
      ]) {
        for (const r of [0.8, 1, 0.75, 2.35]) {
          const box = cropBox(w, h, r);
          expect(box.width).toBeLessThanOrEqual(w);
          expect(box.height).toBeLessThanOrEqual(h);
        }
      }
    });

    it('размеры всегда чётные — libx264 с yuv420p нечётные не берёт', () => {
      for (const [w, h] of [
        [1281, 721],
        [1919, 1079],
        [999, 555],
      ]) {
        for (const r of [0.8, 1, 1.777777, 0.5625]) {
          const box = cropBox(w, h, r);
          expect(box.width % 2).toBe(0);
          expect(box.height % 2).toBe(0);
        }
      }
    });

    it('полученный прямоугольник держит целевой формат', () => {
      for (const [w, h] of [
        [1920, 1080],
        [1080, 1920],
      ]) {
        for (const r of [0.8, 1, 0.75]) {
          const box = cropBox(w, h, r);
          // Допуск в один пиксель — плата за округление до чётного.
          expect(Math.abs(box.width / box.height - r)).toBeLessThan(0.01);
        }
      }
    });
  });

  describe('planBatchReframe (этап 75, автоэкспорт — ярус A)', () => {
    it('несколько форматов — одна команда на каждый, разные outputName', () => {
      const items = planBatchReframe(['4:5', '1:1', '4:3']);
      expect(items).toHaveLength(3);
      const names = items.map((i) => i.outputName);
      expect(new Set(names).size).toBe(3); // все имена разные
      for (const item of items) {
        expect(item.command).toContain('crop=');
      }
    });

    it('пустой список — пустой результат, без ошибки', () => {
      expect(planBatchReframe([])).toEqual([]);
    });

    it('родной формат (нечего резать) молча пропускается, не бросает', () => {
      const items = planBatchReframe(['9:16', '4:5', '16:9']);
      expect(items.map((i) => i.target)).toEqual(['4:5']);
    });

    it('дубликаты во входном списке схлопываются в один', () => {
      const items = planBatchReframe(['4:5', '4:5', ' 4:5 ']);
      expect(items).toHaveLength(1);
      expect(items[0].target).toBe('4:5');
    });

    it('мусорный формат в списке молча пропускается вместе с остальными невалидными', () => {
      // planBatchReframe не должен бросать на одном плохом элементе —
      // вызывающий (`PostProductionService.startExport`) сам решает,
      // что делать с форматами, которые не резолвились ни в один вариант.
      const items = planBatchReframe(['4:5', 'мусор', '', '1:1']);
      expect(items.map((i) => i.target)).toEqual(['4:5', '1:1']);
    });
  });
});
