# Verification

This file records how the bridge was tested and what was measured. The fixture tests establish adapter behavior. The live checks use real Claude Code, and where noted, the ChatGPT desktop app's own embedded runtime.

Development versions 0.2.0 to 0.2.22 served Claude Opus 5.5 only, in a separate window, so the measurements in the later sections were made on Opus. Version 0.3.0 added Sonnet and Haiku, model selection, API key mode, opt-in web search and picker mode; its checks come first.

## Release 0.3.0, checked October 4, 2026

| Component | Version |
|---|---|
| ChatGPT.app | 26.930.31730, build 12947 |
| Embedded Codex runtime | 0.160.0 |
| Claude Code | 2.1.287 |
| Node.js | 24.21.0 |
| macOS | 27.0 |
| MCP SDK | 1.30.1 |

Claude Code resolved the shipped aliases as follows, and reported these context windows in its own usage data. They match Anthropic's [models overview](https://platform.claude.com/docs/en/models/overview) and [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

| Picker entry | Alias | Model Claude Code started | Context window | Effort levels |
|---|---|---|---|---|
| Claude Opus | `opus` | `claude-opus-5-5` | 1,000,000 | low to max, default medium |
| Claude Sonnet | `sonnet` | `claude-sonnet-5-5` | 1,000,000 | low to max, default medium |
| Claude Haiku | `haiku` | `claude-haiku-4-5-20251001` | 200,000 | none |

A bounded probe of each alias with the bridge's own Claude Code flags showed no usage by any other model, and Haiku accepted `--effort` without effect. The bridge passes no effort flag for Haiku.

### Automated tests

131 tests pass: 105 Node tests and 26 Python tests. The Python tests also pass on `/usr/bin/python3` 3.9.6, which runs the LaunchAgent. The integration suite uses a deterministic stand-in for Claude Code plus the real MCP SDK client and server transport. New in 0.3.0:

