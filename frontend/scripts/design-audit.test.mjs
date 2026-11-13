import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, isGovernedPath, parseAddedLines, violations } from "./design-audit-rules.mjs";

test("only app UI sources are governed; one canonical palette file is exempt", () => {
  assert.equal(isGovernedPath("frontend/src/app/page.tsx"), true);
  assert.equal(isGovernedPath("frontend/src/styles/design-tokens.css"), false);
  assert.equal(isGovernedPath("frontend/src/lib/api-types.generated.ts"), false);
  assert.equal(isGovernedPath("extension/src/ui.tsx"), false);
});

test("detect raw palette, hardcoded typography, shadow and layer", () => {
  const path = "frontend/src/components/new-widget.tsx";
  assert.deepEqual(violations('className="bg-orange-500 text-[13px] z-50"', path), [
    "tailwind-palette", "pixel-font", "arbitrary-layer",
  ]);
  assert.deepEqual(violations('color: #ff4f00; box-shadow: 0 2px 8px #000;', path), [
    "literal-color", "arbitrary-shadow",
  ]);
  assert.deepEqual(violations('className="rounded-[9px] shadow-[0_1px_4px_#000]"', path), [
    "literal-color", "arbitrary-radius", "arbitrary-shadow",
  ]);
  assert.deepEqual(violations('color: var(--ou-color-orange);', path), []);
  assert.deepEqual(violations('/* historical color #ffffff is a comment */', path), []);
});

test("diff parser uses new-file line numbers and ignores removed lines", () => {
  const diff = [
    "diff --git a/frontend/src/app/page.tsx b/frontend/src/app/page.tsx",
    "--- a/frontend/src/app/page.tsx",
    "+++ b/frontend/src/app/page.tsx",
    "@@ -6,1 +6,2 @@",
    "-const old = true;",
    "+const modern = true;",
    "+const title = '#fff';",
    "diff --git a/docs/file.md b/docs/file.md",
    "--- /dev/null",
    "+++ b/docs/file.md",
    "@@ -0,0 +1 @@",
    "+# heading",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "frontend/src/app/page.tsx", number: 6, line: "const modern = true;" },
    { file: "frontend/src/app/page.tsx", number: 7, line: "const title = '#fff';" },
  ]);
});

test("orange ink passes normal text contrast; orange white text does not", () => {
  assert.ok(contrastRatio("#FF4F00", "#201515") >= 4.5);
  assert.ok(contrastRatio("#FF4F00", "#FFFFFF") < 4.5);
  assert.throws(() => contrastRatio("#aaa", "#ffffff"));
});
