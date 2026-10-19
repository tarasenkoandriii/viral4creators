import { planStoryReferenceProduction } from './story-reference-plan';
import { STORY_EDITIONS } from './story-editions';
import { storyAudioReservation } from './story-budget';
import { storyVideoReserve } from './story-video-plan';
import { storyText } from './story-catalog';
import type { StoryReferenceAssessment } from './story-references.service';
import * as videoBase from './story-video-base';

const assessment = (
  scenes: StoryReferenceAssessment['scenes'],
  extra: Partial<StoryReferenceAssessment> = {},
): StoryReferenceAssessment => ({
  observed: true,
  audioObserved: true,
  summary: 'Сказка',
  scenes,
  pacing: '',
  narration: '',
  visuals: '',
  music: '',
  ownProductionPlan: '',
  limitations: '',
  ...extra,
});
const edition = (id: string) => STORY_EDITIONS.find((e) => e.id === id)!;
const scenes: StoryReferenceAssessment['scenes'] = [
  { start: 40, end: 120, observation: 'Середина', confidence: 'high' },
  { start: 0, end: 40, observation: 'Вступление', confidence: 'medium' },
  { start: 120, end: 200, observation: 'Финал', confidence: 'high' },
];

describe('Own staging plan from reference timecodes (§23.5 output)', () => {
  it('maps reference scenes onto our edition timeline after the preamble', () => {
    const plan = planStoryReferenceProduction({
      reference: {
        id: 'Q1hbf5TrWCM',
        durationSeconds: 200,
        assessment: assessment(scenes),
      },
      edition: edition('turnip-ushinsky-ru-1949-v1'),
      budgetUsd: 5,
      // 28 chars at the shared 14 chars/s (STORY_SPEECH_CHARS_PER_SECOND).
      preambleText: 'x'.repeat(28),
    });
    expect(plan.introSeconds).toBe(2);
    expect(plan.narrationSeconds).toBe(65);
    expect(plan.scenes[0]).toMatchObject({
      kind: 'preamble',
      start: 0,
      end: 2,
    });
    const story = plan.scenes.slice(1);
    expect(story.map((s) => s.staging)).toEqual([
      'Вступление',
      'Середина',
      'Финал',
    ]);
    expect(story[0]).toMatchObject({ start: 2, end: 15, chapterIndex: 0 });
    expect(story[2]).toMatchObject({ start: 41, end: 67, chapterIndex: 2 });
    expect(story[1].reference).toEqual({
      start: 40,
      end: 120,
      confidence: 'high',
    });
    for (const s of plan.scenes) expect(s.end).toBeGreaterThan(s.start);
    expect(plan.baseRevision).toBe('turnip-v1');
    expect(plan.textSha256).toBe(
      edition('turnip-ushinsky-ru-1949-v1').textSha256,
    );
  });

  it('prices with the existing reserves and never exceeds the budget silently', () => {
    const turnip = edition('turnip-ushinsky-ru-1949-v1');
    const input = {
      reference: {
        id: 'Q1hbf5TrWCM',
        durationSeconds: 200,
        assessment: assessment(scenes),
      },
      edition: turnip,
    };
    const plan = planStoryReferenceProduction({ ...input, budgetUsd: 5 });
    const narration = storyAudioReservation(storyText(turnip.id));
    const assembly = storyVideoReserve('x'.repeat(180));
    expect(plan.lines.map((l) => [l.key, l.microUsd])).toEqual([
      ['narration', narration],
      ['assembly', assembly],
      ['illustrations', 0],
      ['animation', 0],
    ]);
    expect(plan.totalMicroUsd).toBe(narration + assembly);
    expect(plan.totalUsd).toBe(
      Math.ceil((narration + assembly) / 10_000) / 100,
    );
    expect(plan.fits).toBe(true);
    expect(plan.warnings.join(' ')).not.toContain('Превышение');
    // A long edition whose reserve exceeds $1 is refused as «не помещается».
    const long = {
      ...turnip,
      id: 'long-test-v1',
      chapters: [
        { title: 'Длинно', scene: 'forest', text: 'а'.repeat(40_000) },
      ],
    };
    const tight = planStoryReferenceProduction({
      ...input,
      edition: long,
      budgetUsd: 1,
    });
    expect(tight.totalMicroUsd).toBeGreaterThan(1_000_000);
    expect(tight.fits).toBe(false);
    expect(tight.warnings.join(' ')).toContain('Превышение не допускается');
  });

  it('flags uncertain input, adaptations and editions without a video master', () => {
    const plan = planStoryReferenceProduction({
      reference: {
        id: 'Q1hbf5TrWCM',
        durationSeconds: 60,
        assessment: assessment(
          [{ start: 0, end: 30, observation: 'Кадр', confidence: 'low' }],
          { audioObserved: false, timelineWarnings: 'пересекаются' },
        ),
      },
      edition: edition('mitten-uk-short-v1'),
      budgetUsd: 3,
    });
    const text = plan.warnings.join(' ');
    expect(text).toContain('низкой уверенностью');
    expect(text).toContain('Звук референса не подтверждён');
    expect(text).toContain('Разбор частичный');
    expect(text).toContain('нет базового видеоряда');
    expect(text).toContain('адаптация');
    expect(plan.baseRevision).toBeNull();
    expect(plan.editionKind).toBe('adaptation');
  });

  it('refuses unobserved references and invalid budgets', () => {
    const base = {
      reference: {
        id: 'Q1hbf5TrWCM',
        durationSeconds: 60,
        assessment: assessment([], { observed: false }),
      },
      edition: edition('turnip-ushinsky-ru-1949-v1'),
      budgetUsd: 5,
    };
    expect(() => planStoryReferenceProduction(base)).toThrow('no observed');
    const ok = { ...base.reference, assessment: assessment(scenes) };
    expect(() =>
      planStoryReferenceProduction({ ...base, reference: ok, budgetUsd: 0 }),
    ).toThrow('budget');
    expect(() =>
      planStoryReferenceProduction({
        ...base,
        reference: ok,
        preambleText: 'x'.repeat(181),
      }),
    ).toThrow('Preamble');
  });

  it('takes the base package from the per-edition registry, not the pilot constant', () => {
    const input = {
      reference: {
        id: 'Q1hbf5TrWCM',
        durationSeconds: 200,
        assessment: assessment(scenes),
      },
      budgetUsd: 5,
    };
    const mitten = edition('mitten-uk-short-v1');
    const spy = jest
      .spyOn(videoBase, 'storyVideoBaseFor')
      .mockImplementation((id: string) =>
        id === mitten.id
          ? {
              ...videoBase.STORY_VIDEO_BASE,
              revision: 'mitten-uk-v1',
              catalogId: mitten.id,
              locale: 'uk',
              textSha256: mitten.textSha256,
            }
          : null,
      );
    try {
      const withBase = planStoryReferenceProduction({
        ...input,
        edition: mitten,
      });
      expect(spy).toHaveBeenCalledWith(mitten.id);
      expect(withBase.baseRevision).toBe('mitten-uk-v1');
      expect(withBase.warnings.join(' ')).not.toContain('базового видеоряда');
      expect(
        withBase.lines.find((l) => l.key === 'illustrations')!.note,
      ).toContain('mitten-uk-v1');
      // The pilot turnip package is no longer assumed for its edition.
      const turnip = planStoryReferenceProduction({
        ...input,
        edition: edition('turnip-ushinsky-ru-1949-v1'),
      });
      expect(turnip.baseRevision).toBeNull();
      expect(turnip.warnings.join(' ')).toContain('план без базового видео');
    } finally {
      spy.mockRestore();
    }
    // A package bound to another text version of the edition is not used.
    const turnip = edition('turnip-ushinsky-ru-1949-v1');
    const changed = planStoryReferenceProduction({
      ...input,
      edition: { ...turnip, textSha256: 'f'.repeat(64) },
    });
    expect(changed.baseRevision).toBeNull();
    expect(changed.warnings.join(' ')).toContain('другой версии текста');
  });
});
