export interface TransferField {
  name: string;
  type: string;
  generated?: string;
}
export interface FormSnapshot {
  url: string;
  version: string;
  fields: Array<{
    id: string;
    type: string;
    required: boolean;
    min?: number;
    max?: number;
    maxLength?: number;
    options?: string[];
  }>;
}
export function transferable(
  field: TransferField,
  value: string,
  stateField?: string
) {
  if (field.type === 'url') {
    try {
      const u = new URL(value);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        return false;
    } catch {
      return false;
    }
  }
  return (
    !field.generated &&
    field.name !== stateField &&
    ['text', 'email', 'number', 'url'].includes(field.type) &&
    !/password|secret|token|cookie|credential|(?:client|api|access).?key|one.?time|(?:^|[_\s-])otp(?:$|[_\s-])|card.?number|credit.?card|cvv|cvc|iban|парол|секрет|токен|ключ|кред|однораз/i.test(
      field.name
    ) &&
    !!value &&
    value.length <= 500 &&
    !/MOCK_|\bmock\b|placeholder|\.invalid\b|\.test\b|localhost|127\.0\.0\.1|^Bearer\s|^sk-[a-z0-9]/i.test(
      value
    )
  );
}
export function parseFormSnapshot(input: unknown): FormSnapshot {
  const x = input as FormSnapshot;
  if (
    !x ||
    typeof x !== 'object' ||
    !Array.isArray(x.fields) ||
    !x.fields.length ||
    x.fields.length > 50 ||
    typeof x.url !== 'string'
  )
    throw new Error('Неверный снимок формы');
  if (
    Object.keys(x).some((k) => !['url', 'version', 'fields'].includes(k)) ||
    typeof x.version !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(x.version)
  )
    throw new Error('Снимок содержит неподдержанные свойства');
  const url = new URL(x.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Нужен HTTPS адрес без параметров и фрагмента');
  if (
    x.fields.some(
      (f) =>
        !f ||
        !/^field_[0-9a-f]{8}$/.test(f.id) ||
        typeof f.type !== 'string' ||
        typeof f.required !== 'boolean'
    ) ||
    new Set(x.fields.map((f) => f.id)).size !== x.fields.length
  )
    throw new Error('Нужен снимок локального сборщика со стабильными полями');
  for (const f of x.fields) {
    if (
      Object.keys(f).some(
        (k) =>
          ![
            'id',
            'type',
            'required',
            'min',
            'max',
            'maxLength',
            'options',
          ].includes(k)
      ) ||
      ![
        'text',
        'email',
        'number',
        'url',
        'password',
        'file',
        'select',
        'checkbox',
        'date',
        'datetime',
      ].includes(f.type)
    )
      throw new Error('Снимок не должен содержать значения полей');
    for (const k of ['min', 'max', 'maxLength'] as const)
      if (
        f[k] !== undefined &&
        (typeof f[k] !== 'number' ||
          !Number.isFinite(f[k]) ||
          Math.abs(f[k]) > 1e9)
      )
        throw new Error('Неверное ограничение поля');
    if (
      f.options !== undefined &&
      (!Array.isArray(f.options) || f.options.length > 0)
    )
      throw new Error('Перенос вариантов select не поддержан');
  }
  return { url: url.href, version: x.version, fields: x.fields };
}
