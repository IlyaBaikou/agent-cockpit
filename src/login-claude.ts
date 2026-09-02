import { spawn } from "node:child_process";
import { resolveClaudeBinary } from "./agents/claude.js";

const binary = await resolveClaudeBinary();
console.log(`Starting Claude Code login via ${binary}`);

const child = spawn(binary, ["auth", "login"], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
