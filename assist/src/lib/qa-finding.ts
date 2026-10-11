/** A human observation attached to an immutable manual QA attempt. */
export interface QaFinding {
  category: 'layout' | 'logic' | 'accessibility';
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  confidence: 'confirmed' | 'needs_confirmation';
  url: string;
  context: string;
  steps: string;
  expected: string;
  actual: string;
  impact: string;
  evidence: string;
  deployedSha: string;
}
export const emptyQaFinding = (): QaFinding => ({
  category: 'layout',
  severity: 'P2',
  confidence: 'needs_confirmation',
  url: '',
  context: '',
  steps: '',
  expected: '',
  actual: '',
  impact: '',
  evidence: '',
  deployedSha: '',
});
function safeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    // Query strings, fragments and embedded credentials can leak session data.
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function findingComment(f: QaFinding): string | null {
  if (
    !['layout', 'logic', 'accessibility'].includes(f.category) ||
    !['P0', 'P1', 'P2', 'P3'].includes(f.severity) ||
    !['confirmed', 'needs_confirmation'].includes(f.confidence)
  )
    return null;
  const url = safeUrl(f.url.trim());
  if (
    (f.confidence === 'confirmed' && !f.evidence.trim()) ||
    !url ||
    [f.context, f.steps, f.expected, f.actual, f.impact].some(
      (s) => !s.trim()
    ) ||
    (f.deployedSha.trim() && !/^[a-f0-9]{40}$/i.test(f.deployedSha.trim()))
  )
    return null;
  const text = [
    'QA observation v1 — ручное замечание',
    `Категория: ${f.category}; приоритет: ${f.severity}; подтверждение: ${f.confidence}.`,
    `Страница: ${url}`,
    `Условия (роль, viewport, тема, язык): ${f.context.trim()}`,
    `Шаги воспроизведения: ${f.steps.trim()}`,
    `Ожидаемое поведение / источник правила: ${f.expected.trim()}`,
    `Фактическое поведение: ${f.actual.trim()}`,
    `Влияние на пользователя: ${f.impact.trim()}`,
    `Доказательства (без секретов): ${f.evidence.trim() || 'не приложены'}`,
    `SHA развёрнутого приложения (со слов автора): ${f.deployedSha.trim() || 'не установлен'}`,
    'needs_confirmation означает гипотезу: сначала подтвердить правило и воспроизведение. Приоритет и confirmed указаны автором, а не проверены ИИ. Не считать устранённым без повторной проверки.',
  ].join('\n\n');
  return text.length <= 4000 ? text : null;
}
