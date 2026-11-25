# Driving the OpenAI Codex CLI programmatically with a ChatGPT-plan login (as of 2026-11-17, codex-cli 0.167.0, macOS arm64)

Legend: [V] verified hands-on; [D] documented by OpenAI; [T] reported by third parties; [U] unknown.
Scratch dir for probes: /private/tmp/claude-501/-Users-parth-projects-general-mind-maps/e978aa9d-83bf-4c61-9197-231fbb959d27/scratchpad/codex-probe (ev1.jsonl, ev2.jsonl, schema/).
Docs note: developers.openai.com/codex/* now 308-redirects to learn.chatgpt.com/docs/* (e.g. /codex/noninteractive -> https://learn.chatgpt.com/docs/non-interactive-mode). Both host names serve the same content.

## 1. Non-interactive modes: `codex exec`, JSONL events, structured output

### Takeaway
`codex exec` works headless with a ChatGPT login and a strict JSON Schema ([V] 7 s, valid JSON, 5 nodes as requested). Its JSONL stream is coarse: it emits whole items (`item.completed` for an agent message), not token deltas ([V]). For node-by-node streaming use app-server. Critical gotcha: with a prompt argument and an open/non-TTY stdin, `exec` blocks on "Reading additional input from stdin..." unless you redirect stdin from /dev/null or close it ([V]).

### Cited Findings
- [V] Installed: `codex --version` -> `codex-cli 0.167.0`. `codex exec --help` flags observed: `-c/--config key=value` (TOML-parsed), `--enable/--disable FEATURE`, `--strict-config`, `-i/--image FILE...`, `-m/--model`, `--oss`, `--local-provider`, `-p/--profile`, `-s/--sandbox {read-only,workspace-write,danger-full-access}`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `-C/--cd`, `--worktree`, `--add-dir`, `--thread-source`, `--cyber-access-program`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema FILE`, `--color`, `--json`, `-o/--output-last-message FILE`. Subcommands: `resume`, `fork`, `review`. There is NO `--search` on `exec` (top-level `codex` has `--search`), and no `--full-auto` (removed per docs). Prompt `-` reads stdin.
- [V] Run: `codex exec --json --skip-git-repo-check --ephemeral -s read-only --ignore-user-config --ignore-rules -C . --output-schema mm.schema.json -o last1.json "<prompt>" </dev/null`. Result: rc=0, wall time 7 s (cold start included), 18,277 input tokens (0 cached), 121 output tokens. Event stream was exactly 4 lines:
  `{"type":"thread.started","thread_id":"01a1ea70-..."}`, `{"type":"turn.started"}`, `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"title\":\"Coffee\",\"nodes\":[...5 nodes...]}"}}`, `{"type":"turn.completed","usage":{"input_tokens":18277,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":121,"reasoning_output_tokens":0}}`. `-o last1.json` contained the bare JSON, matching the schema (5 nodes, `parent_id` null for root).
- [V] Same flags with `-m gpt-6-luna -c model_reasoning_effort=low`: 9 s wall, accepted. (The reasoning key was accepted without error; effect not separately measured.)
- [V] The first attempt without `</dev/null` hung indefinitely printing `Reading additional input from stdin...` (process had to be killed). Always close stdin when spawning.
- [V] Even with `--ignore-user-config --ignore-rules`, the model's tool list (asked via a tiny prompt, ev2.jsonl) still included `mcp__codex_apps__github/gmail/google_drive/chatgpt_space/...`, `collaboration.*` sub-agent tools, `tools.image_gen__imagegen`, `tools.web__run`, `tools.view_image`, `tools.apply_patch`, `tools.exec_command`. So account-level "apps" connectors leak into calls regardless of local config; disable explicitly (see section 7).
- [D] JSONL event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` (`item.started`, `item.completed`), `error`; item types: agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, plan updates. `turn.completed.usage` has input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens — [Non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode)
- [D] Progress goes to stderr and the final message to stdout when not using `--json`; `--output-schema` "requests a final response conforming to a JSON Schema"; example uses `-o ./project-metadata.json`; `exec resume --last "..."` and `exec resume <SESSION_ID>`; git-repo requirement overridden by `--skip-git-repo-check`; `--ephemeral` skips persisting rollout files — same page.
- [D] Default sandbox for exec is read-only; project config and project MCP servers load only for trusted projects — same page.
- [D] By default `codex exec` reuses saved CLI auth; `CODEX_API_KEY` is the API-key route — same page.
- Streaming deltas are NOT exposed by `exec --json` in the observed run (single completed item). [V for the tiny case; token deltas not seen]. Deltas are exposed via app-server `item/agentMessage/delta` ([D], section 2).

### Inferences
- A mind-map call via `exec` is one request/response; nodes cannot appear incrementally unless the app asks the model for one small call per subtree/level, or uses app-server deltas and incremental JSON parsing.
- ~7-9 s per trivial call, with ~18k input tokens of fixed system/tool prompt overhead each time (cached on later calls). Parallel `exec` processes would each pay that.

### Gaps
- Behaviour of `--output-schema` with very large or deeply recursive schemas (OpenAI structured outputs usually require `additionalProperties:false`, all fields required, no unbounded recursion unless `$ref` supported) not tested; the sample worked with flat array + parent_id, which is the safe design.

## 2. `codex app-server` (JSON-RPC)

### Takeaway
Documented by OpenAI as the interface for "a deep integration inside your own product" (rich clients with auth, history, approvals, streamed events); it is the right embedding surface, but the CLI marks the command `[experimental]` and the protocol changes between versions, so pin the version and generate bindings from the installed binary.

### Cited Findings
- [V] `codex app-server --help`: `[experimental] Run the app server or related tooling`; subcommands `daemon`, `proxy`, `generate-ts`, `generate-json-schema`; options `--listen <URL>` (`stdio://` default, `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`), `--stdio`, `--print-startup-config`, `--startup-client-info`, `--strict-config`, `--ws-auth {capability-token,signed-bearer-token}` + token/secret flags, `--analytics-default-enabled`.
- [V] `codex app-server generate-json-schema --out ./schema` worked offline into the scratch dir (39 files incl. ClientRequest.json, `codex_app_server_protocol.v2.schemas.json`). ClientRequest lists 106 methods, including: `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/inject_items`, `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`, `model/list`, `account/read`, `account/login/start`, `account/login/cancel`, `account/logout`, `account/rateLimits/read`, `account/usage/read`, `command/exec`, `fs/*`, `skills/list`, `config/read`, `config/value/write`, `config/batchWrite`, `mcpServerStatus/list`, `plugin/*`, `app/list`.
- [V] ThreadItem types in v2 schema: userMessage, agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep, **imageGeneration**, enteredReviewMode, exitedReviewMode, contextCompaction. `imageGeneration` carries `id`, `generationId`, `failure`, `inputImages`, and either `{fileId}` (durable attachment store id) or `{result}` (inline data). Notifications include `AccountRateLimitsUpdatedNotification`, `AgentMessageDeltaNotification`, `ItemCompletedNotification`, `TurnStartedNotification`, `ThreadStartedNotification`. Also `ChatgptAuthTokensRefreshParams/Response` (server asks client to refresh externally supplied tokens) and `DynamicToolCallParams` (client-defined tools the model can call).
- [V] `RateLimitSnapshot` fields: `primary`/`secondary` RateLimitWindow, `credits`, `planType`, `limitId`, `limitName`, `rateLimitReachedType`, `spendControlReached`, `individualLimit`.
- [D] Transports: stdio newline-delimited JSON (default); WebSocket "experimental and unsupported"; unix socket. Handshake: one `initialize` with `clientInfo {name,title,version}` then `initialized` notification; optional `capabilities.experimentalApi`, `optOutNotificationMethods`. `thread/start` takes `model`, `cwd`, `approvalPolicy`, `sandbox`, `serviceName`; `turn/start` takes `threadId`, `input` items (`text`, `image`, `localImage`, `skill`), per-turn overrides and `outputSchema`; `turn/interrupt` {threadId, turnId} ends the turn with status `interrupted`; `turn/steer` needs `expectedTurnId`. Notifications: `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/status/changed`. Approval server requests: `item/permissions/requestApproval`, `mcpServer/elicitation/request`, `tool/requestUserInput`; command decisions accept/acceptForSession/decline/cancel. Many methods gated behind `experimentalApi`; plugin methods "not for production clients yet". — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- [D] Recommendation: app-server for "custom clients that handle authentication, conversation history, approvals, and streamed agent events"; SDK for automation/CI — [Codex SDK page](https://learn.chatgpt.com/docs/codex-sdk.md)
- [D] Minimal sequence from OpenAI's token-sharing page: initialize -> initialized -> thread/start (save `result.thread.id`) -> turn/start -> display `item/agentMessage/delta` -> on `turn/completed` check `turn.status == completed` — [Codex app-server - Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [T] Rust crate `vtcode` contains a Codex app-server client calling `account/login/start` — [docs.rs](https://docs.rs/crate/vtcode/0.98.4/source/src/codex_app_server/client.rs). OpenClaw has a "codex-harness" plugin around app-server — [docs2.openclaw.ai](https://docs2.openclaw.ai/plugins/codex-harness/app-server.md).

### Inferences
- Long-lived `codex app-server` over stdio, one process per app, many threads (one per mind-map job / one per image batch), gives delta streaming, interrupts and rate-limit notifications that `exec` cannot.
- Because bindings are generated per version (`generate-ts`, `generate-json-schema`), a Zig/Elixir/Swift/Rust host can codegen types from the JSON Schema in CI and gate on the `codex --version` it finds.

### Gaps
- Per-thread streaming granularity for structured-output JSON (are partial JSON deltas emitted with `outputSchema`?) not tested live (no app-server live call made).
- Exact stability promise: OpenAI calls it `[experimental]` in the CLI; no semver/compat guarantee found.

## 3. `codex mcp-server`, SDKs, community wrappers

### Takeaway
`codex mcp-server` no longer exists in 0.167.0 [V] and OpenAI says integrations should move to app-server [D]. Official SDKs (TypeScript, Python) are thin layers over Codex; no official Zig/Elixir/Swift/Rust SDK was found.

### Cited Findings
- [V] `codex mcp-server --help` just printed top-level help (no such subcommand; top-level command list has `mcp` for managing external MCP servers only).
- [D] "The `codex mcp-server` command and `codex-mcp-server` binary have been removed, so existing integrations should move to the app-server." — [Codex SDK page](https://learn.chatgpt.com/docs/codex-sdk.md)
- [D] TypeScript: `npm install @openai/codex-sdk`, Node 18+, server-side, starts/continues/resumes local threads, accepts `config` and raw TOML `configOverrides`. Python: `pip install openai-codex`, Python 3.10+, wraps local app-server over JSON-RPC, bundles a pinned CLI runtime, sync `Codex` and async `AsyncCodex`, `thread_start/resume/fork`, sandbox presets `read_only`, `workspace_write`, `full_access`; stable release — same page.
- [T] A third-party blog claims both SDKs expose only blocking `run()` rather than streaming — [codex.danielvaughan.com](https://codex.danielvaughan.com/2026/05/20/codex-cli-sdk-maturation-v0130-v0132-programmable-agent-platform/); the OpenAI page does not describe SDK streaming (unconfirmed).
- [T] Rust crate vtcode (app-server client); OpenClaw, OpenCode, Pi, Cline, OpenHands document ChatGPT-subscription providers (they mostly call the backend Responses API directly with the OAuth token rather than shell out) — [OpenHands docs](https://docs.openhands.dev/sdk/guides/llm-subscriptions.md), [Cline docs](https://docs.cline.bot/provider-config/openai-codex.md).

### Inferences
- For Zig/Elixir/Swift: write a ~200-line JSON-RPC-over-stdio client against generated schemas (Elixir: Port + Jason; Swift: Process + Codable; Zig: std.process.Child + std.json). TypeScript host can use `@openai/codex-sdk` or the app-server TS bindings.

### Gaps
- Searches found no maintained Elixir, Swift or Zig client libraries; not exhaustively searched GitHub.

## 4. Authentication, plans, limits, rate-limit reporting

### Takeaway
A child process of your app that inherits `CODEX_HOME`/HOME simply uses the user's existing login ([V]: calls above ran with the user's ChatGPT login; `codex login status` printed `Logged in using ChatGPT`). Tokens refresh automatically in-process. Plans with Codex: Free, Go, Plus, Pro ($100/$200/$500), Business, Enterprise/Edu.

### Cited Findings
- [V] `codex login status` -> `Logged in using ChatGPT`. `--ignore-user-config` skips config.toml but "auth still uses CODEX_HOME" (help text) and worked.
- [D] Credentials in `~/.codex/auth.json` (`CODEX_HOME`) or OS keyring; `cli_auth_credentials_store` = `file|keyring|auto|ephemeral`; "Codex refreshes tokens automatically during use before they expire"; CLI and IDE extension share the cached login; `codex login --device-auth` for headless; "Treat ~/.codex/auth.json like a password" — [Auth docs](https://learn.chatgpt.com/docs/auth)
- [D] Plans: Free $0, Go $8, Plus $20, Pro from $100 (tiers $100/$200/$500), Business $20/user (annual) / $25 monthly, Enterprise & Edu contact sales, API key pay-as-you-go. Five-hour limits shown only for Plus and standard Business (local messages per 5 h, e.g. GPT-6.1 Sol 15-160, GPT-6 Luna 350-3,000, GPT-6 Astra 5-45); "Pro plans currently have no five-hour limit"; weekly limits "may also apply"; Plus/Pro can buy credits; Fast = 2.5x, Ultrafast 8x included-usage multiplier; `/status` in CLI shows remaining limits; dashboard chatgpt.com/codex/settings/usage — [Pricing](https://learn.chatgpt.com/docs/pricing)
- [V] App-server exposes `account/rateLimits/read`, `account/usage/read`, `account/rateLimits/updated` notification (docs: "emitted whenever a user's ChatGPT rate limits change"). `exec --json` run showed no rate-limit events in the success case; failure surface (`turn.failed`/`error`) not exercised.
- [T] Third-party blogs disagree about whether the 5-hour window was removed (July 12, 2026) and reinstated; defer to the live pricing page — [eesel](https://www.eesel.ai/blog/gpt-remove-5-hour-limits), [Morph](https://www.morphllm.com/codex-pricing).

### Inferences
- Treat limits as opaque and per-user; the app should read `account/rateLimits/read` before big batches and surface `rateLimitReachedType`.

### Gaps
- Exact current weekly caps per plan: not published as numbers on the pricing page; third-party figures conflict.
- Behaviour when the refresh token is revoked/expired (error shape) not tested.

## 5. Policy and terms

### Takeaway
Uncertain. I found no OpenAI text that explicitly permits or forbids a third-party desktop app spawning the user's own `codex` binary. But OpenAI now has an official, separate "Sign in with ChatGPT" (SIWC) plan-usage program for third-party apps with its own OAuth scope and terms, which is the sanctioned route for apps that want to spend a user's plan. Scraping `auth.json` tokens to call the backend is the gray/risky path.

### Cited Findings
- [D] OpenAI docs say ChatGPT auth in automation is "intended for enterprise teams on trusted runners, or users who need ChatGPT/Codex rate limits"; "Don't use this for public or open-source repositories"; `auth.json` must be treated as a password — [Non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode), [Auth docs](https://learn.chatgpt.com/docs/auth). These concern sharing/hosting credentials, not local per-user spawning.
- [D] OpenAI publishes an official recipe to run `codex app-server` with an OAuth access token "authorized for ChatGPT plan usage" in a third-party app, with `clientInfo.name` as a stable app identifier — [developers.openai.com/siwc/...](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). The docs navigation lists "Terms and policies" and "Preview limitations" pages that I could not fetch (404/403).
- [T, single secondary source, unverified against OpenAI] WorkOS summary of SIWC plan usage: scope `chatgpt.tokens.use.direct`; announced at DevDay 2026-09-29 with 16 partners (Notion, Vercel, Warp, OpenCode...); Plus and Pro only; docs aimed at open-source and locally hosted apps, paid/remote products directed to an interest form; per-app weekly caps; access tokens 3600 s, refresh 30 days; 429 `subscription_sharing_usage_limit_exceeded`, 403 `subscription_sharing_user_not_eligible`; HTTP requests must set `store:false`, `stream:true`; image generation, file search, Code Interpreter, hosted MCP and `tool_search` unavailable on the plan-funded HTTP path; apps may not charge users for the plan usage consumed — [WorkOS](https://workos.com/blog/sign-in-with-chatgpt-plan-usage-scope)
- [T] OpenAI help-center article "Using your ChatGPT plan in other apps and sites" (https://help.openai.com/en/articles/20001542) exists; I could not fetch it (403). Search snippets say plan usage requires Plus/Pro (another passage says Go, Plus or Pro) — conflicting.
- [T] Community packages state OpenAI "sanctions" the Codex OAuth flow for Codex tooling/personal use; other sources say OpenAI has no general third-party OAuth registration; Anthropic by contrast banned subscription tokens in third-party tools (Feb 20 2026) — [yage.ai](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html), [manifest.build](https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/). Low reliability.

### Inferences
- Personal use (you spawn your own installed `codex`) is the lowest-risk reading: it is OpenAI's own first-party binary using the user's own login. Distributing an app that tells users to install Codex and sign in themselves, then spawns it, is plausibly acceptable (the app never touches credentials) but is NOT explicitly blessed in anything I could read; the officially supported route for a distributed app is SIWC (open-source/local apps are the documented sweet spot; commercial needs OpenAI's form). Do not read, copy or relay `auth.json` tokens.
- Recommend the requirements doc flags "policy: confirm with OpenAI terms/SIWC docs before public distribution" as an open item.

### Gaps
- Primary-text ToS clause on third-party harnesses; the SIWC "Terms and policies" page; the help-center article body. Staff statements on forum/HN not found.

## 6. Image generation

### Takeaway
Built-in and available with ChatGPT login: the model tool list in 0.167.0 contains `tools.image_gen__imagegen` [V] and feature flag `image_generation` is stable/true [V]. It is billed against plan limits (3-5x a plain turn), not on Free, and falls to credits when limits are exhausted [D]. Native transparent backgrounds are not supported by gpt-image-2 [T].

### Cited Findings
- [V] `codex features list`: `image_generation  stable  true`. Tool-name probe returned `tools.image_gen__imagegen` and `tools.view_image`.
- [V] app-server ThreadItem `imageGeneration` (fileId or inline result) means `codex app-server` returns structured image items; in `exec --json` the item type for it was not observed (no real image call made, per constraints).
- [D] Image generation not on Free; uses included limits "about 3-5x faster" than similar non-image turns, "depending on quality and size"; after limits, draws credits; with an API key, API pricing applies — [Pricing](https://learn.chatgpt.com/docs/pricing)
- [T] `$imagegen` skill shipped ~v0.117 (Mar 2026), moved to gpt-image-2 ~v0.123 (Apr 2026); default is the built-in `image_gen` tool (no API key); fallback `scripts/image_gen.py` needs `OPENAI_API_KEY` with `generate`, `edit`, `generate-batch`; saved to `$CODEX_HOME/generated_images/` (usually `~/.codex/generated_images/`), project assets copied into the workspace; gpt-image-2 rejects `background=transparent` (workaround: chroma-key `#00ff00` then `remove_chroma_key.py`); aspect ratios 3:1-1:3, 2K stable, 4K beta; `-i` attaches reference images; skill can be disabled via `[[skills.config]] path="imagegen" enabled=false` — [Vaughan, Apr 2026](https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/), [Vaughan v0.137](https://codex.danielvaughan.com/2026/06/04/codex-cli-visual-workflows-image-input-gpt-image-2-generation-asset-pipelines-v0137/)
- [T] API alternative price examples for gpt-image-2: ~$0.006 (low) to ~$0.211 (high) per 1024x1024 image — same Vaughan article.
- DALL-E 2/3 retired from API 12 May 2026 [T, same article].

### Inferences
- Non-interactive pattern: `codex exec` (or app-server turn) with prompt "Use the imagegen tool to create X; save to ./out/<node-id>.png; reply with the path", cwd = a per-job temp dir with `workspace-write` sandbox so the file can be placed; app-server `imageGeneration` item gives file ids for deterministic harvesting. Not verified; run a one-image spike first.
- One image per turn means N nodes = N image-gen turns, each 3-5x limit cost: batches of dozens will burn a Plus 5-hour window quickly. Offer a "contact sheet then slice" mode (one generation, 3x3 grid) to cut cost.
- Consistency: shared style paragraph + same reference image via `-i`/`localImage` input on every call; contact-sheet slicing gives same-pass consistency; seed control is not documented for the built-in tool [U]. Transparency: chroma-key on flat `#00ff00` + local alpha-matting (ImageMagick/CoreImage) in the host app.
- Fallbacks if built-in is unsuitable: OpenAI Images API (needs API key, `generate`/`edit`); local FLUX/SDXL via MLX/ComfyUI on Apple Silicon (not researched in depth).

### Gaps
- No real image call made: exact `exec --json` event shape for generated images, size/quality parameters exposed to the built-in tool, latency per image, and whether limit cost matches the 3-5x claim are unverified.
- Local-model alternatives (MLX FLUX, ComfyUI) and style-reference mechanisms (IP-Adapter etc.) were not researched.

## 7. Models, effort, speed; isolation and reliability

### Takeaway
Pick the model per call with `-m` and `-c model_reasoning_effort=...` (exec) or `model`/overrides in `thread/start`/`turn/start` (app-server). Use `gpt-6-luna` (cheapest/fastest) or `gpt-6.1-terra` for structured JSON and `gpt-6.1-sol`/`gpt-6-astra` for art direction/SVG.

### Cited Findings
- [V] `codex debug models` (local catalog, may reflect this account): listed `gpt-6.1-sol` (default effort low), `gpt-6-astra` (medium), `gpt-6.1-terra` (low), `gpt-6-sol`, `gpt-6-luna` (medium), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; efforts low/medium/high/xhigh/max (+`ultra` for all but Luna); all text+image input; each has a `fast` speed tier. Hidden: `gpt-reserve`, `codex-auto-review`.
- [D] Descriptions: Astra most capable; 6.1 Sol near-Astra at lower cost; 6.1 Terra fast, good at writing, visual understanding, computer use (needs CLI >= 0.159); Luna most efficient for high-volume focused tasks; Free/Go get Luna — [Models](https://learn.chatgpt.com/docs/models). Docs do not document a `model_reasoning_effort` key; I used `-c model_reasoning_effort=low` and it was accepted [V, effect unconfirmed].
- [T] Simon Willison pelican-on-a-bicycle: GPT-6.1 Terra at max produced "a good pelican and a good bicycle" (~11.3 cents); GPT-6 Astra tested at several effort levels; GPT-6.1 Sol "not notably different" from GPT-6 family — [simonwillison.net tag page](https://simonwillison.net/tags/pelican-riding-a-bicycle/). No SVGBench numbers found.
- [V] Isolation flags: `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `-s read-only`, `-C <empty dir>`, `--skip-git-repo-check` all accepted and worked. `features list` shows toggles: `apps`, `plugins`, `goals`, `image_generation`, `memories`; use `--disable apps --disable plugins` (not tested whether it removes the `mcp__codex_apps__*` tools).
- [V] `web__run` tool present by default in model tool list; `codex` top-level has `--search` ("native Responses web_search tool", no per-call approval); `exec` has no `--search`, so enable via `-c web_search="live"` [config key name from memory/unverified] or app-server config.
- [D] Cold start observed 7-9 s per `exec`; interrupt via app-server `turn/interrupt`; for exec, kill the process.

### Inferences
- Concurrency: parallel `exec` children work but each re-sends ~18k prompt tokens; app-server with multiple threads shares one process. Rate limits apply per account, so cap parallelism (2-4).
- Parse failure/validation: always validate output against the schema locally; retry once on `turn.failed`.
- SVG: documented best practice (my recommendation, no source): fixed viewBox, palette tokens, path-count cap, sanitise (strip script/foreignObject/external refs), render and critique with `view_image` or `-i` loop; known failure modes are misplaced limbs/overlaps (see pelican critiques).

### Gaps
- Web search enable flag for `exec`, SVG benchmarks (SVGBench), `exec` failure event shapes (rate limit/auth), and whether `--disable apps` removes connector tools were not verified.

## 8. Prior art

### Takeaway
Open-source tools embed Codex via app-server (vtcode, OpenClaw harness, OpenAI's own TUI `--remote`, Python/TS SDKs) or bypass the CLI and use the OAuth token directly against the Responses API (OpenCode, Cline, OpenHands, Pi) [T].

### Cited Findings
- [T] [vtcode client.rs](https://docs.rs/crate/vtcode/0.98.4/source/src/codex_app_server/client.rs); [OpenClaw](https://docs2.openclaw.ai/plugins/codex-harness/app-server.md); [Cline](https://docs.cline.bot/provider-config/openai-codex.md); [OpenHands](https://docs.openhands.dev/sdk/guides/llm-subscriptions.md); [assistant-ui](https://www.assistant-ui.com/docs/guides/chatgpt-subscription.md).
- [T] Community skills bridge Codex image gen into other agents (e.g. DEV posts "Let Claude Code generate images with your ChatGPT subscription"); one project notes the ChatGPT-backed image endpoints are not a stable public API.

### Gaps
- No Swift/Elixir/Zig prior art found.

## Recommended architecture (summary)
1. Primary: spawn one long-lived `codex app-server --listen stdio://` child (flags `-c` overrides to disable user MCP/apps/plugins; cwd = per-app scratch dir; stdin/stdout JSON-RPC), pinned to the detected `codex --version`, types generated by `generate-json-schema`. Threads: one text thread for tree generation (`outputSchema` flat node list with `parent_id`), streamed via `item/agentMessage/delta`; one thread per image batch; `turn/interrupt` for cancel; subscribe to `account/rateLimits/updated`.
2. Simple fallback: per-call `codex exec --json --ephemeral --ignore-user-config --ignore-rules -s read-only --skip-git-repo-check -C <tmp> --output-schema <f> -o <out> </dev/null` (7-9 s each, no deltas).
3. Images: built-in imagegen via workspace-write turns in a per-job dir; harvest files by path or `imageGeneration` item; chroma-key for transparency; alternative path with an `OPENAI_API_KEY` or a local model.
4. Policy: do not touch `auth.json`; check login with `codex login status`; consider applying for SIWC if distributing.
