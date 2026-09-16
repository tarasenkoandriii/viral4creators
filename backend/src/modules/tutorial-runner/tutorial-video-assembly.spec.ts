import {
  planSlideshow,
  SECONDS_PER_FRAME,
  MAX_SLIDESHOW_FRAMES,
} from './tutorial-video-assembly';

describe('planSlideshow', () => {
  it('null для пустого списка кадров', () => {
    expect(planSlideshow([])).toBeNull();
  });

  it('null, если кадров больше потолка', () => {
    const urls = Array.from(
      { length: MAX_SLIDESHOW_FRAMES + 1 },
      (_, i) => `https://blob.example.com/frame-${i}.jpg`,
    );
    expect(planSlideshow(urls)).toBeNull();
  });

  it('один кадр — валидная команда с одним входом', () => {
    const plan = planSlideshow(['https://blob.example.com/frame-0.jpg']);
    expect(plan).not.toBeNull();
    expect(plan!.inputs).toEqual({
      frame0: 'https://blob.example.com/frame-0.jpg',
    });
    expect(plan!.outputs).toEqual(['tutorial.mp4']);
    expect(plan!.outputName).toBe('tutorial.mp4');
    expect(plan!.commands).toHaveLength(1);
    expect(plan!.commands[0]).toContain('{{frame0}}');
    expect(plan!.commands[0]).toContain(`-t ${SECONDS_PER_FRAME}`);
    expect(plan!.commands[0]).toContain('concat=n=1:v=1:a=0');
  });

  it('несколько кадров — по одному входу на кадр, все участвуют в concat', () => {
    const urls = [
      'https://blob.example.com/frame-0.jpg',
      'https://blob.example.com/frame-1.jpg',
      'https://blob.example.com/frame-2.jpg',
    ];
    const plan = planSlideshow(urls);
    expect(plan).not.toBeNull();
    expect(Object.keys(plan!.inputs)).toEqual(['frame0', 'frame1', 'frame2']);
    expect(plan!.commands[0]).toContain('concat=n=3:v=1:a=0');
    expect(plan!.commands[0]).toContain('[v0]');
    expect(plan!.commands[0]).toContain('[v1]');
    expect(plan!.commands[0]).toContain('[v2]');
  });

  it('чётные размеры кадра гарантированы (scale=trunc(.../2)*2) на каждом входе', () => {
    const plan = planSlideshow([
      'https://blob.example.com/frame-0.jpg',
      'https://blob.example.com/frame-1.jpg',
    ]);
    const scaleCount = (plan!.commands[0].match(/scale=trunc/g) ?? []).length;
    expect(scaleCount).toBe(2);
  });

  it('своё имя выходного файла пробрасывается в outputs/outputName/команду', () => {
    const plan = planSlideshow(
      ['https://blob.example.com/frame-0.jpg'],
      'custom-name.mp4',
    );
    expect(plan!.outputs).toEqual(['custom-name.mp4']);
    expect(plan!.outputName).toBe('custom-name.mp4');
    expect(plan!.commands[0]).toContain('custom-name.mp4');
  });
});
