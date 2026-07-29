/**
 * Normalize MCP JSON Schema tool parameters for LLM / realtime providers.
 *
 * Flow: MCP inputSchema → normalizeToolParameters(schema, provider) → provider wire format.
 *
 * - `default` / `openai` / `xai` — OpenAI-compatible (Realtime, Chat Completions, OpenRouter, …)
 * - `gemini` — Gemini Live (strict Schema proto; rejects many JSON Schema keywords)
 * - `qwen` — DashScope Qwen Omni Realtime (weak type parser; prefers strings, no defaults)
 */

export type ToolSchemaProvider = 'default' | 'openai' | 'xai' | 'gemini' | 'qwen';

/**
 * Provider schemas are allowlists, not blacklists. Unknown JSON Schema
 * keywords are ignored instead of being forwarded to a provider that may
 * reject the entire realtime session.
 */
const STRUCTURAL_KEYS = [
    'type',
    'properties',
    'required',
    'description',
    'items',
    'enum',
] as const;

/** Safe subset for OpenRouter and other unknown OpenAI-compatible models. */
const DEFAULT_SCHEMA_KEYS = new Set<string>([
    ...STRUCTURAL_KEYS,
    'anyOf',
    'oneOf',
    'nullable',
]);

/** OpenAI accepts a broad JSON Schema subset. */
const OPENAI_SCHEMA_KEYS = new Set<string>([
    ...DEFAULT_SCHEMA_KEYS,
    'allOf',
    'const',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
    'default',
]);

/** Gemini FunctionDeclaration Schema fields documented by Google. */
const GEMINI_SCHEMA_KEYS = new Set<string>([
    ...STRUCTURAL_KEYS,
    'nullable',
    'format',
    'anyOf',
]);

/** xAI uses strict JSON Schema grammar and supports these common constraints. */
const XAI_SCHEMA_KEYS = new Set<string>([
    ...DEFAULT_SCHEMA_KEYS,
    'allOf',
    'const',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
]);

/** Qwen Realtime documentation guarantees only the basic function schema fields. */
const QWEN_SCHEMA_KEYS = new Set<string>(STRUCTURAL_KEYS);

interface NormalizeProfile {
    allowedKeys: ReadonlySet<string>;
    /** Drop every `default` field (Qwen / Gemini). */
    dropAllDefaults: boolean;
    /** Coerce boolean / integer / number property types to string (Qwen). */
    relaxScalars: boolean;
    /** How nullable JSON Schema unions are represented for this provider. */
    nullableMode: 'preserve' | 'nullable' | 'strip-null';
    /**
     * Restrict tool names to [a-zA-Z0-9_-] (OpenAI Realtime / many OpenAI-compatible APIs).
     * MCP names like googlecalendar.create_event become googlecalendar_create_event.
     */
    sanitizeToolNames: boolean;
}

function profileFor(provider: ToolSchemaProvider): NormalizeProfile {
    switch (provider) {
    case 'gemini':
        return {
            allowedKeys: GEMINI_SCHEMA_KEYS,
            dropAllDefaults: true,
            relaxScalars: false,
            nullableMode: 'nullable',
            sanitizeToolNames: false,
        };
    case 'qwen':
        return {
            allowedKeys: QWEN_SCHEMA_KEYS,
            dropAllDefaults: true,
            relaxScalars: true,
            nullableMode: 'strip-null',
            // Qwen Realtime accepts namespaced MCP names with dots.
            sanitizeToolNames: false,
        };
    case 'openai':
        return {
            allowedKeys: OPENAI_SCHEMA_KEYS,
            dropAllDefaults: false,
            relaxScalars: false,
            nullableMode: 'preserve',
            sanitizeToolNames: true,
        };
    case 'xai':
        return {
            allowedKeys: XAI_SCHEMA_KEYS,
            dropAllDefaults: true,
            relaxScalars: false,
            nullableMode: 'preserve',
            sanitizeToolNames: true,
        };
    case 'default':
    default:
        return {
            allowedKeys: DEFAULT_SCHEMA_KEYS,
            dropAllDefaults: true,
            relaxScalars: false,
            nullableMode: 'strip-null',
            sanitizeToolNames: true,
        };
    }
}

