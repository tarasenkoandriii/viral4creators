import { knownQaHook, qaSelector, QA_HOOKS } from './qa-hooks';
import { ROUTE_DESCRIPTIONS } from '../tutorial-runner/route-templates';

describe('QA_HOOKS', () => {
  it('каждый хук живёт на маршруте, который предлагается модели', () => {
    for (const [key, hook] of Object.entries(QA_HOOKS)) {
      expect({ key, known: hook.route in ROUTE_DESCRIPTIONS }).toEqual({
        key,
        known: true,
      });
    }
  });

  it('ключи в форме, которую понимает knownQaHook, и описаны', () => {
    for (const [key, hook] of Object.entries(QA_HOOKS)) {
      expect(knownQaHook(qaSelector(key))).toBe(key);
      expect(hook.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('knownQaHook', () => {
  it('принимает только [data-qa="ключ"] из каталога', () => {
    expect(knownQaHook('[data-qa="prompt-approve"]')).toBe('prompt-approve');
    expect(knownQaHook('  [data-qa="prompt-approve"]  ')).toBe(
      'prompt-approve',
    );
    expect(knownQaHook('[data-qa="no-such"]')).toBeNull();
    expect(knownQaHook("[data-qa='prompt-approve']")).toBeNull();
    expect(knownQaHook('[data-qa="prompt-approve"] span')).toBeNull();
    expect(knownQaHook('#promptText')).toBeNull();
    // Ключ-свойство объекта не должно считаться хуком.
    expect(knownQaHook('[data-qa="constructor"]')).toBeNull();
  });
});
