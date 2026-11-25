# Codex CLI hands-on verification, pass 2 (codex-cli 0.167.0, macOS arm64, ChatGPT login, plan type reported as `prolite`)

Date run: 2026-11-17. Supersedes the "unverified" items in `codex_cli_integration.md`.
Tags: **[V]** verified hands-on on this machine; **[D]** from local generated schema/--help (documentation of the installed binary, not exercised); **[U]** unknown / not tested.

Scratch dir (all artefacts): `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/e978aa9d-83bf-4c61-9197-231fbb959d27/scratchpad/codex-probe2` (call it `$S`).
Model calls made: **8 of 8 budget** (list with token usage in "Call ledger" at the end). No `auth.json`/keyring read; user Codex config not modified; nothing installed.
`codex --version` -> `codex-cli 0.167.0` [V]. No behaviour from the earlier notes was contradicted: `exec` event stream, flags and `</dev/null` requirement all matched. New findings below.

## Summary for the engineer (the decisions)

1. Use `codex app-server --listen stdio://` over stdio. It streams `item/agentMessage/delta` token-ish chunks, **including when `outputSchema` is set** (partial JSON text streams) [V]. Time to first delta ~2.8-3.7 s, then ~140 ms bursts [V].
2. Alternative streaming format that is easier to consume: JSON Lines without a schema, one node per line. Observed ~290 ms per node line [V].
3. Isolation on app-server: there is no `--ignore-user-config` for app-server (user MCP servers from `~/.codex/config.toml` DID start). Working recipe: `--disable apps --disable plugins` (removes `codex_apps`, `cua_repl`, `data`) plus per-server `mcp_servers.<name>.enabled=false` for user servers (names from `config/read` / `mcpServerStatus/list`), giving **zero MCP servers** [V, no model call]. `-c mcp_servers={}` does NOT work [V].
4. Image generation works with ChatGPT login: ~12 s per image, inline base64 PNG in the `imageGeneration` item, 1254x1254, also saved by Codex under `~/.codex/generated_images/<threadId>/<itemId>.png` [V]. Transparent background request produced a real RGBA PNG [V]. Reference image via `localImage` input works [V].
5. SVG: one call on `gpt-6.1-terra` at low effort passed every mechanical contract check (details below) and rendered as a coherent 5-icon mind map [V]. Weak points: anchors for n2..n5 had in == out (same point) and the model hard-coded the connectors itself.

## 1. Tool isolation

### Takeaway
Connectors ("apps") are removed by `--disable apps` (and plugin-provided MCP by `--disable plugins`). Sub-agent `collaboration.*` tools and a code-mode `functions.exec` tool could NOT be removed with any feature flag I found. The model still sees a shell-like tool, so the sandbox (`-s read-only`) remains the real guard.

### Findings
- [V] Feature flags relevant (from `codex features list`): `apps` stable true, `plugins` stable true, `multi_agent` stable true, `multi_agent_v2` stable false, `shell_tool` stable true, `unified_exec` stable true, `code_mode_host` stable true, `image_generation` stable true, `view_image` stable true, `browser_use`, `browser_use_external`, `computer_use`, `in_app_browser`, `goals`, `memories`, `hooks`, `skill_search`, `tool_suggest`, `sleep_tool`. `--disable X` is equivalent to `-c features.X=false` (exec and app-server `--help`).
- [V] Config key for web search: `web_search` (values `disabled|cached|indexed|live`, from generated type `WebSearchMode`) and `tools.web_search` (`ToolsV2`). `-c web_search=disabled` accepted by exec and app-server.
- [V] Exec call 1 (most restrictive, 5 s, 12,198 in / 45 out tokens):
```
codex exec --json --skip-git-repo-check --ephemeral -s read-only --ignore-user-config --ignore-rules -C . \
  -m gpt-6-luna -c model_reasoning_effort=low \
  --disable apps --disable plugins --disable multi_agent --disable shell_tool --disable unified_exec \
  --disable browser_use --disable browser_use_external --disable computer_use --disable in_app_browser \
  --disable goals --disable memories --disable image_generation --disable view_image \
  -c web_search=disabled -c tools.web_search=false \
  "List the names of the tools available to you, one per line, and do nothing else" </dev/null
```
  Model answer: `functions.exec, functions.wait, clock.sleep, collaboration.followup_task, collaboration.interrupt_agent, collaboration.list_agents, collaboration.send_message, collaboration.spawn_agent, collaboration.wait_agent`. **No `mcp__codex_apps__*` connector tools, no web, no image_gen, no apply_patch** (contrast with the pass-1 list). Output: `$S/iso1.jsonl`.
