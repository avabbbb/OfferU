// Bundle the Node companion into plain ESM files that the packaged desktop app (bundled Node)
// and the lite package run without tsx, npm or a source checkout:
//   <out>/server.mjs   HTTP companion (desktop sidecar entry; listens on OFFERU_PORT)
//   <out>/cli.mjs      offeru CLI: tool / mcp / serve / start / doctor (the Skill's <offeru> command)
//   <out>/assets/school_logos, <out>/skill/SKILL.md
//   <out>/node_modules/playwright-core   (optional dependency, loaded with a dynamic import for PDF export)
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendTs = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleCompanion(out) {
  const { build } = await import("esbuild");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    absWorkingDir: backendTs,
    entryPoints: { server: "src/server-main.ts", cli: "src/cli.ts" },
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    legalComments: "linked",
    external: ["playwright-core", "node:sqlite"],
    // CommonJS dependencies (jpeg-js, fast-png...) call require() for builtins.
    banner: { js: "import { createRequire as __offeruCreateRequire } from 'node:module'; const require = __offeruCreateRequire(import.meta.url);" },
    logLevel: "warning",
  });
  cpSync(join(backendTs, "assets/school_logos"), join(out, "assets/school_logos"), { recursive: true });
  cpSync(join(backendTs, "skill/SKILL.md"), join(out, "skill/SKILL.md"));
  const playwright = join(backendTs, "node_modules/playwright-core");
  // Docs are not needed at runtime (and the Agent-skill markdown in it carries sample e-mail addresses).
  if (existsSync(playwright)) cpSync(playwright, join(out, "node_modules/playwright-core"), { recursive: true, dereference: true, filter: (src) => !src.endsWith(".md") });
  else console.warn("playwright-core is not installed: the bundle will answer PDF export with 501.");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] || join(backendTs, "../.tmp/ts-sidecar"));
  await bundleCompanion(out);
  console.log(`Bundled the OfferU companion into ${out}`);
}
