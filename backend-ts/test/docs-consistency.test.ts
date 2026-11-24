// Install docs and the Agent Skill must match the TypeScript runtime: no retired Python install
// paths, every `offeru <command>` is a real CLI command, every `npm run <script>` exists, tool
// names in the Skill are real tools, and the Skill copies agents load are identical.
// Runs with the backend tests, so a stale doc fails CI instead of a user's first run.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_TOOL_SPECS, ALL_TOOL_SPECS, DOC_KIND, type JsonSchema } from "@offeru/core";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The canonical Skill (bundled with the companion) and the copies agents read from the repo. */
const SKILL = "backend-ts/skill/SKILL.md";
const SKILL_COPIES = [".agents/skills/offeru/SKILL.md", ".claude/skills/offeru/SKILL.md", ".copilot/SKILL.md"];
const DOCS = [
  SKILL,
  ...SKILL_COPIES,
  "README.md",
  "README_ZH.md",
  "AGENTS.md",
  "docs/DEVELOPMENT.md",
  "docs/ARCHITECTURE.md",
  "docs/DESIGN.md",
  "docs/DEPLOY-CLOUDFLARE.md",
  "backend-ts/README.md",
  "frontend/src/lib/agentConnectionPrompt.ts",
  "frontend/src/components/workbench/DemoBridgeDialog.tsx",
].filter((path) => existsSync(join(ROOT, path)));

/** Python-era install paths that no longer exist after the TS migration (#216). */
const RETIRED = [/uv tool install/, /\buvx\b/, /\.whl\b/, /py3-none-any/, /\bpipx?\s+install\b/, /offeru-\d+\.\d+\.\d+-py3/];

/** `offeru <command>` the CLI (src/cli.ts) actually dispatches. */
function cliCommands(): Set<string> {
  const source = read("backend-ts/src/cli.ts");
  return new Set([...source.matchAll(/command === "([\w-]+)"/g)].map((match) => match[1]));
}

function npmScripts(dir: string): Set<string> {
  return new Set(Object.keys((JSON.parse(read(join(dir, "package.json"))) as { scripts?: Record<string, string> }).scripts ?? {}));
}

/** Field names and enum values the tool schemas declare. */
function schemaKeys(schema: JsonSchema | undefined, into: Set<string>): Set<string> {
  if (!schema || typeof schema !== "object") return into;
  for (const value of schema.enum ?? []) if (typeof value === "string") into.add(value);
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    into.add(key);
    schemaKeys(sub, into);
  }
  for (const sub of [...(schema.anyOf ?? []), ...Object.values(schema.$defs ?? {}), schema.items]) schemaKeys(sub as JsonSchema, into);
  return into;
}

describe("install docs and Skill match the TS runtime", () => {
  it("every Skill copy is the canonical backend-ts/skill/SKILL.md", () => {
    const canonical = read(SKILL);
    for (const copy of SKILL_COPIES) expect(read(copy), copy).toBe(canonical);
  });

  it("no doc tells users to install the retired Python package", () => {
    const hits = DOCS.flatMap((path) => RETIRED.filter((pattern) => pattern.test(read(path))).map((pattern) => `${path}: ${pattern}`));
    expect(hits).toEqual([]);
  });

  it("every documented `offeru <command>` exists in the CLI", () => {
    const known = cliCommands();
    expect(known.has("start") && known.has("recipe") && known.has("tool") && !known.has("mcp")).toBe(true);
    const hits: string[] = [];
    for (const path of DOCS) {
      for (const match of read(path).matchAll(/(?<![\w/.-])offeru(?:-ts)? ([a-z][\w-]*)/g)) {
        if (!known.has(match[1])) hits.push(`${path}: offeru ${match[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("every documented `npm run <script>` exists in that package", () => {
    const hits: string[] = [];
    for (const path of DOCS) {
      for (const match of read(path).matchAll(/npm (?:--prefix ("?[^\s"]+"?) )?run (?:--silent )?([\w:-]+)/g)) {
        const prefix = (match[1] ?? "").replace(/"/g, "").replace(/^\$PWD\/|^<仓库>\//, "");
        const dirs = prefix ? [prefix] : ["backend-ts", "frontend"];
        if (!dirs.some((dir) => existsSync(join(ROOT, dir, "package.json")) && npmScripts(dir).has(match[2]))) {
          hits.push(`${path}: npm ${prefix ? `--prefix ${prefix} ` : ""}run ${match[2]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("tool names the Skill mentions are tools agents can call", () => {
    const tools = new Set(AGENT_TOOL_SPECS.map((spec) => spec.name));
    const fields = new Set<string>(Object.keys(DOC_KIND));
    for (const spec of ALL_TOOL_SPECS) schemaKeys(spec.inputSchema, fields);
    const prose = read(SKILL).replace(/https?:\/\/\S+/g, "");
    const unknown = [...new Set([...prose.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]))]
      .filter((word) => !tools.has(word) && !fields.has(word));
    expect(unknown).toEqual([]);
  });
});
