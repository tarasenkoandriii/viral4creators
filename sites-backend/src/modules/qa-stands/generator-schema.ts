// Compact provider schema; runtime still enforces every bound and reference.
const text = (_maxLength: number) => ({ type: 'string' });
const identifier = text(40);
const array = (items: unknown, _maxItems: number, _minItems = 0) => ({
  type: 'array',
  items,
});
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required, additionalProperties: false });
const condition = object(
  {
    field: text(60),
    equals: text(500),
    related: object({
      entityId: identifier,
      viaField: text(60),
      matchField: text(60),
    }),
  },
  ['field', 'equals'],
);
/** Provider enforces structure; runtime enforces bounds, identifiers and references. */
export const QA_STAND_JSON_SCHEMA = object(
  {
    title: text(100),
    entities: array(
      object({
        id: identifier,
        title: text(100),
        fields: array(
          object({
            name: text(60),
            type: {
              type: 'string',
              enum: ['text', 'number', 'email', 'select'],
            },
            required: { type: 'boolean' },
            options: array(text(80), 12),
          }),
          8,
          1,
        ),
      }),
      5,
      1,
    ),
    screens: array(
      object({
        id: identifier,
        title: text(100),
        kind: { type: 'string', enum: ['list', 'form', 'dashboard'] },
        entityId: identifier,
        nextScreenId: { anyOf: [identifier, { type: 'null' }] },
      }),
      10,
      1,
    ),
    assumptions: array(text(300), 10),
    workflows: array(
      object({
        entityId: identifier,
        stateField: text(60),
        initial: text(80),
        transitions: array(
          object({
            id: identifier,
            title: text(100),
            from: array(text(80), 12, 1),
            to: text(80),
            roles: array({ type: 'string', enum: ['editor', 'admin'] }, 2, 1),
            conditions: array(condition, 10),
            seal: { type: 'boolean' },
            requireSeal: { type: 'boolean' },
          }),
          12,
          1,
        ),
      }),
      5,
    ),
  },
  ['title', 'entities', 'screens', 'assumptions'],
);