export interface ToolDefinitionInput {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface NormalizedToolDefinition {
    /** Name safe to send to the provider. */
    name: string;
    /** Original MCP / local tool name (use this when calling MCP / executors). */
    originalName: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface NormalizedToolSet {
    tools: NormalizedToolDefinition[];
    /** Provider-visible name → original MCP / local name. */
    originalNameByName: Map<string, string>;
}

/** OpenAI-compatible tool name pattern: ^[a-zA-Z0-9_-]+$ */
export function sanitizeToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Normalize name + parameters for a provider.
 * For OpenAI-compatible providers, dots in names become underscores;
 * `originalName` always keeps the MCP name for tool execution.
 */
export function normalizeToolDefinition(
    tool: ToolDefinitionInput,
    provider: ToolSchemaProvider = 'default',
): NormalizedToolDefinition {
    const profile = profileFor(provider);
    const originalName = tool.name;
    const name = profile.sanitizeToolNames ? sanitizeToolName(originalName) : originalName;
    return {
        name,
        originalName,
        description: tool.description,
        parameters: normalizeToolParameters(tool.parameters, provider),
    };
}

/**
 * Normalize a complete tool collection and build the reverse name map needed
 * when a provider requires sanitized names.
 *
 * Throws on a post-sanitization collision instead of silently routing a call
 * to the wrong MCP tool.
 */
export function normalizeToolDefinitions(
    tools: ToolDefinitionInput[],
    provider: ToolSchemaProvider = 'default',
): NormalizedToolSet {
    const originalNameByName = new Map<string, string>();
    const normalized = tools.map((tool) => {
        const result = normalizeToolDefinition(tool, provider);
        const previous = originalNameByName.get(result.name);
        if (previous && previous !== result.originalName) {
            throw new Error(
                `Tool name collision for provider "${provider}": `
                + `"${previous}" and "${result.originalName}" both normalize to "${result.name}"`,
            );
        }
        originalNameByName.set(result.name, result.originalName);
        return result;
    });
    return { tools: normalized, originalNameByName };
}

/**
 * Convert MCP JSON Schema into a provider-safe parameters object.
 * Omitting `provider` uses `default` (OpenAI-compatible / OpenRouter / pipeline LLM).
 */
export function normalizeToolParameters(
    schema: Record<string, unknown> | undefined | null,
    provider: ToolSchemaProvider = 'default',
): Record<string, unknown> {
    const profile = profileFor(provider);
    const source = schema ?? { type: 'object', properties: {} };
    const dereferenced = dereferenceLocalRefs(source, source, new Set());
    const cleaned = normalizeSchema(dereferenced, profile);

    if (cleaned !== null && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
        const obj = cleaned as Record<string, unknown>;
        // MCP tool arguments are always an object, even if a malformed server
        // omitted the root type.
        if (!obj.type && !obj.anyOf && !obj.oneOf) obj.type = 'object';
        if (obj.type === 'object' && !obj.properties) obj.properties = {};
        return profile.relaxScalars ? relaxScalarPropertyTypes(obj) : obj;
    }

    return { type: 'object', properties: {} };
}

function normalizeSchema(schema: unknown, profile: NormalizeProfile): unknown {
    if (Array.isArray(schema)) {
        return schema.map((item) => normalizeSchema(item, profile));
    }

    if (schema === null || typeof schema !== 'object') {
        return schema;
    }

    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (!profile.allowedKeys.has(key)) continue;

        if (key === 'default') {
            if (profile.dropAllDefaults || value === null) continue;
        }

        // JSON Schema nullable union → provider-specific representation.
        if (key === 'type' && Array.isArray(value)) {
            if (profile.nullableMode === 'preserve') {
                out.type = value.filter((type): type is string => typeof type === 'string');
                continue;
            }
            const concreteTypes = value.filter((type) => type !== 'null');
            if (concreteTypes.length === 1 && concreteTypes.length !== value.length) {
                out.type = concreteTypes[0];
                if (profile.nullableMode === 'nullable') out.nullable = true;
                continue;
            }
        }

        // anyOf: [{...}, { type: "null" }] → concrete schema for providers
        // that do not reliably support nullable composition.
        if (key === 'anyOf' && Array.isArray(value)) {
            const concreteSchemas = value.filter((candidate) => {
                if (
                    candidate === null
                    || typeof candidate !== 'object'
                    || Array.isArray(candidate)
                ) {
                    return true;
                }
                return (candidate as Record<string, unknown>).type !== 'null';
            });

            if (
                profile.nullableMode !== 'preserve'
                && concreteSchemas.length === 1
                && concreteSchemas.length !== value.length
            ) {
                const concreteSchema = normalizeSchema(concreteSchemas[0], profile);
                if (
                    concreteSchema !== null
                    && typeof concreteSchema === 'object'
                    && !Array.isArray(concreteSchema)
                ) {
                    Object.assign(out, concreteSchema);
                    if (profile.nullableMode === 'nullable') out.nullable = true;
                    continue;
                }
            }
        }

        if (key === 'properties' && isRecord(value)) {
            const properties: Record<string, unknown> = {};
            for (const [propertyName, propertySchema] of Object.entries(value)) {
                properties[propertyName] = normalizeSchema(propertySchema, profile);
            }
            out.properties = properties;
            continue;
        }

        out[key] = normalizeSchema(value, profile);
    }

