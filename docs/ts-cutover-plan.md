# TypeScript + Architecture Cutover Plan (Living Document)

Status: Draft (active)  
Owner: codex-discord-bridge  
Branch: `feature/ts-cutover-chat-sdk-patterns`  
Last updated: 2026-02-28

## Why This Exists

We need a step-by-step cutover from the current single-file JavaScript bridge to a TypeScript, modular architecture that is easier to reason about, test, and evolve.

Primary reference patterns:
- Vercel Chat SDK Discord adapter docs
- Chat SDK usage model (thread/event based APIs)
- Chat SDK file upload model (explicit file payloads, not path scraping heuristics)

## Goals

1. Move runtime code from JS to TS with strict typing around event payloads and approvals.
2. Replace monolithic `src/index.js` behavior with modular domain-focused services.
3. Reduce attachment flakiness/spam by using explicit upload intent paths and typed attachment pipeline.
4. Preserve existing Discord bridge behavior while incrementally improving reliability.

## Non-Goals

1. Full migration to Vercel's Next.js Chatbot template.
2. Introducing web auth/db stacks (Auth.js/Postgres/Redis/Vercel Blob) into this bridge.
3. Breaking current bot command surface during migration.
4. Letting in-sandbox Codex directly kill/restart arbitrary host processes.

## Current Snapshot (Baseline)

- Core runtime is concentrated in `src/index.js`.
- Responsibilities currently mixed together:
  - Discord event intake
  - Command routing
  - Codex RPC orchestration
  - Queue + turn lifecycle management
  - Approval workflows
  - Attachment extraction/upload
  - Status rendering and stream updates

This coupling is the primary source of regressions when changing media behavior.

## Target Architecture (Proposed)

```text
src/
  app/
    main.ts                      # process bootstrap, wiring
  config/
    env.ts                       # zod-validated env
    runtime-config.ts            # derived config
  discord/
    client.ts                    # discord.js client creation
    message-router.ts            # message -> command/chat route
    interaction-router.ts        # button/approval interactions
  codex/
    rpc-client.ts                # codex app-server transport wrapper
    turn-runner.ts               # queue + turn start/resume/finalize
    notifications.ts             # item/turn event handling
    approvals.ts                 # approval request/response mapping
  attachments/
    intake.ts                    # incoming attachment parsing/download
    extraction.ts                # explicit path extraction rules
    upload.ts                    # outbound upload service
    policy.ts                    # roots, size, mime/ext policy
  channels/
    context.ts                   # repo/general context resolution
    bootstrap.ts                 # channel discovery/sync/rebuild
  state/
    thread-bindings.ts           # persistent channel<->thread state
    in-memory.ts                 # runtime trackers
  domain/
    types.ts                     # shared domain types
    errors.ts                    # normalized error types
  utils/
    text.ts
    paths.ts
    ids.ts
  cli/
    index.ts                     # `codex-bridge` command entrypoint
    commands/
      status.ts                  # health, pid metadata, version
      reload.ts                  # request host-managed restart
      config-validate.ts         # env + channel config checks
      doctor.ts                  # diagnostics (permissions, roots, token presence)
    host-control/
      restart-request.ts         # writes restart intent signal
      systemd.ts                 # optional host adapter
      launchd.ts                 # optional host adapter
      pm2.ts                     # optional host adapter
```

## Design Rules (Borrowed from Chat SDK Patterns)

1. Explicit intent beats heuristics.
   - File uploads should be triggered by structured payloads first.
   - Text scraping is optional fallback behind config flag.

2. Event-driven boundaries.
   - Route events to small handlers (`onMessage`, `onNotification`, `onApproval`) rather than one giant control flow.

3. Strongly typed message model.
   - Normalize Discord/Codex item shapes into internal TS types early.

4. Adapter-like contracts.
   - Keep Discord-specific code in `discord/`.
   - Keep Codex-specific code in `codex/`.

5. Operational actions must respect sandbox boundaries.
   - In-sandbox code can request restarts, but host supervisor performs restart.
   - No direct host process termination from bot turn logic.

## Messaging UX Learnings from Vercel Codebase

Compared sources:
- `vercel/ai-chatbot` UI/stream components
- `vercel/chat` docs for Discord + files + usage patterns

Observed patterns and how they compare to us:

