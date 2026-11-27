#!/usr/bin/env node
// Usage: node scripts/with-env.mjs <command> [args...]
//
// Runs a command with the repository's root .env loaded. Variables that are
// already set — even to an empty string — win, so the shell, CI, docker
// compose and test harnesses keep the final say. Without a .env file the
// command runs unchanged.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import * as util from "node:util";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/with-env.mjs <command> [args...]");
  process.exit(2);
}

const envFile = new URL("../.env", import.meta.url);
const env = { ...process.env };
let content;
try {
  content = readFileSync(envFile, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (content !== undefined) {
  if (typeof util.parseEnv === "function") {
    for (const [key, value] of Object.entries(util.parseEnv(content))) {
      if (env[key] === undefined) env[key] = value;
    }
  } else {
    console.warn("with-env: .env was not loaded because it needs Node.js 20.12 or later; export its variables instead.");
  }
}

// npm-style .cmd shims on Windows only run through a shell.
const child = spawn(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on("error", (error) => {
  console.error(`with-env: could not run ${command}: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // Exit the way the command did, so supervisors see the same status.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    return;
  }
  process.exit(code ?? 1);
});
