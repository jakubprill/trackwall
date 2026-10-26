import { type HttpMethod, httpUrlPath, joinHttpPath } from "@trackwall/protocol";
import { isMap, isNode, isScalar, isSeq, LineCounter, type Node, parseDocument, type YAMLMap } from "yaml";
import type { ContentSearch } from "./read-snapshot.ts";
import { baseName, stemOf } from "./repo-path.ts";
import { isTestPath } from "./spring-config.ts";

/**
 * Reading an OpenAPI 3 or Swagger 2 spec from the repo (§4.6, ADR-87): the title, the base path from the first server
 * (`servers[0].url`, Swagger `basePath`), and the operations under `paths` with the `operationId`, the summary, the JSON
 * request and response schema names and the line of each operation. JSON is read by the same YAML parser, which gives lines. Only
 * the spec file itself: a path item or body in another file (`$ref: orders.yaml#/…`) gives no operation, and aliases
 * (`*anchor`) are not followed (§8).
 */

export interface SpecOperation {
  method: HttpMethod;
  /** The path from `paths` (`/orders/{id}`), without the base path: whether the app serves it there depends on the code. */
  path: string;
  id: string | null;
  summary: string | null;
  request: string | null;
  response: string | null;
  line: number;
}

export interface OpenApiSpec {
  /** `info.title`; `null` without one. */
  title: string | null;
  /** The path of the first server address or `basePath` (`/api/v1`); `""` without one. */
  basePath: string;
  operations: SpecOperation[];
  /** More operations than `MAX_OPERATIONS`; the rest are not on the card. */
  truncated: boolean;
}

/** At most this many operations from one spec: more is a generated aggregate, and the card has to stay small. */
export const MAX_OPERATIONS = 2000;
const MAX_SUMMARY_LENGTH = 200;
/** How deep a schema is followed for a type name (`List<Map<string, Order>>`); deeper is `object`. */
const MAX_SCHEMA_DEPTH = 4;
/** How many local `$ref`s are followed in a row for a request body or a response. */
const MAX_REF_HOPS = 3;
/**
 * A spec is found by its content, whatever its name (ADR-87): a YAML file with a top-level `openapi` or `swagger` key, or
 * a JSON file with the quoted key on a line (also `{"openapi":` of a one-line JSON). The search runs in `git grep` (ERE); `SPEC_KEY` is the same
 * test in JavaScript, which skips other YAML files (`application.yml`) before parsing them.
 */
const SPEC_KEY_ERE = '^(openapi|swagger)[[:space:]]*:|^[[:space:]]*[{]?[[:space:]]*"(openapi|swagger)"[[:space:]]*:';
// Blanks within a line only (`[ \t]`, like git grep's line-bound `[[:space:]]`): `\s` with the `m` flag also crosses lines,
// and a file of blank lines from the repo would backtrack for minutes (§8).
const SPEC_KEY = /^(openapi|swagger)[ \t]*:|^[ \t]*\{?[ \t]*"(openapi|swagger)"[ \t]*:/m;
const SPEC_GLOBS = ["*.yaml", "*.yml", "*.json"];
/** At most this many spec candidates from the search: a repo keeps a few specs, more is generated or vendored. */
const MAX_SPEC_FILES = 200;

const HTTP_METHODS: Readonly<Record<string, HttpMethod>> = {
  get: "GET",
  put: "PUT",
  post: "POST",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  patch: "PATCH",
};

/** Whether the file can be a spec: YAML or JSON outside test code; whether it is one, its content says. */
export function isSpecCandidate(path: string): boolean {
  const name = baseName(path).toLowerCase();
  return SPEC_GLOBS.some((glob) => name.endsWith(glob.slice(1))) && !isTestPath(path);
}

/** The commit search for spec files (`readSnapshot`'s `documents`). */
export const SPEC_SEARCH: ContentSearch = {
  pattern: SPEC_KEY_ERE,
  globs: SPEC_GLOBS,
  accepts: isSpecCandidate,
  max: MAX_SPEC_FILES,
  holding: "an openapi or swagger key",
};

/** Whether the text has a spec's top-level key, before it is parsed. */
export function mayBeSpec(text: string): boolean {
  return SPEC_KEY.test(text);
}

/**
 * The spec's operations; `undefined` when the file is not a spec (no `openapi: 3…` or `swagger: "2.0"` with `paths`).
 * Throws an error when the file is not valid YAML or JSON.
 */
export function readOpenApiSpec(text: string): OpenApiSpec | undefined {
  const lineCounter = new LineCounter();
  // No check for repeated keys: the library compares every map key with every other, and the file comes from the repo (§8).
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false });
  const [error] = doc.errors;
  if (error) throw new Error(error.message);
  const root = doc.contents;
  if (!isMap(root) || !isSpecVersion(root)) return undefined;
  const paths = get(root, "paths");
  if (!isMap(paths)) return undefined;
  const reader = new SpecReader(root, lineCounter);
  const info = get(root, "info");
  return {
    title: (isMap(info) ? scalarText(get(info, "title")) : undefined) ?? null,
    basePath: basePath(root),
    ...reader.operations(paths),
  };
}

