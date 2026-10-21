/**
 * Проверка значений опций фильтров по типу (FF-SEC-02/03): размеры
 * кадров, частоты и длительности — против профиля лимитов; выражения —
 * только из идентификаторов корпуса.
 */
import type { LimitsProfile } from '../contracts';
import { EXPR_IDENTIFIERS, ValueKind } from './allowlist';

export type ValueLimits = Pick<
  LimitsProfile,
  'maxWidth' | 'maxHeight' | 'maxImagePixels' | 'maxFps' | 'maxInputDurationSec'
>;

/** Профиль пилота (ТЗ §9) — если вызывающий не передал поля лимитов. */
export const DEFAULT_VALUE_LIMITS: ValueLimits = {
  maxWidth: 1920,
  maxHeight: 1080,
  maxImagePixels: 24_000_000,
  maxFps: 60,
  maxInputDurationSec: 600,
};

const NUMBER = /^-?\d{1,9}(\.\d{1,9})?$/;
const MAX_SAMPLE_RATE = 192_000;
const MAX_EXPR_LENGTH = 512;

/** Кадр WxH (числа) в пределах профиля независимо от ориентации. */
export function frameFits(w: number, h: number, l: ValueLimits): boolean {
  const longMax = Math.max(l.maxWidth, l.maxHeight);
  const shortMax = Math.min(l.maxWidth, l.maxHeight);
  return (
    w > 0 &&
    h > 0 &&
    Math.max(w, h) <= longMax &&
    Math.min(w, h) <= shortMax &&
    w * h <= l.maxImagePixels
  );
}

export function checkExpr(v: string): string | null {
  if (v.length === 0 || v.length > MAX_EXPR_LENGTH) return 'expression length';
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?(?:e-?\d+)?|[-+*/(),])/y;
  let p = 0;
  while (p < v.length) {
    re.lastIndex = p;
    const m = re.exec(v);
    if (!m) return `unsupported expression syntax near "${v.slice(p, p + 12)}"`;
    const tok = m[1];
    if (/^[A-Za-z_]/.test(tok) && !EXPR_IDENTIFIERS.has(tok)) {
      return `identifier "${tok}" is not allowed in expressions`;
    }
    p = re.lastIndex;
  }
  return null;
}

/** null — значение допустимо; иначе причина. */
export function checkValue(
  kind: ValueKind,
  v: string,
  l: ValueLimits,
): string | null {
  const n = Number(v);
  const isNum = NUMBER.test(v) && Number.isFinite(n);
  switch (kind.kind) {
    case 'file-read':
    case 'file-write':
      return null; // проверяет resolveRef
    case 'num':
      return isNum && n >= kind.min && n <= kind.max
        ? null
        : 'number out of range';
    case 'int':
      return isNum && Number.isInteger(n) && n >= kind.min && n <= kind.max
        ? null
        : 'integer out of range';
    case 'dim':
      if (v === '-1' || v === '-2') return null;
      return isNum &&
        Number.isInteger(n) &&
        n >= 1 &&
        n <= Math.max(l.maxWidth, l.maxHeight)
        ? null
        : 'frame dimension exceeds the profile';
    case 'size': {
      const m = /^(\d{1,5})x(\d{1,5})$/.exec(v);
      if (!m) return 'size must be WxH';
      return frameFits(Number(m[1]), Number(m[2]), l)
        ? null
        : 'frame size exceeds the profile';
    }
    case 'rate': {
      const m = /^(\d{1,4}(?:\.\d{1,6})?)(?:\/(\d{1,6}))?$/.exec(v);
      if (!m) return 'invalid rate';
      const r = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
      return r > 0 && r <= l.maxFps ? null : 'frame rate exceeds the profile';
    }
    case 'dur':
      return isNum && n >= 0 && n <= l.maxInputDurationSec
        ? null
        : 'duration exceeds the profile';
    case 'ms':
      return isNum && n >= 0 && n <= l.maxInputDurationSec * 1000
        ? null
        : 'delay exceeds the profile';
    case 'samples':
      return isNum &&
        Number.isInteger(n) &&
        n >= 0 &&
        n <= l.maxInputDurationSec * MAX_SAMPLE_RATE
        ? null
        : 'sample count exceeds the profile';
    case 'expr':
      return checkExpr(v);
    case 'enum':
      return kind.values.includes(v)
        ? null
        : `value "${v.slice(0, 20)}" is not allowed`;
    case 'color':
      return /^(black|white|0x[0-9A-Fa-f]{6})(@(0|1|0?\.\d{1,3}))?$/.test(v)
        ? null
        : 'invalid color';
    case 'style':
      return /^[A-Za-z0-9=,&.]{0,512}$/.test(v) ? null : 'invalid force_style';
    case 'text':
      return v.length <= 1000 ? null : 'text too long';
    default:
      return 'unknown value kind';
  }
}