- Each catalog model starts Claude Code with its own model, effort and display name; Haiku gets no effort flag.
- Unknown models and unsupported efforts are refused with HTTP 400 before Claude Code starts.
- An alias is pinned to the model Claude Code first started for it. An alias accepts another version of its family (an organization restriction can substitute one); a pinned model id or another family is refused.
- A different model mid-turn (Claude Code's safety-classifier fallback) fails the turn with an explanation.
- Switching Claude models between turns resumes the native session on the new model. A model change while Claude waits on a tool result rebuilds from the transcript. A compaction fork keeps the session's model.
- Login mode: inherited `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_BASE_URL` never reach Claude Code. API key mode passes only the configured key and never logs it; without a key the request fails clearly and nothing starts.
- Claude Code is found through `CLAUDE_BIN`, then PATH, with an install hint when missing.
- Web search is refused unless the bridge opts in. The setup builder points the profile at the bridge, removes global context-window overrides, keeps other settings, and replaces an older provider block. AGENTS.md and skills are shared only on request.
- The desktop catalog lists each model with its own effort levels, context window and compaction limit (80% of the window).
- Requests for GPT lose the ids of items Claude wrote and keep every other id, over HTTP and WebSocket.
- The scripts never read the separate window's own profile as your ChatGPT profile, even when `CODEX_HOME` points at it, and picker mode refuses a profile that uses another model provider.

### Live checks with real Claude Code

`node e2e/live.mjs` runs these in-process through the bridge, at low effort with short prompts. All nine passed.

| Check | Result |
|---|---|
| Opus, Sonnet, Haiku | Each answered READY from the expected model, with context windows 1,000,000, 1,000,000 and 200,000 |
| Tool call (Opus) | Called `run_job` once and answered from its output; 1,356 of 1,452 input tokens came from the cache |
| Mid-turn message (Opus) | "Got it, I'll skip deploy and only run test next." appeared before the next tool call |
| Image (Haiku) | A 16 by 16 red PNG was answered "Red" |
| Model switch | Turn one on Opus, turn two on Sonnet: Sonnet recalled the code word in the same resumed native session |
| Stop, then continue (Opus) | The stopped session resumed and named the story's keeper; 665 of 1,032 input tokens came from the cache |
| Compaction (Sonnet) | Forked the live session; the checkpoint kept both facts; 862 of 1,785 input tokens came from the cache |

The cache shares above are low because the prompts are tiny. In daily use with the desktop's full prompt and tools, 97 to 98% of input tokens were read from the cache.

### Desktop runtime

`scripts/setup.py` built an isolated profile on port 19490. The app's own Codex runtime (`codex exec` from the app bundle) then ran one task per model: run `python3 -c 'print(17*19)'` with the shell tool and reply with the number. Haiku, Sonnet and Opus each called the tool and answered 323 (17,463, 23,074 and 23,066 tokens). Setup read the normal profile without changing it: `config.toml` and `models_cache.json` had the same hashes before and after.

API key mode was checked with the fixture; the live checks used a Claude Code login.

### Picker mode

Picker mode points the app's built-in OpenAI provider at the bridge with `openai_base_url`. The choice was made after reading the Codex 0.160.0 source. A custom provider in `requires_openai_auth` mode, the other documented route, would change GPT: custom providers get no WebSocket transport by default, no remote compaction (only the `openai` provider gets remote compaction v2), and no internal tool metadata or workspace routing. With `openai_base_url` the app keeps its own provider, and the bridge relays GPT traffic unchanged. Workspace routing rewrites the provider URL only when it is `chatgpt.com` or was routed before, so it cannot route around the bridge.

Fixture tests with stand-ins for OpenAI (HTTP and WebSocket) and Claude Code cover: GPT requests relayed byte for byte, including zstd bodies and the app's headers; the model list gaining the Claude entries with a tagged ETag, and `If-None-Match` and 304 handled; the handshake headers the app reads (`x-codex-turn-state`, `openai-model`, `x-reasoning-included`) passed through; a wrong key refused before anything reaches OpenAI; Claude over WebSocket with prewarm, a tool cycle sent as increments, `previous_response_not_found`, and an interrupt ending as `response.incomplete` followed by a resumed turn; remote compaction returning exactly one checkpoint item; that checkpoint turned into text for GPT; a GPT checkpoint replaced by a note for Claude; GPT's turns delivered to a resumed Claude session; OpenAI unreachable (502, failed handshake) and an expired login passed through as sent. Python tests show `picker.py` adds one marked line, backs up both files, refuses an existing `openai_base_url`, restores the original bytes on uninstall, and keeps later edits when the file changed.

The app's own runtime (`codex exec` from the app bundle) then ran against a throwaway profile whose only special setting was `openai_base_url`, with a local stand-in for OpenAI that served the real GPT model list and answered GPT requests with fixed text. Real Claude Code answered every Claude request:

| Check | Result |
|---|---|
| Claude Sonnet with a shell tool | Ran over the app's WebSocket; the hosted `web_search` tool in GPT's tool list was left out; answered 323 |
| GPT through the relay | The prewarm and the incremental request reached the stand-in over WebSocket; its reply came back |
| Forced compaction on Claude Haiku | Compacted mid-turn over WebSocket, continued in the next context window, and answered "HERON step-one step-two" |
| Sonnet, then GPT, then Opus in one thread | Opus resumed Sonnet's native session with GPT's turn as history and answered: "The code word was KESTREL, and the previous assistant reply said exactly "FAKE-GPT over WebSocket"." |

#### Against real OpenAI

Picker mode was then installed on a real, signed-in ChatGPT profile with ChatGPT 26.930.31730 (Codex 0.160.0) and Claude Code 2.1.287. A test client drove the app's own `codex app-server` from the app bundle, the process behind the ChatGPT window, on that profile with the same flags as the app. Each check used one ephemeral thread, low effort and short prompts:

| Check | Result |
|---|---|
| Model list | The 8 GPT models OpenAI listed for the account, then Claude Opus, Claude Sonnet and Claude Haiku |
| GPT with a shell tool | Ran through the relay over WebSocket and answered 323 |
| Claude Opus after GPT, with a shell tool | Saw GPT's turn and answered "667,323" |
| GPT after Claude | Read Claude's turn and answered "KESTREL 323 667" |
| Image on Claude Sonnet | A red PNG: "Red" |
| Message sent mid-turn | "skip deploy" arrived during the second of three shell calls; Claude acknowledged it in visible text and ran only build and test |
| Stop, then continue | The Claude turn ended as interrupted; the next turn knew it had stopped at 32 |
| Compaction on Claude, then GPT | One checkpoint; GPT read it as text and recalled KESTREL |
| OpenAI's remote compaction over a mixed history, then Claude Haiku | OpenAI compacted a history containing Claude's items; Haiku continued from the kept messages and recalled KESTREL |
| Stop on GPT | The interrupt reached OpenAI and the turn ended as interrupted |

In the first run one GPT request failed: after an OpenAI compaction and a Claude Haiku turn, OpenAI rejected the next GPT request with "Supplied input item IDs require persisted-item lookup". A trace of what the bridge sent to OpenAI (item types and id prefixes only) showed that Claude's items still carried the bridge's own item ids, such as `msg_…` and `ctc_…`, which look like OpenAI's. OpenAI accepted them in most requests but sometimes tried to look them up in storage, which it cannot do for a request that is not stored. Bridge ids now carry a `claude` mark that OpenAI's hexadecimal ids never contain, and the gateway removes those ids, and only those, from requests for GPT. With the fix, a traced run sent no bridge id to OpenAI, and the full set of checks passed through the traced bridge and again through the installed service.

Installing on the real profile also found two script problems, both fixed: `install.py` ignored its arguments, so `install.py --help` ran the installer, and a terminal inside the separate window inherits `CODEX_HOME` set to the bridge's own profile, which the scripts then read as your ChatGPT profile. `install.py` and `launch.py` now parse their arguments, the scripts fall back to `~/.codex` when `CODEX_HOME` is the bridge's own profile, `setup.py` and `picker.py` print the profile they use, and `picker.py` refuses a profile that uses another model provider.


## Desktop and live checks in 0.2.0

| Test | Observed result |
|---|---|
| Model selection | Claude Opus 5.5 appeared in the isolated app's picker |
| In-app browser | Opus opened example.com through the browser tool and read "Example Domain" |
| Native computer control | Opus opened Calculator, corrected a mistaken first keypress, and confirmed 17 × 19 = 323 on its display |
| Tool-image input | Opus received real image bytes and read the model label from a screenshot |
| Terminal through the desktop runtime | Host tool execution returned 323 |
| Native session continuity | A later turn remembered a verification phrase; logs show the native session resumed instead of rebuilding |
| Mid-tool correction | "ORIGINAL" was corrected to "UPDATED"; the live reply was "UPDATED 323" |
| Bridge restart | The resumed native session kept the phrase after the bridge restarted |
| Edited history | Replacing an earlier message produced only the new phrase |
| Regeneration | A new turn with identical user input started fresh inference |
| Compaction through the app runtime | `thread/compact/start` completed, and the next reply kept the phrase |
| Supervised restart | Stopping the idle bridge made launchd restart it |
| Node discovery | The resolver found a working Node with none on PATH and an invalid saved path |

The browser and Calculator test was typed by hand in the isolated window, and its tool events and final result were inspected. No result was supplied by hand in place of a tool result.

## Review fixes in 0.2.1 and 0.2.2

- History divergence: every successful response records a fingerprint of the conversation. Edited, shortened or regenerated history rebuilds from the app's transcript. Message metadata the app adds when saving a reply does not count as an edit.
- Plugin updates: the first sync copied a new computer-use plugin with a descriptor that still pointed at the normal profile. Descriptors are now rewritten and checked before a copy is published; existing copies are repaired; file URLs and embedded paths are handled; a remaining source path or a symlinked descriptor stops the sync.
- Tool ordering: a tool call can arrive over MCP before Claude Code reports it on stdout. The bridge waits up to three seconds for the match and refuses unmatched calls.
- Separate ChatGPT login: the app's embedded runtime was run against a fake OAuth server with fabricated credentials. Concurrent refreshes in two instances sharing one credential file sent the same refresh token twice, so the isolated window signs in separately instead of sharing `auth.json`.
- Tool failure recovery: after a real MCP client timeout, the next request imports the observed tool result and completes without running the call again.
- Cancellation: an immediate continuation waits for the stopped process to close, and a new user message can abandon a tool cycle that has no result.
- Instruction changes: a changed developer message during a tool cycle rebuilds with the new system prompt and the observed tool output. Live, Opus applied the new instruction and did not call the tool again.
- Image history: a compressed request with 300 synthetic 114 KiB screenshots, over 32 MiB decompressed, succeeded for inference and compaction; 71 images were kept and earlier ones replaced with markers. Crossing the image window with a live session rebuilds once, then resumes. User images and all tool text are kept. Oversized current attachments fail with an explicit error.
- Request options: forced tool choice, output-token caps, non-JSON text formats and `parallel_tool_calls=false` with tools enabled get HTTP 400 instead of being ignored.
- Memory: finished responses release their buffers, and idle sessions are evicted while their small disk records remain. Both the fixture and real Opus resumed after eviction.
- Upgrade recovery: injected startup and health-check failures restore the previous application, configuration and LaunchAgent, then restart it.
- In the installed app runtime, a task ran `python3 -c "print(17*19)"` and returned 323, a second turn recalled a phrase, and after `thread/compact/start` a later turn recalled it again.

## Standalone web search in 0.2.3

A captured log from another Responses-compatible provider showed the request shape: 126 successful search and open requests. Fake-upstream tests cover exact forwarding, the optional account header, the local key, refusal to forward the bridge key, sign-in errors, redirects, changed endpoints, non-JSON and malformed responses, malformed input, compressed requests, timeouts and log privacy. Logs hold only status and command types, plus the request's header names once.

Live through the app runtime, Opus completed one `search_query` and one `open`, both HTTP 200. The request carried `authorization`, `chatgpt-account-id` and `x-claude-bridge-key`; the bridge forwarded the first two to the fixed search endpoint and kept the bridge key on the local hop. See OpenAI's [web search configuration](https://learn.chatgpt.com/docs/web-search) for the provider setting. Search became opt-in in 0.3.0.

## Tool documentation and unknown tools in 0.2.4

Code mode documents every nested tool inside the `exec` description, measured at 355,479 characters. Claude Code 2.1.280 cut MCP descriptions at 2,048 characters unless `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` is set, so Opus saw under 1% of it and guessed a top-level `web_run` tool, which the bridge treated as fatal. The bridge now raises the limit, lets Claude Code answer unknown tool names itself, and names `tools.web__run` in the system prompt when search is on. Live, Opus then completed `search_query` and `open` on the first attempt.

## Patch format and prompt corrections in 0.2.7 and 0.2.8

The app sends `apply_patch` as a custom tool with a Lark grammar that constrains GPT's output. MCP cannot carry the grammar, so Opus guessed the format. The bridge adds a patch format guide and a note on escaping backticks, backslashes and `${...}` inside JavaScript template literals. The system prompt also tells Claude to ignore Claude Code's working-directory note and renames the leftover "As Codex, you are" line.

Measured with a logging proxy and hidden-test tasks run headlessly through the app runtime at high effort on September 25, 2026. Five tasks, one run each: all 25 runs passed across Claude Code 2.1.281 and four bridge variants. Three harder tasks (an in-place edit with backticks, `${...}`, heredocs, Makefile tabs and Unicode, plus two real bug fixes in the open source `humanize` library graded by its upstream regression tests), two runs each:

| Setup | Passed | Mean time | Tool errors per task |
|---|---|---|---|
| Claude Code | 6/6 | 48 s | 0 |
| Bridge 0.2.6, code mode | 6/6 | 51 s | 0.83 |
| Bridge 0.2.6, direct tools | 6/6 | 45 s | 0.17 |
| Guide and notes, code mode | 6/6 | 40 s | 0.17 (a test script, not an edit) |
| Guide and notes, direct tools | 6/6 | 38 s | 0 |

On the two escaping-heavy tasks, four runs each, 0.2.6 made 8 patch or escaping errors and 0.2.7 made none, at the same mean time (69 s). Most remaining errors were the app refusing `rm -rf` cleanups (14 in 40 runs): with approvals off it rejects any command line containing `rm -f` style flags, including everything chained with it. 0.2.8 tells Claude this.

## Deferred connector tools in 0.2.9

With `supports_search_tool` false in the catalog entry, the app inlines every connector's documentation into `exec`: a new Opus thread used 182,384 to 191,023 input tokens for its first reply, against 21,574 to 30,096 for GPT threads. With it true, `exec` documents only the core tools (28,724 characters instead of about 357,000) and lists connector tools in `ALL_TOOLS`. "hi" then used 28,976 input tokens, and Opus found and called a calendar connector tool through `ALL_TOOLS`.

## Helper agents in 0.2.11

Multi-agent v2 passes tasks and results between agents as `agent_message` items. The bridge renders each as labelled text and treats unseen ones as new input. Live, a helper spawned without overrides inherited the parent's effort, replied, and the parent reported its answer.

## Dropped tool calls, PDF renders and exec output in 0.2.12

A benchmark on September 27, 2026 used seven hidden-test tasks: parallel slow probes with a transient failure, a 60,000-line log plus a 3 MB one-line JSON file, byte-exact edits, a long test suite with a TTY-only wizard and a slow dev server, values only in a PNG and a scanned PDF, three parallel helper agents, and a git bisect plus a conflicting revert. The bridge in code mode passed 14 of 14 runs, Claude Code 2.1.281 passed 13 of 14, and the bridge with direct tools passed 7 of 7. Time, model calls and output tokens were within about 20% on every task. Three fixes followed:

- When helper answers arrive while a response streams, the app drops that response's tool calls, which never ran, and samples again with the answers appended. The bridge had treated this as an edited history and rebuilt the session. It now answers the dropped calls as not run and passes the messages to the live session.
- Opus rendered PDF pages into the project folder; the note now says to use a temporary directory.
- One command in a batched `exec` cell printed a 3 MB one-line file, and the cell's 10,000-token middle cut hid the other results. The `exec` description now explains the shared budget.

## Exec-only tools and stream keepalives in 0.2.13

A second round covered review mode, JSON-schema output, an attached screenshot, a repository skill, a nested AGENTS.md, a 300-file codebase, a spec-driven bug hunt with 24 hidden tests, a notebook fix, a forked thread, Plan mode and an inline visualization. The bridge matched Claude Code on every shared task, and in review mode the app rendered its findings as native review comments.

- Across 269 transcripts Opus called an `exec`-only tool at the top level 12 times; one rejected call carried a 15,000-character file and cost 54 seconds. The system prompt now names those tools.
- The app's stream idle timer ignores SSE comments, so comment keepalives did not keep a long silent stretch alive. Keepalives are now `response.in_progress` events left out of cached replays. With a 15-second idle timeout and a fixture silent for 32 seconds, 0.2.12 failed after 17 seconds and 0.2.13 completed.

## Long tools, large results and slash messages in 0.2.14

From 32 native sessions and 472 relayed tool calls:

- Claude Code aborts an HTTP MCP call after 300 seconds without progress (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). Five `clock.sleep` calls and fifteen long `exec` calls ended this way while the app kept running them. With the limit off, a 330-second call returned after 332 seconds and Claude answered from it.
- Claude Code reads a user message that starts with `/` as a command, even with slash commands disabled, and answered `/compact Reply with the single word PONG.` itself without calling the model. Wrapped in tags, the message reached the model, which replied PONG.
- Claude Code moved MCP results over 25,000 estimated tokens to a file. Four browser results of 80,000 to 107,000 characters cost an extra round trip each. With the token cap at 200,000 and a declared result size of 1,000,000 characters, a 120,000-character result arrived whole.

## Mid-thread developer notes in 0.2.15

The app adds developer notes as a thread goes on: across 21 threads there were 88, mostly the date and time, the open page, the skills list, interrupted turns and image resizes. When each one changed the system prompt, a 132-character image-resize note during a tool cycle forced the import of a 965,434-character transcript, and six turns started within the cache lifetime rewrote 85,000 to 393,000 tokens each (1.31 million in total). Only developer messages before the conversation now form the system prompt; later notes reach Claude where the app placed them.

## Compaction from the live session in 0.2.16

Importing the context window as text into a fresh session matched nothing in the prompt cache: four compactions on one thread, each within an hour of the last activity, wrote 231,662 to 458,998 tokens (1.42 million in total). At a turn boundary the bridge now forks the native session with its own system prompt, tools and effort.

- Live on a 7,000-token thread, the fork read 6,700 tokens from the cache and wrote 682, where the text import wrote 6,279. The fork's checkpoint kept all 120 rows of a table, each correct, after the request was changed to say that answer-style instructions do not apply to it.
- With the app runtime forcing compaction after the first tool call, all 50 compaction requests resolved to their own window's session.
- A compaction during a tool cycle had left the old process waiting; the bridge now stops it once the compaction succeeds.

## Resuming stopped turns in 0.2.17

Over eight days, 11 rebuilds after a Stop wrote 1.43 million tokens to the prompt cache (36,584 to 494,529 each) and lost Claude's thinking and exact tool results. Claude Code 2.1.287 leaves a consistent transcript when stopped: on SIGINT it records the partial answer, a tool call it was waiting on gets a rejected result, and after SIGKILL `--resume` adds the missing result. The bridge now resumes the stopped session and sends only what the app added after the stop, with a note when a stopped tool call may have run in the host.

- Live, a Stop mid-response resumed the same session with a 1,160-token cache read, and Opus recalled the story it had started.
- Live, a Stop while the host ran a tool resumed with a 1,392-token cache read, and Opus said the host may have run the job.

## Checkpoint delivery and idle compactions in 0.2.18

The app summarizes a compacted window with the last assistant message in its history and drops the `compaction` item, so 13 checkpoints written between September 30 and October 2, 2026 never reached the next window. The compaction response now carries the checkpoint as an assistant message, followed by the sealed item.

A fork's cache is never read again, and Claude Code writes caches at twice the input price. A thread idle for 68 minutes wrote 441,540 tokens on compaction. When the forked session is more than an hour old, the fork now runs with `DISABLE_PROMPT_CACHING=1`. Live, such a fork reported no cache write and still answered from the session's history, and the next window answered with the facts from the first turn.

## Visible replies to mid-turn messages in 0.2.19 to 0.2.21

Claude Code shows a message sent during a turn to the model with the next tool result. Of 83 such messages from October 1 to 3, 2026, 37 got visible text before the next tool call, 40 were acknowledged only in thinking, which the app does not show, and 6 not at all.

- 0.2.19 adds a short note asking for one visible line before the next tool call. Live, during a three-job tool cycle, "btw skip deploy, the server is down" got "Got it. I'll skip deploy and just run test next." before the next call.
- 0.2.20 says the line must be visible text, not only thinking.
- A message carrying a screenshot could still be parsing when the tool result returned, so Opus took its next step without it. Claude Code 2.1.287 confirms a queued stdin message within milliseconds, and 0.2.21 releases the tool result only after that confirmation, or after 5 seconds. Live, twice, a mid-turn message with a screenshot was answered before the next call, once describing the screenshot.
- When the first step after a mid-turn message has a tool call, no visible text and a thought of at most 600 characters, the thought is shown as commentary.

## Stopped host sleeps in 0.2.22

The app runs `clock.sleep` itself, and a Stop during the sleep sends the bridge nothing, so Claude Code waited on a stopped 15-minute sleep and held the session. The bridge now stops the turn once a sleep's stated duration plus five minutes has passed with no result. Live with a 5-second grace, a 20-second sleep that was never answered was stopped at 27.9 seconds, and the next message resumed the same session.

## References

- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Claude models overview](https://platform.claude.com/docs/en/models/overview)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