1. One canonical message surface, many parts.
   - Vercel renders message "parts" (text, reasoning, tool output, file) inside one message container.
   - Our bridge currently emits many separate Discord status lines plus final text, which can feel noisy.
   - Cutover action: model outgoing bot responses as a typed render plan with "primary response" and optional compact status attachments.

2. Explicit attachment lifecycle with preview.
   - Vercel uses explicit file parts and upload queue states (`uploading`, `uploaded`, `failed`) instead of path guessing from random text.
   - Our current fallback scraping is useful but creates false positives and "Attachment missing" noise.
   - Cutover action: make explicit attachment intents first-class and move text scraping behind feature flag.
   - Preferred UX rule for inferred file paths in one assistant message: if multiple references to media paths appear, upload only the final referenced media file (last-match wins), not every mention.

3. Progressive disclosure for verbose internals.
   - Vercel tucks reasoning/tool details into dedicated components that can expand/collapse.
   - Our bridge often prints raw internals directly in-channel.
   - Cutover action: default to concise user-facing summary, expose verbose diagnostics only in debug mode or command (`!status verbose`).

4. Streaming UX avoids duplicate noise.
   - Vercel shows temporary "thinking/streaming" affordances and converges to stable final output.
   - We currently can duplicate image/status markers across lifecycle events.
   - Cutover action: enforce idempotent status updates per item key and suppress duplicate start/completed announcements unless state meaningfully changes.

5. Sanitization at render time.
   - Vercel sanitizes displayed text and keeps structured rendering boundaries.
   - We recently added path redaction; this should be formalized as a renderer policy, not ad hoc.
   - Cutover action: centralize output sanitization (absolute paths, tokens, raw stack traces) in one renderer module.

6. Typed event boundaries.
   - Vercel stream handlers operate over typed deltas; easier to test and reason about.
   - Our monolithic handler mixes parsing and side effects.
   - Cutover action: define discriminated unions for notification/item events and test transformation functions separately from IO.

## Phased Cutover Plan

## Phase 0: Baseline + Safety Rails

- [ ] Add this plan doc and keep it updated as decisions are made.
- [ ] Add lightweight architecture map to README (future).
- [ ] Define regression checklist for:
  - plain message routing
  - `!commands`
  - approvals
  - outgoing media upload
  - general channel read-only behavior

## Phase 1: TypeScript Tooling Without Behavioral Changes

- [x] Add `tsconfig.json` with strict mode.
- [x] Add `src/types/` domain declarations.
- [x] Keep runtime stable via incremental migration (`index.ts` wrapper if needed).
- [x] Ensure `bun run start` still works. (entrypoint remains `src/index.js`; TS wrapper added as `start:ts`)
- [x] Add CLI scaffold (`src/cli/index.ts`) with no-op command wiring.

## Phase 2: Extract Modules from `index.js` (Behavior-Preserving)

- [x] Extract `config` loading + validation.
- [x] Extract channel context/bootstrap logic.
- [x] Extract queue/turn lifecycle logic.
- [x] Extract approval handling.
- [x] Extract attachment service.
- [x] Extract a dedicated `message-renderer` module that builds user-facing output from typed turn/item events.

## Phase 3: Attachment Pipeline Hardening (Main Pain Point)

- [x] Introduce typed attachment intent enum:
  - `explicit_structured`
  - `explicit_user_request`
  - `inferred_text_fallback`
- [x] Default to explicit only; fallback via env flag.
- [x] Single per-turn issue reporting with dedupe keys.
- [x] Add upload-state model (`queued`, `uploading`, `uploaded`, `failed`) for internal telemetry and optional user-visible concise summaries.
- [x] Add "last-match wins" policy for inferred media references within a single assistant message/event:
  - when `.png/.jpg/...` appears multiple times in the same message content, only enqueue the final referenced path for upload.
  - keep explicit structured attachments unaffected (still upload all explicitly attached files).
- [x] Add clear telemetry/debug counters:
  - `attachments_detected`
  - `attachments_uploaded`
  - `attachments_skipped`
  - `attachments_failed`

## Phase 3.5: Messaging UX Pass (New)

- [x] Create typed renderer contract:
  - `primaryMessage` (required)
  - `statusMessages[]` (optional, deduped)
  - `attachments[]` (optional, explicit)
- [x] Add verbosity levels: `user`, `ops`, `debug`.
- [x] Gate noisy internals behind `DISCORD_DEBUG_LOGGING` or explicit commands.
- [x] Ensure "thinking/tooling" indicator remains singular and updates in place where possible.
- [ ] Add snapshot tests for representative turn transcripts (happy path + failures + approvals + file send).