- [V] Exec call 2 additionally disabled `multi_agent_v2 code_mode_host sleep_tool skill_search tool_suggest hooks`: tools became `functions.wait, request_user_input, request_user_input_async, functions.exec, collaboration.*(5)`; and it emitted an `item.completed` of type `error`: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host`..." So do NOT disable `code_mode_host`; it adds an error item and `functions.exec` stays anyway. `collaboration.*` survived every flag [V]. Output: `$S/iso2.jsonl`.
- [V] **Recommended minimal flag set** for "no connectors": `--disable apps --disable plugins` plus (user-config servers) `mcp_servers.<name>.enabled=false`; `-c web_search=disabled`. With `exec --ignore-user-config` the user's own MCP servers are not loaded in the first place.
- [V] App-server MCP isolation, measured with `$S/mcp_iso_probe.py <variant>` (starts `codex app-server`, `thread/start`, collects `mcpServer/startupStatus/updated` for 5 s; no model call):

| variant | servers that started |
|---|---|
| baseline | clickup, codex_apps, context7 (failed), cua_repl, data, node_repl |
| `-c mcp_servers={}` (CLI) | same as baseline (does not work) |
| `thread/start config:{"mcp_servers":{}}` | same as baseline |
| CLI `-c mcp_servers.<n>.enabled=false` for the 3 user servers | codex_apps, cua_repl, data |
| `thread/start config:{"mcp_servers.<n>.enabled":false,...}` (dotted keys in `config`) | codex_apps, cua_repl, data |
| `--disable plugins --disable apps` only | clickup, context7, node_repl |
| `--disable plugins --disable apps --disable computer_use --disable browser_use --disable browser_use_external --disable in_app_browser` + dotted per-server disables in `thread/start.config` | **none** |

  (Server names are the user's; an app must discover them at runtime, e.g. `config/read` or `mcpServerStatus/list` [D, not called].)
- [D] `thread/start` has `config: {[key]: JsonValue}` (dotted keys worked), `baseInstructions`, `developerInstructions`, `ephemeral`, `approvalPolicy` (`untrusted|on-request|granular|never`), `sandbox` (`read-only|workspace-write|danger-full-access`). `turn/start` can override `sandboxPolicy`, `approvalPolicy`, `cwd`, `model`, `effort`, `summary`, `outputSchema`, `disabledPluginIds`.
- [V] Shell tool cannot be removed by `--disable shell_tool` + `--disable unified_exec` (a `functions.exec` tool still listed). Treat sandbox read-only + approval `never` as the control.
- [U] Whether `collaboration.spawn_agent` can actually spawn in a read-only/no-connector thread; not exercised.

## 2. `codex app-server` over stdio

Script: `$S/appserver_probe.py` (Python 3 stdlib). Re-run: `cd $S && python3 appserver_probe.py <log.jsonl> "<prompt>" [--schema f.json] [--effort low] [--model gpt-6-luna] [--sandbox read-only|workspace-write] [--interrupt-after-ms N] [--ref-image png] [--timeout s]`. Every JSON-RPC line (both directions) is logged with ms timestamps (`t_ms` = processing time; server `emittedAtMs` is also present on notifications). Types generated with `codex app-server generate-json-schema --out $S/schema` and `generate-ts --out $S/ts` (both worked offline) [V].

### Takeaway
Handshake and streaming work exactly as the docs describe. Deltas stream for both free text and schema-constrained output; apply nodes as complete JSON-Lines lines arrive.

### Messages that worked [V] (newline-delimited JSON, no `jsonrpc` field required)
```
-> {"method":"initialize","id":1,"params":{"clientInfo":{"name":"mm_probe","title":"MM probe","version":"0.0.1"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}
<- {"id":1,"result":{"userAgent":"mm_probe/0.167.0 (Mac OS 26.5.1; arm64) ...","codexHome":"/Users/parth/.codex","platformFamily":"unix","platformOs":"macos"}}
-> {"method":"initialized"}
-> {"method":"thread/start","id":2,"params":{"cwd":"<S>","approvalPolicy":"never","sandbox":"read-only","model":"gpt-6-luna","ephemeral":true,"serviceName":"mm_probe","config":{"mcp_servers.context7.enabled":false,...}}}
<- {"id":2,"result":{"thread":{"id":"01a1ea79-f573-...","environments":[...],...},"model":...,"cwd":...,"approvalPolicy":"never","sandbox":{...},"reasoningEffort":...}}
-> {"method":"turn/start","id":4,"params":{"threadId":"<tid>","input":[{"type":"text","text":"<prompt>","text_elements":[]}],"effort":"low","outputSchema":{...optional...}}}
<- {"id":4,"result":{"turn":{"id":"01a1ea79-f818-...","status":"inProgress","items":[],"itemsView":"notLoaded",...}}}
```
Command line used to spawn: `codex app-server --listen stdio:// -c web_search=disabled --disable apps --disable plugins --disable multi_agent --disable multi_agent_v2 --disable browser_use --disable browser_use_external --disable computer_use --disable in_app_browser --disable goals --disable memories --disable hooks [--disable image_generation --disable view_image when read-only]`; cwd = `$S`. `experimentalApi:false` was sufficient for everything used.

### Notification sequence for one turn [V] (`$S/as1.jsonl`)
`remoteControl/status/changed` -> `account/updated {authMode:"chatgpt",planType:"prolite"}` -> `thread/started` -> `mcpServer/startupStatus/updated` (per server; not blocking the turn) -> `thread/status/changed {active}` -> `turn/started` -> `item/started` (userMessage) + `item/completed` (userMessage) -> `item/started` (agentMessage, `phase:"final_answer"`, `text:""`) -> many `item/agentMessage/delta {threadId,turnId,itemId,delta}` -> `item/completed` (agentMessage with full `text`) -> `thread/tokenUsage/updated` -> `account/rateLimits/updated` -> `thread/status/changed {idle}` -> `turn/completed {threadId, turn:{status,durationMs,items:[...],error}}`.

### Streaming numbers (turn/start sent at t=0) [V]
| run | first delta | total turn | deltas | notes |
|---|---|---|---|---|
| as1 free-text 12-item outline (`gpt-6-luna`, low) | 2970 ms | 5514 ms | 113 | 117 output tokens; chunks 1-12 chars |
| as2 with `outputSchema` (recursive tree) | 3040 ms | 4578 ms | 83 | 93 output tokens |
| as3 JSON Lines, interrupted at 6 s | 3732 ms | 6043 ms (interrupted) | 128 | - |
Cadence: deltas arrive in bursts about every 110-150 ms, each burst holding 3-9 delta messages (client sees several messages with identical timestamps); chunk sizes 1-12 chars (sub-word tokens). ~3 s before the first delta is mostly model/network latency, not MCP startup.

### Structured output streams [V] (`$S/as2.jsonl`, schema `$S/tree.schema.json`)
Recursive schema with `$defs`/`$ref` and `additionalProperties:false` was accepted. Deltas are literal fragments of the final JSON, e.g. `'{"' 'title' '":"' 'Coffee' '","' 'children' '":[' '{"' 'title' '":"' 'Origins' ...`, so a streaming JSON parser can create nodes as `{"title":"X"` objects close. The final `item/completed` agentMessage `text` is the whole JSON string. Total tree of 7 nodes took 2.4 s of streaming.

### JSON Lines alternative [V] (`$S/as3.jsonl`)
Prompt: `Output a mind map about coffee as JSON Lines: one compact JSON object per line, no code fence, no other text. Fields: id (n1,n2,...), parent (id or null for root), title. Produce 40 nodes, parents always before children.` Complete lines appeared at +309, 585, 874, 1163, 1456, 1740, 2019, 2309 ms after first delta (i.e. about 3.4 nodes/s), e.g. `{"id":"n1","parent":null,"title":"Coffee"}`, `{"id":"n3","parent":"n2","title":"Ethiopia"}`. The model obeyed (no fence, parents before children). Client-side: buffer deltas, split on `\n`, parse each line, discard a trailing partial line on interrupt. This is simpler and more robust than incremental JSON parsing, but has no schema enforcement (validate each line locally). **Trade-off**: the schema path gives validity guarantees; JSONL gives easy incremental application.

### Completion, usage, rate limits [V]
- Completion: `turn/completed.params.turn.status` is `completed` or `interrupted`; `durationMs` present. After interrupt, `turn.items` was `[]` (`itemsView:"notLoaded"`), so partial text must be accumulated by the client from deltas.
- Tokens: `thread/tokenUsage/updated` -> `tokenUsage.{total,last}{totalTokens,inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,reasoningOutputTokens}`, `modelContextWindow:258400`. Not sent for the interrupted turn.
- Rate limits: `account/rateLimits/read` (params `{}`; optional `excludeResetCreditDetails`) returned `{ordinaryUsageAllowed:true, rateLimits:{limitId:"codex", primary:{usedPercent:1, windowDurationMins:10080, resetsAt:<epoch s>}, secondary:null, credits:{hasCredits:true, unlimited:false, balance:"69354.03..."}, planType:"prolite", rateLimitReachedType:null, spendControlReached:false}, rateLimitsByLimitId:{codex:{...}}, rateLimitResetCredits:{availableCount:3,...}}`. `account/rateLimits/updated {rateLimits}` notification fires after each turn (sparse; merge into last read). This account shows only a weekly (10080 min) window, no 5-hour window. usedPercent stayed at 1 across all 8 calls (integer granularity), so per-call cost is not measurable this way.
- Interrupt [V]: `-> {"method":"turn/interrupt","id":5,"params":{"threadId":..,"turnId":..}}` -> `<- {"id":5,"result":{}}` then `turn/completed` status `interrupted` within ~2 ms (`durationMs` 6039). The turn id comes from the `turn/start` response.
- Server-initiated requests (approvals) were never sent with `approvalPolicy:"never"`; the script auto-declines any that appear [V that none arrived].

## 3. Image generation

### Takeaway
Works with ChatGPT login, no API key. ~12 s generation in the 1st call, ~29 s in the 2nd (with reference image); returns the PNG inline as base64 in an `imageGeneration` item and also saves it to disk under `~/.codex/generated_images/`.

### Findings
- [V] Invocation: just ask in the prompt; the model calls its built-in image tool (no flag needed). Used `--sandbox workspace-write`, `cwd=$S`, image feature enabled (`image_generation` not disabled). Prompt (call 1): `Use your image generation tool to create one image: a flat-vector illustration of a red apple on a plain white background, square. Then reply with only the file path.` Log: `$S/img1.jsonl`.
- [V] Items (call 1): `item/started` at +5.9 s `{"type":"imageGeneration","id":"exec-8e79e1dc-...","status":"in_progress","revisedPrompt":null,"result":"","transparentBackground":null,"failure":null,"generationId":null}`; `item/completed` at +18.1 s (12.1 s later) `{"type":"imageGeneration","status":"completed","revisedPrompt":"Create one clean flat-vector illustration of a single red apple with a small green leaf and brown stem, centered on a plain pure white background. Square 1:1 composition, ... no text.","result":"<1,417,676 chars base64 PNG>","transparentBackground":false,"failure":null,"savedPath":"/Users/parth/.codex/generated_images/<threadId>/exec-8e79...png","generationId":"25c6950b-..."}`. The v2 schema type is `ImageGenerationItem` = `{id,status,revisedPrompt,transparentBackground?,failure,savedPath?,inputImages?,generationId} & ({fileId}|{result})`; in practice `result` (inline base64) was returned, plus `savedPath`.
- [V] File: decoded from `result` to `$S/img/apple.png`: PNG 1254 x 1254, 8-bit RGB, no alpha, 1,063,257 bytes (`sips`: pixelWidth 1254, pixelHeight 1254, hasAlpha no). The base64 contains C2PA/JUMBF provenance metadata (visible in the leading bytes). The model's final message was the saved path (agentMessage), as asked. Turn total 20.5 s. Tokens: 15,956 in / 101 out (image cost is not in these counts). Rate limit snapshot unchanged (primary 1 %).
- [V] Parameters: the model, not the client, chooses the tool arguments; only the `revisedPrompt` and `transparentBackground` (bool) are visible on the item. Size came out as 1254x1254 for a "square" request. Explicit size/quality knobs are not exposed in the item; could not be observed [U].
- [V] Transparency (call 2, `$S/img2.jsonl`): prompt asked for the same flat-vector style as an attached reference (`{"type":"localImage","path":"<abs>/img/apple.png"}` appended to `turn/start.input`), a green pear, TRANSPARENT background. Result item had `transparentBackground:true`; `$S/img/pear.png` is PNG 1254x1254 RGBA (`hasAlpha: yes`), 516,842 bytes, corner pixel alpha ~0.004, 28.7 % of pixels opaque (rest transparent). Generation 29.2 s (item started +7.8 s); whole turn 38.5 s. Tokens 17,966 in / 216 out then 20,370 in (17,920 cached) / 64 out. The model rewrote the prompt to "truly transparent background (real alpha channel)" and "Match the supplied reference image's style closely". (This contradicts the third-party claim that gpt-image-2 cannot do transparency; it worked here.)
- [V] Style consistency: reference-image input (`localImage`) is accepted and visibly influenced `revisedPrompt` ("flat vector-like clip art ... no outlines"). I did not judge the visual match. Pure in-thread ("same style as the previous image" without attaching) was NOT tested (budget; the reference-image variant was tested instead) [U].
- [V] Side effect: Codex itself writes generated images to `~/.codex/generated_images/<threadId>/` (outside the scratch dir; two new subfolders from this pass, `01a1ea7b-d2e6-...` and `01a1ea7d-9856-...`). The sandbox restriction applies to the model's tools, not to this host-side save. An app should read `result` (or `savedPath`) and copy into its own project store, and can delete the `~/.codex` copy.
- [D] Pass-1 third-party claims (3-5x limit cost, no Free plan) not testable here.

## 4. SVG against a contract

Prompt file: `$S/svg_prompt.txt`. Model `gpt-6.1-terra`, effort `low`, read-only sandbox, image/view_image disabled, via app-server (`--model gpt-6.1-terra`). Output `$S/svg1.svg`, log `$S/svg1.jsonl`. Checker: `$S/check_svg.py svg1.svg` (ElementTree + approximate bbox from path coordinates, rect/circle/ellipse/line/polygon; ignores transforms).

### Result [V]
- Generation: 28.7 s total turn, first delta 2.8 s, 1,438 deltas (it streams as text, so the SVG can be previewed progressively); 13,923 in / 1,443 out tokens, reasoning tokens 0.
- Well-formed XML: yes. 3,558 bytes. `viewBox="0 0 800 600"`. Elements: svg 1, g 6 (5 node groups + `connectors`), path 17, rect 5, ellipse 3, circle 1.
- Forbidden elements (`script`, `text`, `image`, `foreignObject`): none. External refs: none. Colours: exactly the five palette hexes, nothing else. Paths 17 (limit 60).
- All five groups `node-n1..node-n5` present, each with `data-anchor-in` and `data-anchor-out` in valid `x,y` form, anchors inside the target box, and group bboxes within the target boxes:
  - n1 in 315,255 out 485,255, bbox [315,255,485,345] vs box [300,240,500,360]
  - n2 in=out 240,140, bbox [60,55,240,165] vs [40,40,260,180]; n3 560,140 bbox [560,55,740,165]; n4 240,460 bbox [60,435,240,545]; n5 560,460 bbox [560,435,740,545] (all inside)
- Rendering check (my own look, not shown to the user): macOS WebKit renderer (`qlmanage -t -s 800 -o ql svg1.svg`) shows five rounded cards with coherent icons (cup with steam, globe, dripper, two beans, flame) joined by curved connectors. ImageMagick's built-in SVG renderer (`magick`) draws it wrongly (drops the connector group, misplaces rotated ellipses using `rotate(a cx cy)`): do not use it to validate; the SVG itself is correct.
### Weaknesses (frank)
- Anchors for n2-n5 have in == out (the model used the single connector endpoint); the root has in/out at the left/right edge midpoints rather than meaningful entry/exit, so the prompt must define in/out semantics (e.g. "in = point nearest the parent, out = point nearest the children") if the app needs them to differ.
- Two `rotate()` transforms inside n4 are not in the bbox maths; they visually stayed inside the box.
- The model drew connectors itself in a `connectors` group (allowed by my prompt); the app would probably want to draw connectors and forbid them.
- Single sample, one model; no retry loop needed here. Not tested: weaker model (`gpt-6-luna`) or larger subtrees [U].

## 5. Docs/schema-only items (no model calls)

- [D] Rate-limit exhaustion / auth expiry in app-server: failures arrive as `error` notification `ErrorNotification {error: TurnError{message, codexErrorInfo, additionalDetails, misalignment}, willRetry, threadId, turnId}` and/or `turn/completed` with `status:"failed"` and `turn.error`. `codexErrorInfo` values include `usageLimitExceeded`, `rateLimitExceeded`, `unauthorized`, `serverOverloaded`, `contextWindowExceeded`, `modelNotFound`, `badRequest`, `sandboxError`, and objects `{httpConnectionFailed|responseStreamConnectionFailed|responseStreamDisconnected|responseTooManyFailedAttempts:{httpStatusCode}}`. `account/rateLimits/updated` / `read` carry `rateLimitReachedType` (`rate_limit_reached | workspace_owner_credits_depleted | workspace_member_credits_depleted | workspace_owner_usage_limit_reached | workspace_member_usage_limit_reached`) and `spendControlReached`. `ChatgptAuthTokensRefreshParams` exists only for externally supplied tokens. Source: generated `$S/ts/v2/{ErrorNotification,TurnError,CodexErrorInfo,RateLimitSnapshot,RateLimitReachedType}.ts`. Not triggered live [U for exact wire examples].
- [D] `exec --json`: errors appear as `{"type":"item.completed","item":{"type":"error","message":...}}` (observed once in iso2 for the code-mode warning [V]) and, per pass-1 docs, `turn.failed` / `error` events; rc non-zero expected [U live].
- [D] Web search per call: no `--search` on `exec`; the config key `web_search` (`disabled|cached|indexed|live`) can be passed with `-c web_search=live` on exec or app-server command line; app-server `thread/start.config` accepts arbitrary config keys (dotted worked for MCP keys [V]); top-level interactive `codex --search` exists. `-c web_search=disabled` accepted [V]; enabling live search not run [U].
- [D/V partially] Model and effort per turn: `turn/start` params `model`, `effort` (ReasoningEffort is a free string; `low` accepted [V]), `summary`, `serviceTier`/`serviceTierForTurn`; "applies to this turn and subsequent turns". `thread/start.model` also accepted [V: luna and terra]. `model/list` exists [D, not called]. For exec: `-m` and `-c model_reasoning_effort=low` [V from pass 1].

## Call ledger (8 model calls, all trivial prompts)

| # | what | model/effort | tokens in / out | wall |
|---|---|---|---|---|
| 1 | exec tool list, most restrictive (`iso1.jsonl`) | gpt-6-luna / low | 12,198 (2,432 cached) / 45 | 5.0 s |
| 2 | exec tool list, + more disables (`iso2.jsonl`) | gpt-6-luna / low | 12,111 (6,912 cached) / 47 | 5.0 s |
| 3 | app-server free-text outline (`as1.jsonl`) | gpt-6-luna / low | 14,852 / 117 | 5.5 s |
| 4 | app-server `outputSchema` tree (`as2.jsonl`) | gpt-6-luna / low | 14,945 / 93 | 4.6 s |
| 5 | app-server JSONL + interrupt (`as3.jsonl`) | gpt-6-luna / low | not reported (interrupted) | 6.0 s |
| 6 | image: red apple (`img1.jsonl`, `img/apple.png`) | gpt-6-luna / low (default model) | 15,956 / 101 | 20.5 s |
| 7 | SVG contract (`svg1.jsonl`, `svg1.svg`) | gpt-6.1-terra / low | 13,923 / 1,443 | 28.7 s |
| 8 | image: transparent pear + reference (`img2.jsonl`, `img/pear.png`) | gpt-6-luna / low | 17,966 + 20,370 (17,920 cached) / 216 + 64 | 38.5 s |

Rate limit (weekly window, 10080 min): `usedPercent` 1 before and after the whole pass (integer-rounded); credits balance unchanged. No attempt by the model to use connectors, files outside the scratch dir, or the web was seen in any run. All probe processes exited (`pgrep` showed none of mine; other `codex` processes on the machine belong to the ChatGPT desktop app and were left alone).

## Re-run commands
```
S=/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/e978aa9d-83bf-4c61-9197-231fbb959d27/scratchpad/codex-probe2; cd $S
python3 mcp_iso_probe.py all_off                      # no model call; try baseline|empty_table|enabled_false|thread_config_dotted|plugins_off
python3 appserver_probe.py as1.jsonl "Write a 12-item nested outline about coffee as an indented list"
python3 appserver_probe.py as2.jsonl "<prompt>" --schema tree.schema.json
python3 appserver_probe.py as3.jsonl "<JSONL prompt>" --interrupt-after-ms 6000
python3 appserver_probe.py img2.jsonl "<prompt>" --sandbox workspace-write --ref-image img/apple.png --timeout 240
python3 appserver_probe.py svg1.jsonl "$(cat svg_prompt.txt)" --model gpt-6.1-terra   # then extract the final agentMessage text to svg1.svg
python3 check_svg.py svg1.svg
```
Artefacts: `$S/{appserver_probe.py,mcp_iso_probe.py,check_svg.py,tree.schema.json,svg_prompt.txt,svg1.svg,as1-3.jsonl,img1.jsonl,img2.jsonl,svg1.jsonl,iso1.jsonl,iso2.jsonl,schema/,ts/,img/apple.png,img/pear.png,ql/svg1.svg.png}`.

## Gaps
- Live error shapes for rate-limit exhaustion and expired auth not triggered.
- Per-call plan cost of an image not measurable (usage % integer, credits unchanged).
- In-thread "same style as previous image" (no attachment) not tested; reference-image attachment was.
- Whether the visual style of pear matches the apple was not assessed.
- Explicit image size/quality/background parameters are model-chosen; no client control found.
- `collaboration.*` and `functions.exec` tools cannot be disabled by any feature flag found; effect of the model using them not tested.
- Only one SVG sample and one model; behaviour with larger subtrees or `gpt-6-luna` unknown.
