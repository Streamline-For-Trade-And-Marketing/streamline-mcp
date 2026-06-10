/**
 * Minimal Zod → JSON Schema converter.
 *
 * The MCP SDK's `tools/list` response expects each tool's
 * `inputSchema` to be a JSON Schema object the model can read.
 * Zod schemas are nicer for runtime parsing AND give us TypeScript
 * inference, so we author tools in Zod and convert here.
 *
 * We don't pull in `zod-to-json-schema` (the npm package) because:
 *  1. It ships features we don't need (refs, nullable handling, etc.)
 *  2. The MCP model expects a SHALLOW, conventional schema — refs and
 *     deeply-cyclic definitions just confuse the tool-call planner.
 *  3. Keeping the converter in-repo means we can pin its behaviour to
 *     exactly the dialect Claude is happiest with.
 *
 * Supported zod constructs (everything `tools.ts` actually uses):
 *   z.object({...})          z.string()           z.number()
 *   z.boolean()              z.enum([...])        z.union([...])
 *   z.array(...)             .optional()          .default(...)
 *   .describe(...)           .min/.max/.int       .regex(...)
 *   .nonnegative()           .positive()
 *
 * Anything else falls back to `{ type: 'string' }` with a console.warn
 * so we notice when a tool introduces an unsupported shape.
 */
import { z, ZodTypeAny } from 'zod';

type JSONSchema = Record<string, any>;

export function zodToJsonSchema(schema: ZodTypeAny): JSONSchema {
  const result = walk(schema);
  // Top-level schema must be an object — MCP tool inputs are always
  // keyed by parameter name.
  if (result.type !== 'object') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }
  return result;
}

function walk(schema: ZodTypeAny): JSONSchema {
  const def: any = (schema as any)._def;
  const typeName: string = def?.typeName;

  // Handle wrappers that delegate to an inner type first so we don't
  // miss their `description` / default / optional treatment.
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    const inner = walk(def.innerType);
    // `.optional().describe(...)` hangs the description on the WRAPPER —
    // carry it through or it silently vanishes from tools/list.
    if (def.description && !inner.description) {
      inner.description = def.description;
    }
    return inner;
  }
  if (typeName === 'ZodDefault') {
    const inner = walk(def.innerType);
    inner.default = def.defaultValue();
    return inner;
  }
  if (typeName === 'ZodEffects') {
    // Refinements / transforms — fall through to the underlying schema.
    return walk(def.schema);
  }

  let out: JSONSchema = {};

  switch (typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        const child = shape[key];
        properties[key] = walk(child);
        // `isOptional()` covers both ZodOptional AND ZodDefault — we
        // only mark "required" for things the caller MUST supply.
        if (!child.isOptional() && !isZodDefault(child)) {
          required.push(key);
        }
      }
      out = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
      break;
    }
    case 'ZodString': {
      out = { type: 'string' };
      const checks: any[] = def.checks || [];
      for (const c of checks) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
        if (c.kind === 'regex') out.pattern = c.regex.source;
      }
      break;
    }
    case 'ZodNumber': {
      out = { type: 'number' };
      const checks: any[] = def.checks || [];
      for (const c of checks) {
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
        if (c.kind === 'int') out.type = 'integer';
      }
      break;
    }
    case 'ZodBoolean': {
      out = { type: 'boolean' };
      break;
    }
    case 'ZodEnum': {
      out = { type: 'string', enum: def.values };
      break;
    }
    case 'ZodLiteral': {
      const v = def.value;
      const t = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
      out = { type: t, const: v };
      break;
    }
    case 'ZodUnion': {
      const options: ZodTypeAny[] = def.options;
      out = { anyOf: options.map(walk) };
      break;
    }
    case 'ZodArray': {
      out = { type: 'array', items: walk(def.type) };
      break;
    }
    case 'ZodRecord': {
      // Id-keyed maps (e.g. booking sub_service_ids / prices): an open
      // object whose values follow the record's value schema.
      out = { type: 'object', additionalProperties: walk(def.valueType) };
      break;
    }
    case 'ZodAny':
    case 'ZodUnknown': {
      out = {};
      break;
    }
    default: {
      // eslint-disable-next-line no-console
      console.error(
        `[streamline-mcp] zod-to-jsonschema: unsupported type "${typeName}". Falling back to string.`,
      );
      out = { type: 'string' };
    }
  }

  // Carry the .describe() string through if present — Claude uses it
  // to disambiguate similarly-named parameters.
  if (def.description) {
    out.description = def.description;
  }

  return out;
}

function isZodDefault(s: ZodTypeAny): boolean {
  return (s as any)?._def?.typeName === 'ZodDefault';
}
