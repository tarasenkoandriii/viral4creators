/** Model output is advisory. This screen does not render, approve a video,
 * validate visual evidence, or return executable command/style strings.
 */
import type { PostProdOptions } from './postprod';

type Parameter =
  | 'targetAspectRatio'
  | 'subtitleFontSize'
  | 'subtitleAlignment'
  | 'subtitleMarginV';

export interface ScreenedPostprodSuggestions {
  requiresHumanReview: true;
  candidates: {
    parameter: Parameter;
    value: string | number;
    reason: string;
  }[];
  rejected: { parameter: string; reason: string }[];
}

export function screenPostprodSuggestions(
  raw: unknown,
  current: PostProdOptions,
): ScreenedPostprodSuggestions {
  const result: ScreenedPostprodSuggestions = {
    requiresHumanReview: true,
    candidates: [],
    rejected: [],
  };
  if (!Array.isArray(raw) || raw.length > 12) {
    throw new Error('Invalid suggestions envelope');
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid suggestion');
    }
    const { parameter, value, reason } = item as Record<string, unknown>;
    if (
      typeof parameter !== 'string' ||
      parameter.length > 64 ||
      typeof reason !== 'string' ||
      reason.length > 2000 ||
      !reason.trim()
    ) {
      throw new Error('Invalid suggestion fields');
    }
    const reject = (why: string) =>
      result.rejected.push({ parameter, reason: why });
    if (seen.has(parameter)) {
      // Conflicting proposals cannot silently win by order.
      throw new Error('Duplicate parameter suggestion');
    }
    seen.add(parameter);
    if (parameter === 'targetAspectRatio') {
      // Cropping is not placement-aware. Only removing a crop is supported
      // here; switching aspect ratios needs separate source geometry review.
      if (value !== 'native') {
        reject('Only explicit restoration of native framing is supported');
      } else if (!current.targetAspectRatio) {
        reject('No crop to remove');
      } else {
        result.candidates.push({ parameter, value, reason });
      }
      continue;
    }
    const keys: Record<string, string> = {
      subtitleFontSize: 'FontSize',
      subtitleAlignment: 'Alignment',
      subtitleMarginV: 'MarginV',
    };
    const styleKey = keys[parameter];
    if (!Object.prototype.hasOwnProperty.call(keys, parameter)) {
      reject('Unsupported parameter');
      continue;
    }
    if (!current.subtitlesInputKey || current.cardsInputKey) {
      reject('SRT controls are inactive for this recipe');
      continue;
    }
    const numeric =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{1,3}$/.test(value)
          ? Number(value)
          : NaN;
    if (
      !Number.isInteger(numeric) ||
      (parameter === 'subtitleFontSize' && (numeric < 12 || numeric > 36)) ||
      (parameter === 'subtitleAlignment' && ![2, 8].includes(numeric)) ||
      (parameter === 'subtitleMarginV' && (numeric < 0 || numeric > 120))
    ) {
      reject('Value outside supported bounds');
      continue;
    }
    const entries = (current.subtitleForceStyle ?? '')
      .split(',')
      .map((entry) => entry.trim().split('='));
    const values = entries.filter(([name]) => name === styleKey);
    if (values.length > 1) {
      reject('Ambiguous current style');
      continue;
    }
    if (values.length && Number(values[0][1]) === numeric) {
      reject('No change: the suggested value is already active');
      continue;
    }
    result.candidates.push({
      parameter: parameter as Parameter,
      value: numeric,
      reason,
    });
  }
  return result;
}