## Phase 4: Discord + Codex Boundary Contracts

- [x] Define TS interfaces for Codex notifications/server requests.
- [x] Define TS interfaces for Discord message/interaction routes.
- [x] Create typed mapping layer rather than ad hoc object access.

## Phase 5: Tests + Reliability Gates

- [x] Unit tests for path/policy/extraction logic.
- [ ] Unit tests for approval decision mapping.
- [ ] Integration smoke test for one turn with outbound image upload.
- [ ] Add CI check: typecheck + test + lint.

## Phase 6: CLI + Restart Orchestration (New)

Problem:
- We want `codex-bridge` operations (status/validate/reload) for maintainers.
- Codex often runs in a sandbox that cannot terminate host processes.

Approach:
1. Add a repo-local CLI for operator workflows.
2. Use host-managed process supervision for restarts (`systemd`, `launchd`, or `pm2`).
3. CLI `reload` should create a restart intent signal, not kill the process directly.

Planned commands:
- [ ] `codex-bridge status`
  - show version, config path, state path, channel count, last heartbeat.
- [ ] `codex-bridge config validate`
  - validate env/config with zod; print actionable errors.
- [ ] `codex-bridge doctor`
  - check token presence, writable roots, attachment roots, channel intents.
- [ ] `codex-bridge reload`
  - write restart request file (for example: `data/restart-request.json`) with timestamp + reason.

Restart handshake design:
- [ ] Bridge emits heartbeat file periodically (for host monitor visibility).
- [ ] Host supervisor script watches restart-request signal and performs restart externally.
- [ ] Bridge optionally self-exits gracefully when restart request is acknowledged by host marker.
- [ ] Add backoff/lock to prevent restart loops.

Why this fits sandbox constraints:
- In-sandbox bot code only writes files in workspace-writable roots.
- Host-level restart remains out-of-band and controlled by operator tooling.

## Decision Log

| Date | Decision | Rationale | Status |
|------|----------|-----------|--------|
| 2026-02-28 | Keep current architecture (Discord bridge + Codex app-server) | Full template migration adds unrelated web-stack complexity | Decided |
| 2026-02-28 | Follow Chat SDK patterns, not full codebase migration | We need adapter/event/typing patterns, not Next.js app infra | Decided |
| 2026-02-28 | Prioritize attachment pipeline as first domain extraction | Highest regression frequency and user pain currently | Decided |
| 2026-02-28 | Branch `feature/ts-cutover-chat-sdk-patterns` | Isolate refactor from hotfix work | Decided |
| 2026-02-28 | Add dedicated messaging UX phase after attachment hardening | Current user pain is UX noise and mixed signal output | Decided |
| 2026-02-28 | Inferred media upload should use last-match wins within one message | Prevent duplicate uploads from repeated path mentions in assistant text | Decided |
| 2026-02-28 | Only announce attachment failures for high-confidence path refs and explicit user-request/image flows | Prevent `Attachment missing` spam from weak filename-only hints during routine command output | Decided |
| 2026-02-28 | Cap attachment issue notices per turn and suppress them in read-only/general mode | Keep conversation UX clean while preserving actionable diagnostics in repo channels | Decided |
| 2026-02-28 | Add renderer verbosity modes (`user`/`ops`/`debug`) with `user` default | Reduce status-line noise by default while preserving operator/developer diagnostics | Decided |
| 2026-02-28 | Normalize Codex notifications before runtime side effects | Reduce handler complexity and prepare for stricter TS migration boundaries | Decided |
| 2026-02-28 | Restart control must be host-managed via supervisor + signal files | Sandbox limits prevent reliable direct host process termination | Decided |

## Open Questions

1. Should text-based attachment path scraping be disabled by default immediately?
2. Should we add a user-facing summary line when attachment issues are suppressed by policy?
3. Do we keep Bun-only execution, or support Node as well for broader contributor setup?

## Risks + Mitigations

1. Risk: Behavior regressions during module extraction.
   - Mitigation: extract one domain at a time with no-op wrappers and quick smoke checks.
2. Risk: Type migration slows hotfix velocity.
   - Mitigation: maintain a compatibility layer and ship in small PRs.
3. Risk: Attachment behavior changes surprise users.
   - Mitigation: feature flags + clear changelog entries.