function isSpecVersion(root: YAMLMap): boolean {
  const openapi = scalarText(get(root, "openapi"));
  // `swagger: 2.0` without quotes is the number 2.
  const swagger = scalarText(get(root, "swagger"));
  return openapi?.startsWith("3") === true || swagger === "2.0" || swagger === "2";
}

/**
 * The path part of the first server address, with `{variables}` replaced by their defaults (OpenAPI 3), or `basePath`
 * (Swagger 2); `""` without one. The address can be absolute (`https://api.example.com/v1`) or relative (`/v1`).
 */
function basePath(root: YAMLMap): string {
  const swagger = scalarText(get(root, "basePath"));
  if (swagger !== undefined) return swagger;
  const servers = get(root, "servers");
  const server = isSeq(servers) ? servers.items[0] : undefined;
  if (!isMap(server)) return "";
  const variables = get(server, "variables");
  const url = (scalarText(get(server, "url")) ?? "").replace(/\{([^{}]{1,64})\}/g, (whole, name: string) => {
    const variable = isMap(variables) ? get(variables, name) : undefined;
    return (isMap(variable) ? scalarText(get(variable, "default")) : undefined) ?? whole;
  });
  return httpUrlPath(url);
}

class SpecReader {
  private readonly root: YAMLMap;
  private readonly lineCounter: LineCounter;

  constructor(root: YAMLMap, lineCounter: LineCounter) {
    this.root = root;
    this.lineCounter = lineCounter;
  }

  operations(paths: YAMLMap): Pick<OpenApiSpec, "operations" | "truncated"> {
    const all = paths.items.flatMap((item) => {
      const path = isScalar(item.key) ? String(item.key.value) : "";
      return path.startsWith("/") && isMap(item.value) ? this.pathOperations(joinHttpPath(path), item.value) : [];
    });
    return { operations: all.slice(0, MAX_OPERATIONS), truncated: all.length > MAX_OPERATIONS };
  }

  /** The operations of one path item, by its HTTP method keys (`trace` and extensions such as `x-…` are not methods). */
  private pathOperations(path: string, item: YAMLMap): SpecOperation[] {
    return item.items.flatMap((pair) => {
      const key = isScalar(pair.key) ? pair.key : undefined;
      const method = key ? HTTP_METHODS[String(key.value).toLowerCase()] : undefined;
      if (method === undefined || !isMap(pair.value)) return [];
      return [this.operation(method, path, pair.value, this.lineCounter.linePos(key?.range?.[0] ?? 0).line)];
    });
  }

  private operation(method: HttpMethod, path: string, op: YAMLMap, line: number): SpecOperation {
    return {
      method,
      path,
      id: scalarText(get(op, "operationId")) ?? null,
      summary: summaryOf(op),
      request: this.requestType(op),
      response: this.responseType(op),
      line,
    };
  }

  /** The JSON body schema of `requestBody` (OpenAPI 3) or of the `in: body` parameter (Swagger 2). */
  private requestType(op: YAMLMap): string | null {
    const body = this.follow(get(op, "requestBody"));
    if (body !== undefined) return this.contentType(body);
    const parameters = get(op, "parameters");
    const param = isSeq(parameters) ? parameters.items.find((p) => isMap(p) && scalarText(get(p, "in")) === "body") : undefined;
    return isMap(param) ? schemaType(get(param, "schema"), 0) : null;
  }

