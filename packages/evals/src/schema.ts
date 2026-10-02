/**
 * The subset of JSON Schema the orchestrator tools use, checked without a
 * dependency: type (object, string, integer, number, boolean, array), const,
 * enum, properties, required, additionalProperties: false, minLength,
 * maxLength, minimum, maximum, items, minItems, maxItems, anyOf. A schema
 * using any other keyword is rejected, so that nothing is silently ignored.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

const KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'minItems',
  'maxItems',
  'anyOf',
  'description',
]);

/** Problems found, as JSON-pointer-like paths with a short reason; empty when valid. */
export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const unknown = Object.keys(schema).filter((key) => !KEYWORDS.has(key));
  if (unknown.length > 0) throw new TypeError(`${path}: unsupported schema keyword(s) ${unknown.join(', ')}`);

  if (Array.isArray(schema.anyOf)) {
    const siblings = Object.keys(schema).filter((key) => key !== 'anyOf' && key !== 'description');
    if (siblings.length > 0) throw new TypeError(`${path}: anyOf next to ${siblings.join(', ')} is not supported`);
    const options = schema.anyOf as JsonSchema[];
    return options.some((option) => validate(option, value, path).length === 0) ? [] : [`${path}: matches no option`];
  }
  if ('const' in schema && !sameJson(schema.const, value)) return [`${path}: expected ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    return [`${path}: not one of ${JSON.stringify(schema.enum)}`];
  }

  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new TypeError(`${path}: only additionalProperties: false is supported`);
  }

  switch (schema.type) {
    case undefined:
      return [];
    case 'string': {
      if (typeof value !== 'string') return [`${path}: expected a string`];
      // Code points, as JSON Schema counts them, not UTF-16 units.
      const length = Array.from(value).length;
      if (typeof schema.minLength === 'number' && length < schema.minLength) return [`${path}: too short`];
      if (typeof schema.maxLength === 'number' && length > schema.maxLength) return [`${path}: too long`];
      return [];
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected a number`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path}: expected an integer`];
      if (typeof schema.minimum === 'number' && value < schema.minimum) return [`${path}: below minimum`];
      if (typeof schema.maximum === 'number' && value > schema.maximum) return [`${path}: above maximum`];
      return [];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected a boolean`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected an array`];
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return [`${path}: too few items`];
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return [`${path}: too many items`];
      const items = schema.items as JsonSchema | undefined;
      return items === undefined ? [] : value.flatMap((item, index) => validate(items, item, `${path}[${String(index)}]`));
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected an object`];
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const problems: string[] = [];
      for (const key of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(record, key)) problems.push(`${path}.${key}: required`);
      }
      for (const [key, entry] of Object.entries(record)) {
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (property === undefined) {
          if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`);
          continue;
        }
        problems.push(...validate(property, entry, `${path}.${key}`));
      }
      return problems;
    }
    default:
      throw new TypeError(`${path}: unsupported type ${JSON.stringify(schema.type)}`);
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
