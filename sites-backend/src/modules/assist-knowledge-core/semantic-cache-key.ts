/**
 * Ключ семантического кэша/контекстного кэша (§4.5, §4-тер.2):
 * siteId + режим + knowledgeVersion + configVersion + нормализованный
 * вопрос. Смена версии = другой ключ = старый кэш недействителен (приёмка
 * §4-тер.15 п.5). Сам кэш — Э2; ключ — здесь, чтобы Э2 не придумал свой. K2.
 *
 * Вопрос — нормализованный ТЕКСТ (а не эмбеддинг, §4-тер.7: эмбеддинг
 * «похожего» вопроса с инъекцией попал бы в чужой ключ): NFKC, нижний
 * регистр, пробелы, концевые знаки. В ключе — его SHA-256 (вопрос
 * посетителя в имени ключа хранилища не нужен).
 */
import { createHash } from 'crypto';
import type { KnowledgeMode } from './tables';

export function normalizeQuestion(q: string): string {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s ]+/gu, ' ')
    .replace(/[\s.!?…,;:]+$/u, '')
    .trim();
}

export function semanticCacheKey(p: {
  siteId: string;
  mode: KnowledgeMode;
  knowledgeVersion: number;
  configVersion: number;
  question: string;
}): string {
  for (const n of [p.knowledgeVersion, p.configVersion]) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('semanticCacheKey: версия — неотрицательное целое');
    }
  }
  if (!p.siteId) throw new Error('semanticCacheKey: пустой siteId');
  const q = createHash('sha256')
    .update(normalizeQuestion(p.question), 'utf8')
    .digest('hex');
  return `sc1:${p.mode}:${p.siteId}:k${p.knowledgeVersion}:c${p.configVersion}:${q}`;
}