  /** The body schema of the first 2xx response (`200`, `201`, `2XX`), in the order of the file. */
  private responseType(op: YAMLMap): string | null {
    const responses = get(op, "responses");
    if (!isMap(responses)) return null;
    const success = responses.items.find((pair) => isScalar(pair.key) && String(pair.key.value).startsWith("2"));
    const response = this.follow(isNode(success?.value) ? success.value : undefined);
    if (response === undefined) return null;
    return isMap(get(response, "content")) ? this.contentType(response) : schemaType(get(response, "schema"), 0);
  }

  /** The schema of the JSON media type in `content` (`application/json`, `application/problem+json`), else of the first one. */
  private contentType(holder: YAMLMap): string | null {
    const content = get(holder, "content");
    if (!isMap(content)) return null;
    const json = content.items.find((pair) => isScalar(pair.key) && String(pair.key.value).includes("json")) ?? content.items[0];
    return isMap(json?.value) ? schemaType(get(json.value, "schema"), 0) : null;
  }

  /** A map, following local references (`#/components/responses/NotFound`); `undefined` when it leads nowhere in this file. */
  private follow(node: Node | undefined): YAMLMap | undefined {
    let current = node;
    for (let hop = 0; hop <= MAX_REF_HOPS; hop++) {
      if (!isMap(current)) return undefined;
      const ref = scalarText(get(current, "$ref"));
      if (ref === undefined) return current;
      current = ref.startsWith("#/") ? this.at(ref.slice(2).split("/").map(unescapePointer)) : undefined;
    }
    return undefined;
  }

  private at(keys: readonly string[]): Node | undefined {
    let current: Node | undefined = this.root;
    for (const key of keys) current = isMap(current) ? get(current, key) : undefined;
    return current;
  }
}

/**
 * A schema in type notation like the card's (`Order`, `List<Order>`, `Map<string, Order>`, `string`): a reference by the
 * last part of its address, an array by its items, an object with `additionalProperties` as a map, a scalar by its
 * `type`, `allOf`/`oneOf`/`anyOf` with one schema by it; `object` for an inline object, `null` without a schema.
 */
function schemaType(node: Node | undefined, depth: number): string | null {
  if (!isMap(node)) return null;
  if (depth > MAX_SCHEMA_DEPTH) return "object";
  const ref = scalarText(get(node, "$ref"));
  if (ref !== undefined) return refName(ref);
  const type = scalarText(get(node, "type"));
  if (type === "array") return `List<${schemaType(get(node, "items"), depth + 1) ?? "object"}>`;
  const extra = get(node, "additionalProperties");
  if (type === "object" && isMap(extra)) return `Map<string, ${schemaType(extra, depth + 1) ?? "object"}>`;
  if (type !== undefined) return type;
  const only = singleComposed(node);
  if (only !== undefined) return schemaType(only, depth + 1);
  return isMap(get(node, "properties")) ? "object" : null;
}

/** The one schema of `allOf`, `oneOf` or `anyOf` with exactly one; `undefined` otherwise. */
function singleComposed(node: YAMLMap): Node | undefined {
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    const list = get(node, key);
    const [only] = isSeq(list) && list.items.length === 1 ? list.items : [];
    if (isNode(only)) return only;
  }
  return undefined;
}

/** `#/components/schemas/Order` and `models.yaml#/Order` → `Order`; a file reference without a pointer by its name. */
function refName(ref: string): string {
  const hash = ref.indexOf("#");
  if (hash < 0) return stemOf(ref);
  return (
    unescapePointer(
      ref
        .slice(hash + 1)
        .split("/")
        .at(-1) ?? "",
    ) || stemOf(ref.slice(0, hash))
  );
}

function unescapePointer(part: string): string {
  return part.replaceAll("~1", "/").replaceAll("~0", "~");
}

function summaryOf(op: YAMLMap): string | null {
  const text = scalarText(get(op, "summary")) ?? scalarText(get(op, "description"))?.split("\n")[0];
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_SUMMARY_LENGTH ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : trimmed;
}

function get(map: YAMLMap, key: string): Node | undefined {
  const value = map.items.find((p) => isScalar(p.key) && String(p.key.value) === key)?.value;
  return isNode(value) ? value : undefined;
}

function scalarText(node: Node | undefined): string | undefined {
  return isScalar(node) && node.value !== null && node.value !== undefined ? String(node.value) : undefined;
}
