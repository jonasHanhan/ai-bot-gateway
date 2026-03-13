# Codex Discord Bridge

[![Codex Discord Bridge Hero](public/images/cover_new.png)](https://youtu.be/RRF-F5jDS50)

Personal Discord bridge for Codex app-server.

## What It Does

- Auto-discovers existing project paths (`cwd`) from Codex via `thread/list`.
- Creates/manages one Discord text channel per discovered project.
- Keeps all managed project channels under the `codex-projects` category.
- Persists one Codex thread binding per repo channel:
  - repo text channel -> one Codex app-server thread
- Queues messages per repo channel (one active turn per channel).
- Emits assistant output as paragraph messages (no single-message edit loop).
- Emits separate status messages for non-agent items (tools/commands/etc.).
- Handles approval requests via buttons (with command fallback).
- Uploads attachment files for configured item types (default: `imageView`, `toolCall`, `mcpToolCall`, `commandExecution`).

## Architecture Map

```text
src/index.js                  Thin runtime entrypoint (`startMainRuntime`)
src/app/mainRuntime.js        Compose runtime context + process runner
src/app/loadRuntimeBootstrapConfig.js Env/config/state bootstrap loading
src/app/buildRuntimeGraph.js  Build core runtime services/adapters/turn runner
src/app/runBridgeProcess.js   Wire listeners/runtimes/startup/shutdown flow
src/config/loadConfig.js      Env + channel config loading/normalization
src/channels/context.js       Channel/repo context and bindings
src/codexRpcClient.js         Codex app-server transport
src/codex/turnRunner.js       Per-channel queue and turn lifecycle
src/codex/notificationMapper.js Normalized notification boundaries
src/codex/approvalPayloads.js Approval request/response mapping
src/attachments/service.js    Attachment candidate extraction + upload policy
src/render/messageRenderer.js Message render plan, redaction, chunking
src/cli/**                    Operator CLI (`status`, `doctor`, `start`, `stop`, `reload`, `logs`)
src/app/main.ts               TS bootstrap entry used by `start:ts`
src/types/**                  TS boundary contracts for cutover
```

## Requirements

- Bun 1.2+
- `codex` CLI installed on the host and authenticated
- Discord bot token with:
  - `MESSAGE CONTENT INTENT` enabled in the Discord developer portal
  - channel read/send permissions in your server
- Discord guild (server) id

## Setup

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create env file:

   ```bash
   cp .env.example .env
   ```

3. (Optional) add `config/channels.json` for overrides:

   ```bash
   cp config/channels.example.json config/channels.json
   ```

4. Start the bot:

   ```bash
   bun run start
   ```

On startup, the bot:

- queries Codex app-server (`thread/list`) for known `cwd` values
- ensures a `codex-projects` category exists
- creates/moves managed project channels under that category
- tags managed channels with topic `codex-cwd:<absolute-path>`

## Commands

- `!help` show available bot commands
- `!ask <prompt>` send a prompt in the current repo channel
- `!initrepo [force]` initialize/bind this channel to a local repo path using the channel name
- `!mkchannel <name>` create a new Discord text channel
- `!mkrepo <name>` create a new Discord text channel and bind a new project directory under `DISCORD_REPO_ROOT/<name>`
- `!mkbind <name> <absolute-path>` create a new Discord text channel and bind it to a local repo/path
- `!bind <absolute-path>` bind this channel to an existing local repo/path
- `!rebind <absolute-path>` switch this channel to a different existing local repo/path
- `!unbind` remove the repo/path binding from this channel
- `!setmodel <model>` set an explicit model override for the current repo channel
- `!clearmodel` remove the channel model override and use the global default model
- `!status` show queue and binding state
- `!new` clear stored Codex thread binding for the current channel
- `!restart [reason]` request host-managed restart and receive a post-restart confirmation on the same status message
- `!interrupt` request turn interruption for the current channel
- `!where` show bot paths/config/thread binding for this channel
- `!approve [id]` approve latest pending request in the channel (or specific id)
- `!decline [id]` decline latest pending request in the channel (or specific id)
- `!cancel [id]` cancel latest pending request in the channel (or specific id)
- `!resync` non-destructive sync: discover/add/move/prune managed channels
- `!rebuild` destructive rebuild: delete managed channels/bindings and recreate project channels from discovery
- Plain message in a managed repo channel is treated as a prompt

## Operator CLI

- `bun run cli status` shows runtime paths, binding count, and heartbeat status.
- `bun run cli start` bootstraps/enables/kickstarts the launchd service (`com.codex.discord.bridge` by default).
- `bun run cli stop` stops the launchd service via `bootout`.
- `bun run cli logs` tails active bridge stdout/stderr logs (same paths used by launchd when configured).
  - Supports `--clear` and `--since <10m|2h|iso>` for faster incident triage.
- `bun run cli config-validate` validates channel/env config and reports effective defaults.
- `bun run cli doctor` runs operational diagnostics (token/writable paths/attachment roots).
- `bun run cli reload [reason]` writes a restart intent file for host-managed supervisors.
- `bun run cli restart [reason]` alias for `reload`.
- `scripts/restart-supervisor.sh -- bun run start` runs a host-side process loop that watches `data/restart-request.json` and restarts the bridge externally (with throttle/backoff).
- Optional global command from any directory:
  - Run `npm link` once in this repo.
  - Then use `dc-bridge start`, `dc-bridge stop`, `dc-bridge status`, `dc-bridge logs`, `dc-bridge restart "manual restart"`, etc.

## Stability Checks

- `bun run verify` runs `typecheck + lint + test`.
- `bun run test:stability` runs the restart/recovery/transcript/approval integration stability suite.

## Permanent Service Notes

- For `launchd`, make sure `ProgramArguments` includes the absolute Bun path after `--`:
  - `scripts/restart-supervisor.sh -- /absolute/path/to/bun run start`
- If `ProgramArguments` accidentally inserts an empty entry, supervisor now fails fast with a clear error.
- Include both Bun and Codex paths in launchd env when needed:
  - `PATH` should include Bun install dir and Codex install dir.
  - You can set `CODEX_BIN` explicitly in `EnvironmentVariables`.
- Supervisor now clears `data/restart-request.json` after consuming a restart request to avoid repeated restarts from stale files.


## Notes

- This bot uses `codex app-server` over `stdio` and sends `initialize` + `initialized`.
- `config/channels.json` is optional. Use it for overrides like `defaultModel`, `defaultEffort`, `allowedUserIds`, or fixed channel mappings.
- `DISCORD_ALLOWED_USER_IDS` (comma-separated) overrides `channels.json` and is recommended for strict access control.
- `DISCORD_REPO_ROOT` sets where `!initrepo` creates repos (channel-name folder under this root).
- `!mkrepo` also uses `DISCORD_REPO_ROOT`; it creates the project folder from the final channel name and binds the new channel without running `git init`, so you can clone into it later.
- `!mkchannel` / `!mkbind` require the bot to have Discord `Manage Channels` permission.
- `!bind` / `!rebind` update the live channel mapping and persist the `codex-cwd:` topic tag so bindings survive restarts without editing `channels.json`.
- `!setmodel` persists a per-channel model override; `!clearmodel` removes it so the channel uses `defaultModel` again.
- `CODEX_APPROVAL_POLICY` controls write/command approval prompts. Defaults to `never` in this bot (`untrusted`, `on-failure`, `on-request`, `never`).
- `CODEX_SANDBOX_MODE` controls sandbox mode. Defaults to `workspace-write` in this bot (`read-only`, `workspace-write`, `danger-full-access`).
- In `workspace-write`, the bot now auto-adds Git metadata roots (`--git-dir`, `--git-common-dir`) to writable roots so commits work in worktrees too.
- `CODEX_EXTRA_WRITABLE_ROOTS` (colon-separated absolute paths) lets you add extra writable roots if your repo/tooling stores state elsewhere.
- State is kept in `data/state.json` (`threadBindings` keyed by repo channel id).
- Project channels are managed under `codex-projects` by default. Override with `DISCORD_PROJECTS_CATEGORY_NAME`.
- Image attachments are forwarded into Codex turns as image inputs (downloaded locally by the bot).
- `DISCORD_ENABLE_ATTACHMENTS` toggles outgoing attachment uploads (defaults to enabled).
- `DISCORD_ATTACHMENT_INFER_FROM_TEXT` enables inferred uploads from path mentions in tool output text (default: disabled; set to `1` to enable fallback mode).
- `DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN` caps "attachment missing/blocked/etc." notices per turn (default: `1`; read-only/general mode forces `0`).
- `DISCORD_ATTACHMENT_MAX_BYTES` caps attachment size (default: 8MB).
- `DISCORD_ATTACHMENT_ROOTS` (colon-separated absolute paths) allowlists attachment file locations.
- `DISCORD_ATTACHMENT_ITEM_TYPES` (comma-separated) sets which item types upload files (default: `imageView,toolCall,mcpToolCall,commandExecution`).
- `DISCORD_RENDER_VERBOSITY` controls status-line noise (`user` default, `ops`, `debug`).
- `DISCORD_DEBUG_LOGGING=1` enables detailed turn/item/message-edit debug logs.
- `DISCORD_HEARTBEAT_PATH` sets the bridge heartbeat file path (default: `data/bridge-heartbeat.json`).
- `DISCORD_HEARTBEAT_INTERVAL_MS` sets heartbeat write interval (default: `30000`, min effective `5000`).
- `DISCORD_RESTART_REQUEST_PATH` sets CLI reload signal file path (default: `data/restart-request.json`).
- `DISCORD_RESTART_ACK_PATH` sets the host-ack marker path written by supervisor (default: `data/restart-ack.json`).
- `DISCORD_RESTART_NOTICE_PATH` sets pending Discord restart notice state path (default: `data/restart-discord-notice.json`).
- `DISCORD_INFLIGHT_RECOVERY_PATH` sets persisted in-flight turn recovery path (default: `data/inflight-turns.json`).
- `DISCORD_EXIT_ON_RESTART_ACK=1` lets bridge self-exit after ack marker detection (disabled by default).
- `DISCORD_STDOUT_LOG_PATH` overrides CLI `logs` stdout file path (otherwise launchd plist or `/tmp/codex-discord-bridge.out.log`).
- `DISCORD_STDERR_LOG_PATH` overrides CLI `logs` stderr file path (otherwise launchd plist or `/tmp/codex-discord-bridge.err.log`).
- `DISCORD_LAUNCHD_LABEL` overrides the launchd label used by `dc-bridge start|stop` (default from plist `Label`, fallback `com.codex.discord.bridge`).