## Working Notes (Update Continuously)

- 2026-02-28: Branch created; plan initialized.
- 2026-02-28: Confirmed Chat SDK Discord docs emphasize explicit features and adapter boundaries.
- 2026-02-28: Confirmed Chat SDK file docs use explicit `files` payload model (strong signal for our attachment refactor direction).
- 2026-02-28: Compared Vercel `ai-chatbot` message/stream components; added renderer-focused UX tasks to reduce Discord noise and improve attachment reliability.
- 2026-02-28: Added preferred outbound inferred-media UX: within one message, upload only the last referenced media path.
- 2026-02-28: Added CLI + restart orchestration phase with sandbox-safe host-managed restart model.
- 2026-02-28: Phase 1 scaffolding implemented (`tsconfig`, `src/types`, `src/cli`, `src/app/main.ts`) and typecheck passes.
- 2026-02-28: Phase 2 started: extracted `config` module (`src/config/loadConfig.js`) and channel context module (`src/channels/context.js`) with behavior-preserving wiring in `src/index.js`.
- 2026-02-28: Phase 2 continued: extracted approval payload/button parsing/building into `src/codex/approvalPayloads.js` and rewired `src/index.js`.
- 2026-02-28: Phase 2 continued: extracted attachment pipeline into `src/attachments/service.js` and renderer helpers into `src/render/messageRenderer.js` with behavior-preserving wrappers.
- 2026-02-28: Phase 2 continued: extracted queue/turn lifecycle orchestration into `src/codex/turnRunner.js` with injected dependencies and thin wrappers in `src/index.js`.
- 2026-02-28: Phase 3 started: attachment intent classification added (`explicit_structured` + optional `inferred_text_fallback`), fallback scraping gated behind `DISCORD_ATTACHMENT_INFER_FROM_TEXT` (default off), inferred path upload uses last-match wins, and per-turn attachment telemetry counters are tracked.
- 2026-02-28: Phase 3 hardening pass: filename/name-based candidates now require high-confidence path hints, `imageView` attachment candidates are tagged `explicit_user_request`, failure announcements are restricted to explicit/high-confidence flows, and inferred traversal typo (`paths.length`) was fixed.
- 2026-02-28: Added per-turn attachment issue cap (`DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN`, default `1`) and forced issue suppression in read-only/general mode (`allowFileWrites=false`) to prevent channel noise.
- 2026-02-28: Phase 3.5 started: added renderer plan contract (`primaryMessage`, `statusMessages`, `attachments`) and introduced `DISCORD_RENDER_VERBOSITY` with status-item gating (`user` default, `ops`, `debug`).
- 2026-02-28: Added status-line dedupe (`lastStatusUpdateLine`) to prevent repeated identical lifecycle/status posts in the same turn.
- 2026-02-28: Phase 4 started: added `src/codex/notificationMapper.js` for normalized Codex notification kinds and introduced TS boundary contracts in `src/types/codex-events.ts` and `src/types/discord-events.ts`.
- 2026-02-28: Phase 5 started: added Bun unit tests for attachment extraction/path policy (`test/attachments.service.test.ts`) and a `bun test` script in `package.json`.
- 2026-02-28: Tightened inferred media path regex to stop at whitespace (fixes false captures like `"/tmp/one.png then /tmp/two.png"` and stabilizes last-match inference behavior).

## Reference Links

- https://www.chat-sdk.dev/docs/adapters/discord
- https://www.chat-sdk.dev/docs/usage
- https://www.chat-sdk.dev/docs/files
- https://raw.githubusercontent.com/vercel/chat/main/apps/docs/content/docs/adapters/discord.mdx
- https://raw.githubusercontent.com/vercel/chat/main/apps/docs/content/docs/usage.mdx
- https://raw.githubusercontent.com/vercel/chat/main/apps/docs/content/docs/files.mdx
- https://raw.githubusercontent.com/vercel/ai-chatbot/main/components/messages.tsx
- https://raw.githubusercontent.com/vercel/ai-chatbot/main/components/message.tsx
- https://raw.githubusercontent.com/vercel/ai-chatbot/main/components/multimodal-input.tsx
- https://raw.githubusercontent.com/vercel/ai-chatbot/main/components/preview-attachment.tsx
- https://raw.githubusercontent.com/vercel/ai-chatbot/main/components/data-stream-handler.tsx
