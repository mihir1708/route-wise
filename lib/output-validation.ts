// Checks structured model output against the small JSON Schema subset the prompt templates use.

export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required: readonly string[]; additionalProperties: false }
  | { type: 'string' | 'number' | 'boolean' | 'null' | readonly ('string' | 'null')[]; enum?: readonly (string | null)[] };

export type Validation = { ok: true; value: unknown } | { ok: false; error: string };

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function check(value: unknown, schema: JsonSchema, path: string): string | null {
  if (schema.type === 'object') {
    if (typeOf(value) !== 'object') return `${path || 'root'} must be an object`;
    const obj = value as Record<string, unknown>;
    for (const key of schema.required) if (!(key in obj)) return `${path}${key} is required`;
    for (const [key, v] of Object.entries(obj)) {
      const child = schema.properties[key];
      if (!child) return `${path}${key} is not allowed`;
      const problem = check(v, child, `${path}${key}.`);
      if (problem) return problem;
    }
    return null;
  }
  const types: readonly string[] = Array.isArray(schema.type) ? schema.type : [schema.type as string];
  const name = path.replace(/\.$/, '') || 'root';
  if (!types.includes(typeOf(value))) return `${name} must be ${types.join(' or ')}`;
  if (schema.enum && !schema.enum.includes(value as string | null)) return `${name} must be one of ${schema.enum.join(', ')}`;
  return null;
}

/** Parses model text as JSON (tolerating a Markdown code fence) and validates it. */
export function validateJsonOutput(text: string, schema: JsonSchema): Validation {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return { ok: false, error: 'not valid JSON' }; }
  const problem = check(value, schema, '');
  return problem ? { ok: false, error: problem } : { ok: true, value };
}
