// Neutral-cwd launcher for the OfferU DSH profile.
// Usage: node launch-offeru.mjs  (env: DSH_HOME, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL,
//        OFFERU_BRIDGE_TOKEN, OFFERU_BACKEND_DIR optional)
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dshBin = join(here, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
process.chdir("C:/Users/ava"); // neutral invoking directory; no .env walk hits the repo

const port = process.env.DSH_PORT || "3737"; // outside winnat exclusion ranges
const child = spawn(
	process.execPath,
	[dshBin, "--profile", "offeru", "--no-open", "--port", port],
	{
		stdio: "inherit",
		env: process.env,
	},
);
child.on("exit", (code) => process.exit(code ?? 0));
