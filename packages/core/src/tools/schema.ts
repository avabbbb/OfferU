// Minimal JSON-schema check for tool arguments: the subset pydantic emits for
// the tool input models (object / additionalProperties:false / required /
// anyOf with null / enum / string / integer / number / boolean / array /
// minimum / maximum / minLength / $ref into $defs). Replaces pydantic
// `extra="forbid"` validation in Python tools.call.

import { CoreError } from "../types";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  title?: string;
  default?: unknown;
  [key: string]: unknown;
};

export type ToolSpec = { name: string; description: string; inputSchema: JsonSchema };

function fail(path: string, message: string): never {
  throw new CoreError(`参数 ${path || "(根)"} ${message}`);
}

function check(value: unknown, schema: JsonSchema, path: string, root: JsonSchema): void {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    if (!target) fail(path, `引用了未知类型 ${schema.$ref}`);
    check(value, target, path, root);
    return;
  }
  if (schema.anyOf) {
    const errors: string[] = [];
    for (const option of schema.anyOf) {
      try {
        check(value, option, path, root);
        return;
      } catch (cause) {
        errors.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
    throw new CoreError(errors[0] ?? `参数 ${path} 不合法`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    fail(path, `只能是 ${schema.enum.map((item) => JSON.stringify(item)).join(" / ")}`);
  }
  switch (schema.type) {
    case undefined:
      return;
    case "null":
      if (value !== null) fail(path, "要是 null");
      return;
    case "string":
      if (typeof value !== "string") fail(path, "要是字符串");
      if (schema.minLength !== undefined && [...value].length < schema.minLength) fail(path, `至少 ${schema.minLength} 个字`);
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail(path, `最多 ${schema.maxLength} 个字`);
      return;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        fail(path, schema.type === "integer" ? "要是整数" : "要是数字");
      }
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, `不能小于 ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, `不能大于 ${schema.maximum}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "要是 true 或 false");
      return;
    case "array":
      if (!Array.isArray(value)) fail(path, "要是数组");
      if (schema.items) value.forEach((item, index) => check(item, schema.items!, `${path}[${index}]`, root));
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "要是对象");
      const object = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!(key in object)) fail(path ? `${path}.${key}` : key, "必填");
      }
      for (const [key, item] of Object.entries(object)) {
        const sub = properties[key];
        const where = path ? `${path}.${key}` : key;
        if (sub) check(item, sub, where, root);
        else if (schema.additionalProperties === false) fail(where, "不认识；可用：" + Object.keys(properties).join(", "));
        else if (typeof schema.additionalProperties === "object") check(item, schema.additionalProperties, where, root);
      }
      return;
    }
    default:
      return;
  }
}

/** Throws CoreError("invalid") when args do not match the tool's input schema. */
export function validateArgs(schema: JsonSchema, args: unknown): Record<string, unknown> {
  check(args ?? {}, schema, "", schema);
  return { ...(args as Record<string, unknown> ?? {}) };
}
