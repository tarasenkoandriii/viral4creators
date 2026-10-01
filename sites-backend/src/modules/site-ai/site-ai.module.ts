/**
 * Модуль `site-ai` — нейтральный (правило графа core-neutral): клиенты
 * Gemini, учёт расходов в site_ai_usage, бюджет обучения. Общий для
 * режимов и для QA. Владельцы файлов: K2 (embedder, usage-recorder,
 * learning-budget), K3 (text-model).
 */
import { Module } from '@nestjs/common';
import { GeminiEmbedder } from './embedder';
import { LearningBudget } from './learning-budget';
import { GeminiText } from './text-model';
import { AiUsageRecorder } from './usage-recorder';

@Module({
  providers: [GeminiEmbedder, GeminiText, AiUsageRecorder, LearningBudget],
  exports: [GeminiEmbedder, GeminiText, AiUsageRecorder, LearningBudget],
})
export class SiteAiModule {}
