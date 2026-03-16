import process from "node:process";
import { runCapabilitiesCommand } from "./commands/capabilities.js";
import { runConfigValidateCommand } from "./commands/config-validate.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runLogsCommand } from "./commands/logs.js";
import { runReloadCommand } from "./commands/reload.js";
import { runStartCommand, runStopCommand } from "./commands/service.js";
import { runStatusCommand } from "./commands/status.js";
import type { CliCommand, CliContext } from "../types/events.js";

const commands: Record<string, CliCommand["run"]> = {
  status: runStatusCommand,
  logs: runLogsCommand,
  start: runStartCommand,
  stop: runStopCommand,
  reload: runReloadCommand,
  restart: runReloadCommand,
  capabilities: runCapabilitiesCommand,
  "config-validate": runConfigValidateCommand,
  doctor: runDoctorCommand
};

function printUsage(): void {
  console.log(
    [
      "Usage: bun run src/cli/index.ts <command>",
      "",
      "Commands:",
      "  status            Show runtime paths, binding count, and heartbeat summary",
      "  logs              Tail active bridge logs (stdout/stderr)",
      "  start             Start launchd service (bootstrap+enable+kickstart)",
      "  stop              Stop launchd service (bootout)",
      "  reload [reason]   Write host-managed restart request signal file",
      "  restart [reason]  Alias for reload",
      "  capabilities      Show platform + agent capability matrix (use --compact for concise rows)",
      "  config-validate   Validate channel/env config",
      "  doctor            Run operational diagnostics"
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const [, , commandNameRaw, ...args] = process.argv;
  const commandName = (commandNameRaw ?? "").trim().toLowerCase();
  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    printUsage();
    return;
  }

  const command = commands[commandName];
  if (!command) {
    console.error(`Unknown command: ${commandName}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const context: CliContext = {
    cwd: process.cwd(),
    now: new Date()
  };
  const result = await command(args, context);
  const level = result.ok ? "info" : "error";
  const payload = {
    level,
    command: commandName,
    message: result.message,
    details: result.details ?? {},
    at: context.now.toISOString()
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

void main();
