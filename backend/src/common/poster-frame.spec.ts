import {
  POSTER_AT_SECOND,
  POSTER_OUTPUT_NAME,
  planPosterFrame,
} from './poster-frame';

describe('planPosterFrame', () => {
  it('берёт один кадр из входа и кладёт его в названный выход', () => {
    const plan = planPosterFrame();
    expect(plan.outputName).toBe(POSTER_OUTPUT_NAME);
    expect(plan.command).toContain('{{video}}');
    expect(plan.command).toContain(`{{${POSTER_OUTPUT_NAME}}}`);
    expect(plan.command).toContain('-frames:v 1');
  });

  it('перематывает ПЕРЕД открытием входа, а не после', () => {
    // `-ss` после `-i` заставил бы ffmpeg декодировать ролик до нужной
    // секунды — вместо мгновенной задачи полная раскрутка файла.
    const plan = planPosterFrame();
    expect(plan.command.indexOf('-ss')).toBeLessThan(
      plan.command.indexOf('-i'),
    );
  });

  it('кадр не нулевой секунды', () => {
    // Первый кадр у видеомоделей часто тёмный — сцена ещё проявляется,
    // и постером он выглядит как сломанная картинка.
    expect(POSTER_AT_SECOND).toBeGreaterThan(0);
    expect(planPosterFrame().command).toContain(`-ss ${POSTER_AT_SECOND}`);
  });

  it('отрицательная секунда не уезжает в команду', () => {
    // `-ss -1` — не отказ, а непредсказуемое поведение ffmpeg.
    expect(planPosterFrame({ atSecond: -5 }).command).toContain('-ss 0');
  });

  it('качество держится в шкале ffmpeg, а не в процентах', () => {
    // `-q:v` — это 2..31, и 95 здесь означало бы «хуже некуда», ровно
    // наоборот к намерению того, кто передал «95 % качества».
    expect(planPosterFrame({ quality: 95 }).command).toContain('-q:v 31');
    expect(planPosterFrame({ quality: 0 }).command).toContain('-q:v 2');
  });

  it('ключи входа и выхода переопределяются', () => {
    const plan = planPosterFrame({ inputKey: 'src', outputName: 'p.jpg' });
    expect(plan.command).toContain('{{src}}');
    expect(plan.command).toContain('{{p.jpg}}');
    expect(plan.outputName).toBe('p.jpg');
  });

  it('масштабирования нет — команда не содержит фильтров', () => {
    // Выражения вроде `scale=min(1280,iw):-2` требуют экранирования
    // запятых, а команда уходит строкой в чужой сервис, разбор которой
    // мы не контролируем. Родное разрешение здесь дешевле риска.
    expect(planPosterFrame().command).not.toContain('-vf');
    expect(planPosterFrame().command).not.toContain('scale=');
  });
});
