/** A bounded editorial draft, tied to the original input and reviewed output.
 * No URLs, shell, render, paid call or media approval is produced here.
 */
import { createHash } from 'node:crypto';
import { PostProdOptions, planPostProduction } from './postprod';
import { screenPostprodSuggestions } from './postprod-review-suggestions';

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA = /^[a-f0-9]{64}$/;

export function compileFfmpegReviewDraft(
  jobId: string,
  file: string,
  document: unknown,
  job: unknown,
  now = Date.now(),
) {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  if (
    !object(document) ||
    Buffer.byteLength(JSON.stringify(document), 'utf8') > 32_768
  )
    return fail('Некорректный документ проверки (не более 32 КиБ)');
  const fields = new Set([
    'sourceInputKey',
    'sourceSha256',
    'outputSha256',
    'recipe',
    'suggestions',
    'selectedParameters',
  ]);
  if (Object.keys(document).some((key) => !fields.has(key)))
    return fail('В документе есть неподдерживаемые поля');
  if (
    !object(job) ||
    job.execution_status !== 'succeeded' ||
    job.purged_at ||
    job.purge_requested_at ||
    typeof job.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(job.expires_at)) ||
    Date.parse(job.expires_at) <= now
  )
    return fail('Результат задачи недоступен или устарел');
  const artifacts = Array.isArray(job.artifacts)
    ? job.artifacts.filter(object)
    : [];
  const output = artifacts.find((entry) => entry.name === file);
  const inputs = Array.isArray(job.inputs_metadata)
    ? job.inputs_metadata.filter(object)
    : [];
  const source = inputs.find((entry) => entry.key === document.sourceInputKey);
  if (
    !source ||
    !output ||
    output.purged_at ||
    output.mime !== 'video/mp4' ||
    typeof source.mime !== 'string' ||
    !source.mime.startsWith('video/') ||
    inputs.filter((entry) => entry.key === document.sourceInputKey).length !==
      1 ||
    artifacts.filter((entry) => entry.name === file).length !== 1 ||
    !Array.isArray(source.streams) ||
    !source.streams.some((stream) => object(stream) && stream.type === 'video')
  )
    return fail('Нужны сохранённый исходник в метаданных и результат MP4');
  for (const [expected, actual] of [
    [document.sourceSha256, source.sha256],
    [document.outputSha256, output.sha256],
  ]) {
    if (
      typeof expected !== 'string' ||
      !SHA.test(expected) ||
      expected !== actual
    )
      return fail('SHA-256 изменился: получите новую проверку этого файла');
  }
  if (!object(document.recipe)) return fail('Не указан исходный рецепт');
  const allowedRecipe = new Set([
    'targetAspectRatio',
    'subtitlesInputKey',
    'subtitleForceStyle',
    'cardsInputKey',
  ]);
  if (Object.keys(document.recipe).some((key) => !allowedRecipe.has(key)))
    return fail('Рецепт содержит неподдерживаемые параметры');
  const current: PostProdOptions = {};
  if (document.recipe.targetAspectRatio !== undefined) {
    if (
      !['4:5', '9:16', '16:9', '1:1'].includes(
        String(document.recipe.targetAspectRatio),
      )
    )
      return fail('Неподдерживаемый формат кадра');
    current.targetAspectRatio = document.recipe.targetAspectRatio as string;
  }
  for (const key of ['subtitlesInputKey', 'cardsInputKey'] as const) {
    if (document.recipe[key] !== undefined) {
      if (document.recipe[key] !== 'titles')
        return fail('Ключ титров должен быть titles');
      current[key] = 'titles';
    }
  }
  if (document.recipe.subtitleForceStyle !== undefined) {
    const style = document.recipe.subtitleForceStyle;
    if (
      typeof style !== 'string' ||
      style.length > 128 ||
      !/^(?:FontSize=\d{1,2}|Alignment=[28]|MarginV=\d{1,3})(?:,(?:FontSize=\d{1,2}|Alignment=[28]|MarginV=\d{1,3}))*$/.test(
        style,
      )
    )
      return fail('Допускаются только числовые FontSize, Alignment и MarginV');
    const entries = style.split(',').map((entry) => entry.split('='));
    if (
      new Set(entries.map(([key]) => key)).size !== entries.length ||
      entries.some(([key, value]) =>
        key === 'FontSize'
          ? +value < 12 || +value > 36
          : key === 'MarginV' && +value > 120,
      )
    )
      return fail('Стиль неоднозначен или выходит за разрешённые границы');
    current.subtitleForceStyle = style;
  }
  const screened = screenPostprodSuggestions(document.suggestions, current);
  const selected = document.selectedParameters;
  if (
    !Array.isArray(selected) ||
    selected.length > 4 ||
    selected.some((value) => typeof value !== 'string') ||
    new Set(selected).size !== selected.length ||
    selected.some(
      (value) =>
        !screened.candidates.some((entry) => entry.parameter === value),
    )
  )
    return fail('Выбраны неподдерживаемые или отклонённые изменения');
  const recipe = { ...current };
  const styles = Object.fromEntries(
    (current.subtitleForceStyle ?? '')
      .split(',')
      .filter(Boolean)
      .map((entry) => entry.split('=')),
  );
  for (const candidate of screened.candidates.filter((entry) =>
    selected.includes(entry.parameter),
  )) {
    if (candidate.parameter === 'targetAspectRatio')
      delete recipe.targetAspectRatio;
    else {
      const keys = {
        subtitleFontSize: 'FontSize',
        subtitleAlignment: 'Alignment',
        subtitleMarginV: 'MarginV',
      };
      styles[keys[candidate.parameter]] = String(candidate.value);
    }
  }
  if (Object.keys(styles).length)
    recipe.subtitleForceStyle = Object.entries(styles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
  const sourceStreams = Array.isArray(source.streams)
    ? source.streams.filter(object)
    : [];
  const plan =
    !recipe.targetAspectRatio &&
    !recipe.subtitlesInputKey &&
    !recipe.cardsInputKey
      ? null
      : planPostProduction({
          ...recipe,
          sourceHasNoAudio: !sourceStreams.some(
            (stream) => stream.type === 'audio',
          ),
          inputKey: 'source',
          outputName: 'reviewed.mp4',
        });
  const manifest = {
    schemaVersion: 1,
    advisoryOnly: true,
    requiresHumanReview: true,
    renderFromOriginalOnly: true,
    source: { inputKey: document.sourceInputKey, sha256: source.sha256 },
    reviewedOutput: { jobId, file, sha256: output.sha256 },
    baseRecipeSha256: hash(current),
    selectedParameters: selected,
    recipe,
    plan,
  };
  return {
    ...screened,
    manifest: { ...manifest, manifestSha256: hash(manifest) },
  };
}