    if (Array.isArray(out.required) && isRecord(out.properties)) {
        const propertyNames = new Set(Object.keys(out.properties));
        out.required = out.required.filter(
            (name): name is string => typeof name === 'string' && propertyNames.has(name),
        );
    }

    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Expand local JSON Pointer references before applying provider allowlists.
 * This avoids the old failure mode where `$defs` was removed while `$ref`
 * survived as a dangling reference.
 */
function dereferenceLocalRefs(
    schema: unknown,
    root: Record<string, unknown>,
    resolving: Set<string>,
): unknown {
    if (Array.isArray(schema)) {
        return schema.map((item) => dereferenceLocalRefs(item, root, resolving));
    }
    if (!isRecord(schema)) return schema;

    const ref = schema.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
        if (resolving.has(ref)) {
            return {
                type: 'object',
                description: `Recursive schema reference ${ref} omitted`,
                properties: {},
            };
        }

        const target = resolveJsonPointer(root, ref);
        if (target !== undefined) {
            const nextResolving = new Set(resolving);
            nextResolving.add(ref);
            const expanded = dereferenceLocalRefs(target, root, nextResolving);
            const siblings = Object.fromEntries(
                Object.entries(schema).filter(([key]) => key !== '$ref'),
            );
            if (isRecord(expanded)) {
                return {
                    ...expanded,
                    ...dereferenceLocalRefs(siblings, root, nextResolving) as Record<string, unknown>,
                };
            }
            return expanded;
        }
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === '$defs' || key === 'definitions') continue;
        out[key] = dereferenceLocalRefs(value, root, resolving);
    }
    return out;
}

function resolveJsonPointer(root: Record<string, unknown>, ref: string): unknown {
    let current: unknown = root;
    for (const encoded of ref.slice(2).split('/')) {
        if (!isRecord(current)) return undefined;
        const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
        current = current[key];
    }
    return current;
}

/** Top-level + nested object properties: boolean/integer/number → string; drop defaults. */
function relaxScalarPropertyTypes(schema: Record<string, unknown>): Record<string, unknown> {
    const props = schema.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return schema;
    }

    const relaxed: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            relaxed[key] = raw;
            continue;
        }
        relaxed[key] = relaxOneProperty(raw as Record<string, unknown>);
    }
    return { ...schema, properties: relaxed };
}

function relaxOneProperty(prop: Record<string, unknown>): Record<string, unknown> {
    const { default: _default, ...rest } = prop;
    void _default;

    let type = rest.type;
    if (Array.isArray(type)) {
        type = (type as string[]).find((t) => t !== 'null') ?? 'string';
    }
    if (type === 'boolean' || type === 'integer' || type === 'number') {
        type = 'string';
    }

    const next: Record<string, unknown> = { ...rest, type };
    if (next.properties && typeof next.properties === 'object' && !Array.isArray(next.properties)) {
        return relaxScalarPropertyTypes(next);
    }
    if (next.items && typeof next.items === 'object' && !Array.isArray(next.items)) {
        next.items = relaxOneProperty(next.items as Record<string, unknown>);
    }
    return next;
}

/**
 * Coerce LLM tool-call arguments back to types expected by the MCP inputSchema.
 * Needed when the provider schema was relaxed to strings (Qwen) but the server
 * still validates boolean / number / integer strictly.
 */
export function coerceToolArguments(
    args: Record<string, unknown>,
    schema?: Record<string, unknown> | null,
): Record<string, unknown> {
    const props = schema?.properties;
    const propMap = (
        props && typeof props === 'object' && !Array.isArray(props)
            ? props as Record<string, Record<string, unknown>>
            : undefined
    );

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        out[key] = coerceValueToProperty(value, propMap?.[key]);
    }
    return out;
}

function jsonSchemaType(prop?: Record<string, unknown>): string | undefined {
    if (!prop) return undefined;

    let type = prop.type;
    if (Array.isArray(type)) {
        type = (type as string[]).find((t) => t !== 'null');
    }
    if (typeof type === 'string') return type;

    // anyOf: [{ type: "boolean" }, { type: "null" }]
    const anyOf = prop.anyOf;
    if (Array.isArray(anyOf)) {
        for (const candidate of anyOf) {
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
            const t = jsonSchemaType(candidate as Record<string, unknown>);
            if (t && t !== 'null') return t;
        }
    }
    return undefined;
}

function coerceValueToProperty(value: unknown, prop?: Record<string, unknown>): unknown {
    if (typeof value !== 'string') return value;

    const type = jsonSchemaType(prop);
    if (type === 'boolean') {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
        return value;
    }
    if (type === 'integer' || type === 'number') {
        const trimmed = value.trim();
        if (trimmed === '') return value;
        const n = Number(trimmed);
        if (Number.isNaN(n)) return value;
        return type === 'integer' ? Math.trunc(n) : n;
    }

    // No schema hint — still fix obvious bool strings (orchestrator pattern).
    if (!prop) {
        if (value === 'true') return true;
        if (value === 'false') return false;
    }
    return value;
}
