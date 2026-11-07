import { InternalServerErrorException } from '@nestjs/common';

/** A dispatch may have been accepted. Never advertise this as safely retryable. */
export class ProviderDispatchUnknownError extends InternalServerErrorException {
  constructor() {
    super({
      code: 'GENERATION_RECONCILIATION_REQUIRED',
      message:
        'Не удалось подтвердить результат отправки. Не запускайте повторно до проверки предыдущей попытки.',
    });
  }
}

/** Only an explicit 4xx rejection (except timeout/conflict/client-close) proves a failed dispatch. */
export function dispatchOutcomeUnknown(error: unknown): boolean {
  const e = error as {
    status?: unknown;
    response?: { status?: unknown };
  } | null;
  const status = e?.response?.status ?? e?.status;
  return !(
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 499].includes(status)
  );
}

export async function guardProviderDispatch<T>(
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (dispatchOutcomeUnknown(error)) throw new ProviderDispatchUnknownError();
    throw error;
  }
}
