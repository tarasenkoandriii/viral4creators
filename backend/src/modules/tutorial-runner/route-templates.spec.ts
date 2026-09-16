import { resolveScenarioRoute } from './route-templates';

describe('resolveScenarioRoute', () => {
  it('маршруты без параметров резолвятся без фикстурного контекста', () => {
    expect(resolveScenarioRoute('generate', {})).toEqual({
      ok: true,
      path: '/generate',
    });
    expect(resolveScenarioRoute('postprod', {})).toEqual({
      ok: true,
      path: '/postprod',
    });
    expect(resolveScenarioRoute('plan', {})).toEqual({
      ok: true,
      path: '/plan',
    });
  });

  it('project — резолвится с projectId из фикстурного контекста', () => {
    expect(resolveScenarioRoute('project', { projectId: 'p1' })).toEqual({
      ok: true,
      path: '/projects/p1',
    });
  });

  it('project — без projectId в контексте отказывает с понятной причиной', () => {
    const result = resolveScenarioRoute('project', {});
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('projectId');
  });

  it('item — требует и projectId, и itemId', () => {
    expect(
      resolveScenarioRoute('item', { projectId: 'p1', itemId: 'i1' }),
    ).toEqual({ ok: true, path: '/projects/p1/items/i1' });
    expect(resolveScenarioRoute('item', { projectId: 'p1' }).ok).toBe(false);
  });

  it('postprod-video — требует sessionId', () => {
    expect(resolveScenarioRoute('postprod-video', { sessionId: 's1' })).toEqual(
      { ok: true, path: '/postprod/s1' },
    );
    expect(resolveScenarioRoute('postprod-video', {}).ok).toBe(false);
  });

  it('manifest — требует manifestId', () => {
    expect(resolveScenarioRoute('manifest', { manifestId: 'm1' })).toEqual({
      ok: true,
      path: '/brand-manifests/m1',
    });
  });

  it('неизвестное (галлюцинированное) имя маршрута — явный отказ, не угадывание', () => {
    const result = resolveScenarioRoute('wizard.generation', {});
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain(
      'неизвестное имя маршрута',
    );
  });

  it('маршруты вложенных прогонов (catalog-batch/ab-test/feed-import) — явно не поддержаны, не молчаливая заглушка', () => {
    for (const route of [
      'catalog-batch-start',
      'catalog-batch',
      'ab-test',
      'feed-import-start',
      'feed-import',
    ]) {
      const result = resolveScenarioRoute(route, {
        projectId: 'p1',
        itemId: 'i1',
        manifestId: 'm1',
        sessionId: 's1',
      });
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain('не поддержан');
    }
  });
});
