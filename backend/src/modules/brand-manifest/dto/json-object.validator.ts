import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * `filters` / `effects` (spec §12.1 — structure deliberately open for v1):
 * accept any plain JSON object, reject arrays/scalars, and cap the
 * serialized size so a client can't stuff megabytes into a Json column.
 * `null` is allowed by callers via @ValidateIf (means "clear").
 */
export const MAX_JSON_BYTES = 16 * 1024;

@ValidatorConstraint({ name: 'jsonObject', async: false })
export class IsJsonObject implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_JSON_BYTES;
    } catch {
      return false;
    }
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a plain JSON object (not an array) of at most ${MAX_JSON_BYTES} bytes`;
  }
}
