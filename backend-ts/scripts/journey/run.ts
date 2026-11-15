// CLI: run one journey scenario on the TS backend, then grade it.
//   npx tsx scripts/journey/run.ts --scenario full                 (mock: scripted model, no key)
//   npx tsx scripts/journey/run.ts --scenario full --mode real     (OFFERU_LLM_BASE_URL / _API_KEY / _MODEL)
//   npx tsx scripts/journey/run.ts --grade <run dir>               (re-grade a recorded run, no model)
// Options: --attempt N, --out DIR (default <tmp>/offeru-journey), --renderer stub|playwright, --seed-only.

import { gradeRun } from "./grade";
import { runJourney, type JourneyMode } from "./harness";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const regrade = arg("grade");
  if (regrade) {
    const grade = await gradeRun(regrade);
    process.exitCode = grade.summary.fail ? 1 : 0;
    return;
  }
  const mode = arg("mode", "mock") as JourneyMode;
  if (mode !== "mock" && mode !== "real") throw new Error("--mode 只能是 mock 或 real");
  const renderer = arg("renderer") as "stub" | "playwright" | "";
  const { root, meta } = await runJourney({
    scenario: arg("scenario", "full"),
    mode,
    attempt: Number(arg("attempt", "1")),
    out: arg("out") || undefined,
    renderer: renderer || undefined,
    seedOnly: process.argv.includes("--seed-only"),
  });
  console.log(root);
  if (meta.mode === "manual") return;
  if (meta.mock_problems?.length) console.log("mock 脚本问题：", meta.mock_problems);
  const grade = await gradeRun(root);
  process.exitCode = grade.summary.fail ? 1 : 0;
}

main().catch((cause) => {
  console.error(cause);
  process.exitCode = 2;
});
