# Verification

This file records how the bridge was tested and what was measured. The fixture tests establish adapter behavior. The live checks use real Claude Code, and where noted, the ChatGPT desktop app's own embedded runtime.

Development versions 0.2.0 to 0.2.22 served Claude Opus 5.5 only, in a separate window, so the measurements in the later sections were made on Opus. Version 0.3.0 added Sonnet and Haiku, model selection, API key mode, opt-in web search and picker mode. Version 0.3.1 added Fable and names that carry the model version. Version 0.3.3 moved Haiku to 5.5 and added the one-line installer. Version 0.3.5 brought seven fixes from the separate-window bridge, 0.3.6 fixes found in a review of picker mode, 0.3.7 fixes from an adversarial review of the whole project, 0.3.8 fixes from reviews that drove the app's own runtime, plus resuming instead of rebuilding, and 0.3.9 web search in the picker. Version 0.3.13 moves the separate window's new chats to the app's own provider, 0.3.14 updates dependencies, 0.3.15 brings fixes from a verification pass of the whole project, 0.3.16 reads chats with hundreds of megabytes of screenshots, 0.3.17 trims the screenshots a compaction keeps, 0.3.18 counts images at the size Claude Code sends, 0.3.19 moves the separate window's earlier chats to its provider, 0.3.20 has Claude answer a mid-turn question when it arrives, 0.3.21 shows the progress Claude writes in its thinking, 0.3.22 marks the messages a compaction kept between turns as earlier turns, and 0.3.23 compacts idle chats before the prompt cache expires. The newest checks come first.

## Release 0.3.23, checked November 6, 2026

### Idle compaction

Claude Code 2.1.299 added idle compaction. A conversation of 200K tokens or more that is idle for 90% of its one-hour cache lifetime is compacted, and the next message uses the summary only if the cache has expired. Claude Code runs this inside a live process. The bridge starts Claude Code for each turn, so Claude Code's idle compaction never ran for it.

In the bridge this project grew from, 397 native sessions were idle for 54 minutes or more after a request of 200K tokens or more, from October 23 to November 6, 2026. The requests averaged 380K tokens. 37 were resumed on a cold cache and wrote 11.1M tokens to it again, and 2 were resumed while it was warm. 192 belonged to a thread that had moved to a new session within 54 minutes, mostly after a compaction by the app, and 65 were subagent threads. The bridge skips subagent threads and threads that moved on, so about 140 compactions would have run for the 37 cold returns. At list prices, one compaction costs about a tenth of writing its conversation to the cache again.

Claude Code 2.1.317 refuses `/compact` under `--disable-slash-commands` with "/compact isn't available in this environment." Without that flag, `/compact` after `--resume <id> --fork-session` compacts the fork and leaves the original session unchanged. Neither flag changes the prompt, so the compaction reads the session's cache. Turns keep `--disable-slash-commands`.

This project's catalog names models by alias, such as `opus`, and a turn pins the alias only after Claude Code has started it once. The record of each turn now keeps the model it ran. The compaction pins the alias to that model, so it reads that model's cache. A compaction that Claude Code starts or reports on another model is not kept.

New tests cover the fork's settings and model, a cold and a warm next turn, a new message and a compaction by the app during an idle compaction, a tool call during one, a failed and a refused compaction, a compaction on another model, a compaction that ends after the session changed, subagent threads, small turns, a late timer, a thread that moved on, a restart, a compaction by the app after the cache expired, and `settings.json`. Undoing each of 22 parts fails a test. Three more parts are second checks: the bridge checks twice that a compaction happened and twice that it ran on the session's model. Undoing both checks of either pair fails a test.

The live `idle` scenario ran real Opus 5.5 at `xhigh` effort on Claude Code 2.1.319, over a 25K-token stock list with a tool call. The compaction read 25,343 of 25,541 tokens from the cache, wrote 59 and output 2,504, in 22 s. The cold return started with the notice, read 3,274 input tokens against 25,422 for the first turn, and still gave the line's name, the build result and the quantity of the item the user had flagged. The warm return read 25,420 of 25,576 input tokens from the cache and dropped the summary. A list of random word pairs was stopped by the model's safety classifier, and Claude Code retried on Opus 4.8, which the bridge refuses, so the scenario uses a plain stock list. 227 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 72 Python tests pass.

## Release 0.3.22, checked November 6, 2026

### Kept messages after a compaction between turns

In the bridge this project grew from, after a manual compaction, Opus opened the next window with "I'll start by looking at the 54 images you attached". The compaction kept 114 of the user's earlier messages, with 54 screenshots, and no answers between them. A new Claude session shows the app's history as earlier turns, in `<history_message>` tags with a note on its images, only when the history holds an answer or a tool call. A compaction between turns keeps neither, so the kept messages, the checkpoint and the new request reached Claude as one new message with 54 attachments. A compaction in the middle of a turn keeps that turn's tool calls after the checkpoint, so it was shown as history.

A checkpoint now marks the history as earlier turns too, and the note on images counts only the messages after the last checkpoint as the new request. It says the messages before the checkpoint were kept from earlier turns when the conversation was compacted.

That thread's real compaction and next message went to a throwaway bridge with real Opus 5.5 and the question "how many images did I attach to this message?" added. With the earlier code both runs answered 54, and with this release both answered 0. New tests cover the next window after a compaction with and without an image pasted with the new request, and a raw compaction item, and undoing each part fails one of them. 213 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 72 Python tests pass.

## Release 0.3.21, checked November 5, 2026

### Progress Claude writes in its thinking

When Claude writes its progress between tool calls in its thinking instead of as text, the API returns that prose only as a summary, in a thinking block whose signature marks it `narration`. Reasoning is marked `thinking`. Claude Code 2.1.317 reads the mark from the signature, a protobuf, at field 2, then 1, then 8, and shows narration with "summarized" after it. The bridge showed a thought only as the reply to a mid-turn message, so the app dropped the rest.

In the bridge this project grew from, 1,536 Claude Code transcripts on November 5, 2026 held 19,755 thinking blocks with narration text, between 1 and 582 characters with a median of 231. Every other thinking block was empty. No API response held both narration and text, 19,756 held only narration and 29,899 only text, so these summaries were about 40% of the progress Opus wrote. They read like any other update, for example "The 'Sign in' flash is real: a signed-in user sees it for about 450 ms when going from the dashboard to the home page."

The bridge now reads the mark from each thinking block's signature when the block ends, and shows narration as commentary, also in the turn's last message, where the answer stays the text after it. A checkpoint leaves narration out and keeps only the summary Claude writes for it. Reasoning stays private. The decoder follows Claude Code's, and it agrees with a separate Python decoder on all 88,921 thinking signatures in those transcripts.

Tests cover a signature with other fields, a repeated field, a 64-bit field and a two-byte length, bad input, narration before a tool call and in the last message, private reasoning, a compaction, and the next request resuming without a rebuild. Undoing each part fails a test. `node e2e/live.mjs narration` runs 4 jobs with Opus at `xhigh` effort, and in 2 of 2 runs 3 of the 4 updates were narration, with one final answer and the next message resuming. 211 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 72 Python tests pass.

## Release 0.3.20, checked November 5, 2026

### Mid-turn questions answered when they arrive

In the bridge this project grew from, a user asked a question mid-turn twice, and both times Opus replied that it would answer at the end. The note the bridge sends with a mid-turn message asked for one short line saying what Claude would do because of it, and for a question that line was a promise. The note now asks Claude to answer a question it can already answer, in full and in visible text, before its next tool call, and keeps the one short line for anything else.

Over 8 rounds with real Opus 5.5 at the same point in a tool cycle, the earlier note deferred a question about race conditions twice, with replies such as "I'll answer your race-condition question once all three jobs are done", and the new note never did. `node e2e/live.mjs steer` now asks that question as well as sending the instruction to skip a job, and passed both checks in 2 of 2 runs. 208 Node tests pass.

## Release 0.3.19, checked November 5, 2026

### Earlier chats moved to the window's provider

ChatGPT desktop 26.1029.61003, released November 3, 2026, runs Codex 0.166.0-alpha.6, which resumes a chat only on the provider the window selects. Since 0.3.13 the separate window selects the app's own `openai` provider, so chats started there before 0.3.13 are saved on `claude_bridge`, and opening one shows "Failed to resume chat. This chat uses claude_bridge, but your current provider is openai." In the bridge this project grew from, 475 chats were saved that way. The runtime also no longer starts a `claude_bridge` chat in a window on the app's provider. Picker mode is not affected, since its chats stay on the main window's provider.

Both providers reach the bridge, so a chat can move between them. Codex reads a chat's provider from its state database when it resumes it, and the resumed chat then records the new provider in its rollout. With the bundled runtime on a copy of a failing chat, changing the provider in the database alone let it resume, and changing only the rollout's `session_meta` did not. `install.py` and `launch.py` now call `follow_window_provider` after `set_app_provider`. When the window's `openai_base_url` is this bridge's, it moves every chat saved on the other of the two providers to the one the window selects, in both directions, and leaves chats on any other provider alone. The update touches only `model_provider`, so the sidebar order stays. A database the app holds locked for 10 seconds is reported and left as it was.

`node e2e/app-runtime.mjs` now starts the legacy chat in a window still on `claude_bridge`, then checks that the alpha.6 runtime refuses it, that the installer's move takes it to the app's provider while that runtime runs, and that it then resumes with its history. It passed 30 of 30 with Claude Code 2.1.317 on desktop 26.1029.61003. Four new Python tests cover both directions, the sidebar order, windows that reach something else, including the picker's `/g/` route, and a busy database, and undoing each part of the move fails one of them. 208 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 72 Python tests pass, 66 of the Python tests under the system Python 3.9.

## Release 0.3.18, checked November 4, 2026

### Images counted at the size Claude Code sends

In the bridge this project grew from, one thread rebuilt its Claude session 9 times in 25 minutes, near the end on almost every tool call. Each of Claude's code runs in that thread returned 2 to 4 renders, PNGs of 2048 by 576 pixels at about 3 MiB each, so one call added up to 12 MiB to an image window of 8 to 16 MiB, and each move of the window rebuilt the session from the app's transcript. This project has the same window.

Claude Code resizes each image to at most 2000 px a side and compresses it to a 500 KB budget before it sends a request. In Claude Code 2.1.317 these are `maxWidth: 2000` and a byte budget of 512000, and its transcripts for that bridge's sessions hold no image over 0.64 MiB of base64, from tool results and from the prompt of a rebuilt session alike. The window now counts each image at no more than that budget, 0.65 MiB, and so does the check on the whole request. The thresholds are unchanged. Claude Code also caps the media in a request and drops images and retries when the API reports a request as too large, and the first-party API takes requests of up to 128 MB (checked November 4, 2026), so an image Claude Code could not compress still fits.

Replaying that thread's 146 requests since its last compaction through the image window, the window moved 9 times with 0.3.17 and 3 times with 0.3.18. The image window tests now use images under the budget, so each still tests the window's order, and a new test sends renders of 3 MiB. Undoing the budget in the window, in its total or in the request check each fails a test. The stand-in Claude Code echoes long base64 as a marker, so the 84 MB chat test, which now keeps all 20 of its images, counts them. 208 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 68 Python tests pass.

## Release 0.3.17, checked November 4, 2026

### Screenshots kept by a compaction

In the bridge this project grew from, a thread compacted in the middle of a turn, and every request after it failed with "The model input still exceeds 24 MiB after bounding earlier images." The compaction kept 44 of the user's messages ahead of its checkpoint, with 26 screenshots totaling 30.8 MiB, and dropped the answers between them. The image window treats attachments since the model last finished a turn as the current request and never removes them. With no answer left in the history, it read all 44 messages as the current request. This project had the same window.

The messages a compaction kept now count as earlier turns, apart from the newest, which a compaction in the middle of a turn keeps for that turn. The server turns the checkpoint, Claude's or GPT's, into a `<context_checkpoint>` message before the session reads the request, so the window looks for that message as well as the raw item. `test/image-history.test.mjs` builds the same shape with the server's own checkpoint text. Undoing the change, the guard for the newest message, or the match on the checkpoint message each fails it.

The failing request, rebuilt from its rollout (52 items, 30.9 MiB) and sent to a bridge with the stand-in Claude Code, got the same 413 from 0.3.16. 0.3.17 replaced the 23 oldest of the kept screenshots with placeholders and got a reply. 207 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 68 Python tests pass.

## Release 0.3.16, checked November 3, 2026

### Chats full of screenshots

The bridge this project grew from hit a thread with 117 screenshots from tool calls (268 MB of base64) that failed on every retry with `413 Payload Too Large: Cannot create a Buffer larger than 268435456 bytes`. The app sends the whole chat with each request, compressed, and the bridge refused any body over 256 MiB once unpacked. This project had the same limit, in the separate window and in picker mode. Raising it alone would not have lasted: V8 can't hold a string longer than 512 MiB, and the bridge read, hashed and measured each request as one string.

`src/large-json.mjs` now reads a body over 64 MiB with each `"data:image/..."` string cut out of the bytes first, parses the rest, and puts the images back as separate strings. Hashing (`digest`), the image window's size count and the body picker mode relays to OpenAI are written in pieces once they would pass 256 MiB. Each gives the same result as plain `JSON.parse`, `JSON.stringify` and the same hash, so session records and cached replies stay valid. The limit is now 1 GiB for HTTP bodies and picker WebSocket messages, and past it the app shows "This chat is over 1 GiB with its images, more than the bridge reads. Continue in a new chat." instead of Node's error.

`test/large-json.test.mjs` compares the reader with `JSON.parse` on generated bodies with whitespace between tokens, escaped quotes before `data:image/`, strings with escapes and keys that start with `data:image/`, and the writer, size and hash with `JSON.stringify` on values with `undefined`, functions, symbols and `toJSON`. Undoing any of its six guards fails a test. `test/integration.test.mjs` sends an 84 MB compressed chat through the bridge, and, with `LARGE_REQUEST_TEST=1`, a 630 MB one, past both the old limit and the longest string, which 0.3.15 answers with 413 and 0.3.16 with Claude's reply. `test/gateway.test.mjs` sends a 75 MB chat to Claude and another to GPT in picker mode.

206 Node tests, one more with `LARGE_REQUEST_TEST=1`, and 68 Python tests pass.

## Release 0.3.15, checked November 3, 2026

This release comes from a verification pass over the whole project. Three independent reviews covered the installer and config editors, the GPT relay, and the session and protocol code. Property tests ran every `config.toml` editor on generated files. A mutation check undid each fix in turn to confirm a test fails without it. A sandbox ran a full install, a switch each way, an update and both kinds of uninstall.

### Config edits

The editors now share one reader of TOML statements, in `scripts/bridge_config.py`. It lists each statement in the root table with its span, so a line inside a multi-line string or array is never read as a setting or a table. Keys are compared the way TOML compares them, quoted or dotted, with spaces around the dot or without. `setup.py`, `set_app_provider`, `set_standalone_search` and the picker all use it. `set_standalone_search` writes `features.<name>` in the root table when the file already sets its features that way, instead of adding a second `[features]` table.

`test/test_config_properties.py` generates files with comments, all four string kinds, multi-line strings and arrays holding lines that look like settings or tables, CRLF and dotted keys, and runs each editor on them. `tomllib` reads every result. It must parse, hold the intended root settings, leave every other setting as it was, and come out the same from a second run. A second pass runs the editors without their own parse check, as macOS's Python 3.9 does. On 0.3.14 the harness found 8 kinds of failure, among them settings inside multi-line strings edited as if they were settings, and `features.goals = true` in the root table getting a second `[features]` table, which makes the file unreadable. The fixed code passed more than 13,000 generated files with no failure.

### Picker mode

- `--window` takes Claude out of the picker before it opens the window, so GPT goes straight to OpenAI again. Before, the picker setting stayed.
- If the setting went while the state file stayed, for example with a dotfiles sync, install adds it again instead of reporting that picker mode is on, and `status` reports it off.
- Install changes nothing while a Claude or GPT response is streaming, since it restarts the bridge.
- If the app saves `config.toml` while the bridge restarts, install builds its change from the new file.
- Before writing, install parses the new file and refuses unless it holds the setting and everything else unchanged.
- Uninstall restores `model_reasoning_effort` from the backup when the app had saved a Claude default with its own effort. It deletes a `config.toml` that did not exist before, and keeps CRLF line endings.
- A wrong key on the `/g/` route gets 403 over HTTP and WebSocket. A 401 starts the app's ChatGPT login recovery, which an app or CLI still holding a key from before a reinstall would have hit.
- A Claude request that interrupts a GPT reply on the same WebSocket starts once OpenAI has ended that reply, or after 3 seconds. Before, OpenAI's last events for the GPT reply reached the app in the middle of Claude's response.
- Compaction requests to OpenAI get Claude's checkpoints as text, as other requests already did. Before, a chat that Claude had compacted sent OpenAI a checkpoint it cannot read when GPT compacted it.

### Installer and service

- When the runtime folder is gone, `install.sh --uninstall` removes the background service only if the service runs from that folder. A copy installed with another `CLAUDE_BRIDGE_RUNTIME` keeps running. The sandbox run found this when its uninstall step stopped the copy already installed on the test Mac. The same path now also keeps CRLF line endings, removes a blank line only when the picker added it, resets a saved Claude default model, and deletes a cached model list that names Claude.
- `install.py` checks that the process in `bridge.pid` is this runtime's bridge before stopping it or counting its children. macOS reuses process numbers, and a stale file could block an update.
- If an update fails before it switches folders, the previous installation starts again. Before, the service stayed stopped.
- The installer tells the main ChatGPT app apart from the separate Claude window, which runs the same app with its own `--user-data-dir`. With only the Claude window open, it offered to reopen ChatGPT and would have quit that window. Now it asks you to open ChatGPT, and it never quits the app while the window runs.

### Sessions

- GPT turns that follow a stopped Claude turn reach Claude marked as the other model's, after the note about the stop. Before, they were mixed into the resume of Claude's own stopped turn.
- A Stop and a quick resend no longer fail with "already accepting a request" while the stopped request waits for the previous process to exit. The resend waits for it.
- A thought before the first tool call of a later turn stays private. A flag left from an earlier Claude Code process could treat it as the reply to a mid-turn message.
- A Stop during a mid-turn compaction is now the user's Stop. A pause for a compaction that did not finish reads as the host's, with its own wording.

### Results

`test/test_install_sh.py` runs `install.sh` in a scratch home with `launchctl` replaced, so the tests never touch a real service. The mutation check undid 15 of the fixes one at a time, and a test failed for 14 of them. The one left is the picker's parse check before writing, which only matters if the statement reader is wrong.

201 Node tests and 68 Python tests pass, 62 of the Python tests under the system Python 3.9. With Claude Code 2.1.317, `node e2e/live.mjs` passed 18 of 18 with no bridge errors, across the four models, tool calls, mid-turn messages, an image, compaction, Stops and resumes. `node e2e/app-runtime.mjs` passed 26 of 26 on desktop 26.1027.61615 (Codex 0.166.0-alpha.5.1).

The sandbox had its own runtime folder, `CODEX_HOME`, port and service label, with stand-ins for `open` and `osascript`. It ran a fresh install, an update over a stale `bridge.pid`, `--window` from the picker, which brought back the original `config.toml` without the saved Claude default, `--picker` again, an uninstall that restored the original bytes, and the uninstall with the runtime folder gone, which restored the original and deleted the cached model list.

## Release 0.3.14, checked November 3, 2026

### Dependencies

The MCP SDK moves from 1.32.1 to 1.32.2 and `ws` from 8.22.0 to 8.22.1. With `npm audit fix`, this clears the 7 advisories `npm audit` reported, 2 of them high: zod 4.6.7, body-parser 2.4.0, qs 6.17.1, fast-uri 3.1.9, hono 4.13.16, @hono/node-server 2.1.6 and ip-address 10.7.6, all through the SDK.

195 Node tests and 55 Python tests pass. With Claude Code on Haiku 5.5, `node e2e/app-runtime.mjs` passed 26 of 26 on desktop 26.1027.30824, and `node e2e/live.mjs` passed 18 of 18 with no bridge errors, across the four models, tool calls, mid-turn messages, an image, compaction, Stops and resumes.

## Release 0.3.13, checked November 1, 2026

### The separate window's microphone

ChatGPT desktop 26.1016 hides dictation in the separate window. In the webview's capability table, `dictation` and its children, `audio.read-aloud`, `chatgpt.image-generation` and `voice.realtime` are marked `requiresFirstPartyInference`. While Statsig gate `3683713372` is on, those need the global config's `model_provider` to be `openai` or absent, and the window selected `claude_bridge`. Picker mode sets no `model_provider`, so the picker keeps the microphone.

New chats in the window now use the app's built-in provider, through `openai_base_url = http://127.0.0.1:<port>/k/<key>/v1`. The built-in provider can't carry a custom header, so the key is in the path: an HMAC of the bridge token that `src/server.mjs` and `scripts/sync_runtime.py` derive alike. That provider differs from `claude_bridge` in ways the bridge now handles:

- **WebSocket first.** It opens a WebSocket, so the key route answers with 426, which switches the chat to HTTP without a retry or a notice. Node removes its socket error listener before `upgrade`, so the handler adds one; a client that reset a refused upgrade would otherwise have ended the service.
- **Retries.** It retries a 5xx and a stream that ends without a final event, which would run a turn again. On the key route, failures end as `response.failed` with `invalid_prompt`, and a restart mid-reply ends with a message saying so.
- **Login errors.** A 401 starts the ChatGPT login recovery, so a wrong key gets 403. `install.py` and `launch.py` switch `config.toml` only after the running bridge reports `app_provider`.
- **Hosted tools.** Tools only OpenAI can run are left out on the key route, as in the picker, instead of failing the turn.
- **Existing chats.** Resuming applies a chat's saved provider, so chats started on `claude_bridge` keep it and its header, and that table stays in `config.toml`.
- **Switching back.** `set_app_provider` with `enabled=False` keeps the URL, and `setup.py` writes it too. A chat saved on the built-in provider resumes on it, and without the URL it would send its transcript to `chatgpt.com`. An upgrade test caught `setup.py` dropping the URL until the next launch. Before writing, `set_app_provider` parses the new file and leaves it as it was unless both settings are in the root table.
- **Downgrades.** Going back to an older version is not supported. Its installer never switches back, a bridge older than 0.3.13 answers the key route with 401, which starts the login recovery, and its `setup.py` drops the URL, so chats saved on the built-in provider would then go to `chatgpt.com`.

A review found that the picker's `root_end` counted triple quotes inside comments, so `# use """ for long text` in the normal profile made it treat the whole file as the root table. With that file, the settings would have landed in the last table, and the built-in provider would have sent chats to `chatgpt.com`. `root_end` now reads TOML comments, all four string kinds and multi-line arrays, and `setup.py`, `set_app_provider`, `set_standalone_search` and the picker all use it. `setup.py` no longer copies `openai_base_url` from the normal profile; with picker mode on, that line sent the window's requests to the GPT relay.

`test/app-provider.test.mjs` covers the key, a wrong key, the 426, a reset upgrade, final failures on the key route and unchanged ones on the header route, an error before the stream, `compaction_trigger`, unreadable checkpoints, a restart mid-reply, hosted tools, and search with and without the opt-in. `test/test_sync_runtime.py` and `test/test_setup.py` cover the switch both ways, an unrelated `openai_base_url`, a copied picker setting, a changed token, awkward files (a stray triple quote in a comment, multi-line strings and arrays holding lines that start with `[`, an unclosed string, no final newline) parsed back with `tomllib`, and `setup.py` keeping the URL.

`node e2e/app-runtime.mjs` ran the runtime of desktop 26.1027.30824 (Codex 0.166.0-alpha.5.1) against the bridge source with real Claude Code on Haiku 5.5, logged in with a placeholder API key, so no ChatGPT login was used:

- **`window`, 10 of 10, and `window-no-search`, 9 of 9.** One WebSocket refusal, then HTTP; a shell command; a web search against a stand-in, in the first; a manual compaction; the next window recalling the command's output from the checkpoint; a `claude_bridge` chat beside it; after restarting the runtime, each chat resumed on its own provider, and the compacted one still recalled the output. No error or warning notifications, and no bridge errors.
- **`picker`, 7 of 7.** Claude ran a shell command, GPT answered in the same chat from a stand-in for OpenAI over the relayed WebSocket, Claude recalled the earlier turn, Claude compacted, and GPT then got that checkpoint as text. An API key login never fetches the model list, so this run reads Claude's entries from a catalog file. On a Mac with picker mode on and a ChatGPT login, `~/.codex/models_cache.json` was refreshed through the bridge by 26.1027 on November 1 and lists all four Claude models.

An upgrade ran on a throwaway service with its own runtime folder, port and label. Installing 0.3.12 and then 0.3.13 moved `/health` to 0.3.13 with `app_provider`, removed `model_provider`, and replaced the copied picker line with the key URL. On the installed service, Haiku answered on the key route; `/v1/models` gave 200 on the key route and the header route, 403 with a wrong key and 401 with no key. Running `setup.py` again kept the URL with `claude_bridge`, and `launch.py` switched back to the app's provider.

The button itself was checked in the bridge this project grew from, which made the same change on 26.1016 and shows it on 26.1027. The window in this project was not opened for this check. Recording goes through the app's own transcription, not the bridge, and uses the Mac's default input.

## Release 0.3.12, checked October 15, 2026

### One-time timers, continued

The 0.3.11 note told only the weekly form to delete itself. The app schedules a heartbeat again after it runs, so a one-time timer written as a yearly rule for a date more than a week out would have run again a year later. The note now has every one-time heartbeat start by deleting itself, converts the local time to UTC at the offset in effect on the target date (Pacific time changes on November 1, 2026), and says a recurring monthly rule needs its hour in UTC too.

A correction to 0.3.11: the run times the app stores are the rule's hour in UTC exactly. The heartbeat GPT created for 10:00 AM on November 7 is due at 10:00 UTC, which is 2:00 AM Pacific that day, not 3:00 AM.

223 tests pass: 183 Node tests and 40 Python tests.

## Release 0.3.11, checked October 15, 2026

### One-time timers

Desktop 26.1007.71326 runs one-time automations at the wrong time. Its scheduler reads `BYHOUR` in yearly and monthly rules as UTC, while daily and weekly rules use local time. It also schedules a heartbeat again after it runs, even with `COUNT=1`. GPT's reminders are affected the same way, so this is a workaround for the app, not a bridge bug.

Measurements on October 14 and 15, 2026, in America/Vancouver (UTC-7):

- Three one-time heartbeats written as `FREQ=YEARLY;...;COUNT=1` at 1:55 PM, 2:00 PM and 1:32 PM local never ran. Read as UTC, each hour had already passed, so the next run moved to the following year.
- A yearly heartbeat due at 9:00 AM ran at 2:00 AM. A yearly heartbeat GPT created for 10:00 AM is scheduled for 3:00 AM.
- Two weekly heartbeats with `COUNT=1` ran at the right local time, then were scheduled again for the next week.
- A weekly heartbeat at local 3:55 PM whose prompt deleted the automation ran once, at 3:59 PM, and the delete succeeded.

What changed: when the app offers its automation tool, Claude's instructions say to write a one-time heartbeat within the next seven days as a weekly rule at the local time, with a prompt that starts by deleting the automation, and to convert the local time to UTC for a yearly rule further out.

## Release 0.3.10, checked October 15, 2026

### OpenAI closing the connection while Claude has it

A user reported seeing "stream disconnected before completion: websocket closed by server before response.completed" often enough to uninstall. It was not reproduced here, and the report has no other details, so this release hardens the path that error can come from rather than fixing a confirmed cause.

What the error means, from the Codex source used by the app's runtime (`codex-api/src/endpoint/responses_websocket.rs`, `core/src/responses_retry.rs`): the app received a WebSocket Close while it waited for `response.completed`. The runtime retries up to five times on a new connection and hides the first retry notice, then falls back to HTTPS. A visible notice therefore means at least two failed attempts in a row.

In picker mode the app's WebSocket ends at the bridge, which opens a matching connection to OpenAI during the handshake. Claude requests never use that connection, so it sits idle while Claude answers. Before this release, when OpenAI closed it, the bridge closed the app's connection too, after any Claude response in progress. A close that arrived as the app sent its next request failed that request. Any message OpenAI sent on its own was passed to the app, which would have read it as part of Claude's next response.

Measurements on October 15, 2026, through the app's runtime (0.162.0-alpha.17.2) and the installed 0.3.9 bridge:

- The app's own logs for October 10 to 15 show this error twice, both on GPT connections straight to OpenAI without the bridge, and both retried without a notice.
- A 7-minute Claude turn with long shell commands: OpenAI kept the idle connection open, with a ping about every 20 seconds, and the turn finished without a retry.
- Two Claude turns 65 minutes apart on one connection: OpenAI closed the idle connection after 41 minutes with code 1012 (service restart) and no reason. The bridge closed the app's side, the app opened a new connection for the second turn, and the turn finished without a retry or notice.

What changed:

- When OpenAI closes a connection that Claude was last asked on, the app's side stays open and Claude keeps answering on it. A GPT request on it afterwards makes the bridge close it, and the app sends the request again on a new connection, which is the retry it hides. A connection where GPT was last asked, or nothing yet, follows OpenAI's close as before.
- A message from OpenAI on a Claude connection, with no GPT request waiting, is dropped and logged instead of reaching the app.
- Each close from OpenAI is logged with its code, reason and the connection's age, so a report like this one can be traced.

A live check of the new code through the app's runtime, with a test copy of the bridge and a stand-in OpenAI that closes on demand: a Claude turn, then a close with code 1012, then a second Claude turn on the same connection without a new handshake, then a GPT turn that reconnected once without a notice and sent the full request.

Window mode cannot produce this error through the bridge. Its provider sets `supports_websockets = false`, which turns off the runtime's WebSocket transport (`core/src/client.rs`), and the bridge answers a WebSocket outside picker mode with a 404.

### Automated tests in 0.3.10

- OpenAI closing its side after a Claude response and in the middle of one, a GPT request afterwards, a message OpenAI sends on its own between and during Claude responses, and connections that follow OpenAI's close: before any request, after GPT, and in the middle of a GPT response, which also clears the count of GPT requests in flight.
- Uninstall when the app saved `claude-opus` as the default, on each path: the GPT default from before install comes back, or the line is removed when there was none or the runtime folder is gone, so the app uses its own GPT default. The app's list of recent models needs no change: it leaves out models the model list no longer has.

A review of the change found that the first version also kept a connection open when OpenAI closed it before any request, which would have turned a quiet reconnect at startup into a failed first GPT request. Fixed, with a test that fails on the first version.

223 tests pass: 183 Node tests and 40 Python tests.

## Release 0.3.9, checked October 14, 2026

### Web search in the picker

In picker mode the app gives a Claude request GPT's tool list, where web search is OpenAI's hosted `web_search` tool. It runs on OpenAI's servers, so the bridge had left it out and Claude had no web search. The app's own standalone search, `web.run`, is offered only for models flagged for it, which the Claude entries are not.

How the app's runtime calls that search, from the Codex source at tag `rust-v0.162.0-alpha.17.2` (`codex-api/src/search.rs`, `ext/web-search/src/tool.rs`, `history.rs`, `extension.rs`): a POST to `alpha/search` with `id` (the root thread id), `model`, `input` (the previous and current user messages and up to 1,000 tokens of assistant text between them), `commands` (the tool arguments, parsed and written out again, so unknown keys and nulls drop), `settings` (`allowed_callers: ["direct"]`, `external_web_access` from the web search mode: false when cached, the default, true when live, `"indexed"` when indexed, plus any location, context size or domain filter from the config) and `max_output_tokens` 10000. The model gets the response's `output` text verbatim as the tool result.

The bridge now does the same itself when a picker request offers the hosted tool and carries the app's ChatGPT sign-in. Claude gets a `web_run` tool with the same commands; each call goes to the search endpoint with that sign-in, kept in memory with the request. Each search is sent to the app as a `web_search_call` item, the kind GPT's searches produce, with the same labels as the app's own: the queries, else the page opened or searched. The item is shown when Claude's message ends, because a host tool call in the same message completes the response before Claude Code starts the search. History matching ignores these items, whether or not the app keeps them, and GPT-bound requests leave them out, since OpenAI has no record of them.

Live checks on October 14, 2026, through the app's own runtime (0.162.0-alpha.17.2) and the installed bridge, with the default cached search mode:

- `codex exec` on `claude-sonnet`: Sonnet searched, then opened a result by its reference id, both HTTP 200, and answered with linked sources. The endpoint accepted the Claude model name.
- A search turn and a resumed follow-up: the follow-up request carried both search items (10 input items), resumed the native session without a rebuild or an other-model note, and Sonnet described its earlier searches and the page it used. The runtime's rollout stored the items with the bridge's ids and labels.
- The app-server, which feeds the app's window: a Haiku turn produced three `webSearch` items (a search with two queries, then two opened pages) and a cited answer.

New fixture tests: the request body and headers against a stand-in endpoint, the sign-in absent from logs and every file the bridge writes, a search shown while a host tool call in the same message completes the response, the next turn resuming with or without the items, errors returned to Claude as tool errors, no tool without the app's web search or sign-in, GPT requests without the items, unknown commands and nulls left out, the labels, the conversation tail and the settings for each mode.

### A Claude default model after uninstall

Picking a model in the app saves it as the default, `model = "..."` in `~/.codex/config.toml`; a real test left `claude-haiku` there. Uninstall then kept the line, since the file no longer matched the backup, so new chats, the Codex CLI and the IDE extension would ask OpenAI for a model it does not have. Uninstall now puts back the default and effort from before install, or removes the line if there was none. The fallback in `install.sh`, used when the runtime folder is gone, removes it. Five new tests cover the backup, no earlier default, a Claude default in the backup, a multi-line string and a GPT default picked after install; the fallback was run against a throwaway home folder.

### Automated tests in 0.3.9

A review of the change against the Codex source found no serious defects and six smaller ones, all fixed with tests:

- The conversation tail kept Claude's text after the current message and dropped a user message that starts with a tag, such as `<div>`. It now ends at the current message, leaves out only the notes the app itself adds (its own list), and includes plain-text agent messages, as the app does.
- A Stop did not end a running search: Claude Code cancels its call only when its own turn is interrupted. Stopping, resetting or failing a session now aborts its searches. The new test fails without this.
- When the app drops a response's host calls to send a new message, the bridge also marked Claude's searches as dropped. They are left alone now.
- A reply to a mid-turn message that Claude wrote only in its thinking is shown when its next step is a search, as it is before a host tool call.
- A Claude default in the backup itself, as an older uninstall left it, came back on uninstall. It is now removed, a model line inside a multi-line string is left alone, and only the bridge's own model names count, here and in the `install.sh` fallback.
- A failure to save the separate window's header names file returned the raw error instead of the generic message.

218 tests pass: 179 Node tests and 39 Python tests.

## Release 0.3.8, checked October 14, 2026

Four reviews drove the ChatGPT app's own runtime (0.162.0-alpha.17.2) through the bridge: one fuzzing every request shape it sends, one running tool flows with real Claude, one on images, inline visuals and voice, and one cataloguing the app's agent features and what each sends to the model. Their fixes, and a change that resumes the native session where 0.3.7 rebuilt it, are below. Each new test fails on 0.3.7 unless noted.

### Resuming the native session instead of rebuilding

The separate-window bridge's log from September 24 to October 14, 2026 has 43 rebuilds after an unfinished turn, each of which started a new native session and imported the whole thread as text. Thirty-three came from API errors, Stops or edits right after sending, and restarts. The bridge now resumes the native session in these cases where Claude Code's own transcript shows that is safe, as the separate-window bridge does. Claude Code 2.1.300 was run directly to see what it records in each case.

- **API errors.** Seven turns ended with an API error: 529 Overloaded three times in one thread within 8 minutes, the usage limit three times, and an expired login once. Claude Code records the turn's input, then a synthetic message with the error, and on resume leaves the error message out of the request, so the model sees the input once. The bridge now saves such a turn like a Stop, with the status, and the next request resumes with a note that the attempt ended with an API error, that the user did not stop it, and that the conversation up to the error is intact. A mid-turn message Claude Code had added to the conversation is not sent again; one it never started is. Other errors, such as a bridge failure, still rebuild.
- **A Stop before Claude Code reports init.** Claude Code records the prompt just before init, and a signal earlier than that leaves nothing (6 of 6 trials from 0 to 423 ms after start). Of 3 such Stops in the log, 1 had the prompt recorded and 2 did not. Putting the session record back as it stood before the turn, as first tried for this release, could therefore send a message Claude Code had already recorded a second time. A Stop before init now waits for init, at most 10 seconds, then stops Claude Code, so the message is recorded exactly once and the turn resumes like any stopped turn. Over 2,137 starts, the median time to init was 0.43 seconds and the 99th percentile 3.0 seconds.
- **A stopped message the user edits or withdraws.** In 9 rebuilds with a saved stop, the next request no longer contained the stopped turn, because the user had edited or withdrawn its message. All 9 followed a completed turn and sent no tool call to the host. The bridge now sends each prompt with a uuid and records the last assistant entry of each completed turn. When the request extends the conversation as it stood before the stopped turn and adds only new messages and developer notes, Claude Code resumes at that entry with `--resume-session-at` and drops the stopped turn with `--resume-drops-turn`, so Claude sees what the app shows and the cache covers everything before it. Claude Code refuses, before init and without writing anything, if what it would drop is not exactly that turn; the same request then rebuilds. A stopped turn that sent a tool call to the host still rebuilds.
- **Claude Code exiting first during a restart.** In 3 restarts Claude Code was signalled before the bridge while the host ran a tool, so no stop was saved. Terminated, Claude Code records the waiting call as failed with "MCP server is not connected"; interrupted, it cancels the call and records it as rejected. The bridge now saves the turn when Claude Code exits on its own or cancels a call the host is running, and the host's result resumes it with a note that the error or rejection came from the exit, not from the host or the user. Bridge shutdown now stops every session before waiting on any, so sessions waiting for init do not wait in turn.

New fixture tests, each of which fails on the source before this change:

- An API error resumes when the app retries the request, a message sent after one follows the note, and an error that is not an API error still rebuilds.
- An API error after a tool result and a mid-turn message resumes without sending either again, and a mid-turn message Claude Code never started is sent again.
- A Stop before init stops Claude Code at init, the message is recorded once, and the next turn resumes. An init that never comes ends after the wait, and the next request rebuilds.
- A withdrawn message is dropped from the native session, also when it was stopped before init, and a refused drop rebuilds within the same request.
- Claude Code terminated or interrupted while the host runs a tool saves the turn, and the host's result resumes it after a bridge restart.
- Bridge shutdown stops every starting session before waiting on any, and each records its stop at init.
- The resume notes for an API error and an exit, and when a request counts as a withdrawn message.

One more guards the fallback: a withdrawn message whose turn sent a tool call to the host is rebuilt. It also passes on the earlier source, which always rebuilt, and fails when its guard is removed. Each other part of the change was also reverted on its own, and a test above failed each time. The 0.3.7 tests for requests dropped at once over HTTP and WebSocket now also check that each process that started is stopped at init, and the test for a Stop before init in `test/edge-cases.test.mjs` now expects the stopped message to be recorded once and resumed.

On October 14, 2026, `node e2e/live.mjs resume` ran with Claude Code 2.1.300 on the `claude-haiku` entry at low effort, with API errors from a local pass-through proxy. 3 of 3 checks passed in 6 completed Claude turns, with no rebuild and no bridge error apart from the injected one: a 529 retry resumed the session, a Stop before init was stopped at init and the next turn resumed, and an edited story request was dropped with `--resume-session-at`. Each answer used a code word given in the first turn, and on the active branch of Claude Code's transcript each message appeared once and the withdrawn one not at all. Asked whether it had been asked for a story, Haiku answered "you did not ask me for any story".

### Desktop features

- **Messages from other threads.** `send_message_to_thread`, and a thread started by `create_thread` or `handoff_thread`, deliver their message as a tool output with no `call_id`. One that arrived while Claude waited on a tool was dropped without a trace; between turns it rebuilt the session and showed the message as an old tool result with `call_id="undefined"`; on a new thread it was imported as history. Such an output is now new input, shown as a `<host_tool_output>` from the named tool. With real Sonnet, a mid-turn message and a created thread both reached Claude.
- **Context from MCP apps and widgets.** The app injects it before a turn as a call named `untrusted_input` and its output. Claude was told another model had continued the conversation, and a new thread was imported as history. It is now new input.
- **Extra exec outputs.** Code mode's `notify()` records a second output for the same exec call, and only the first reached Claude: real Haiku answered that the notified value "is not in the returned output". All outputs for a call are now merged in order.
- **A Stop during a host tool.** The app now records the stopped call as "aborted by user" and adds a `<turn_aborted>` note. The bridge counted the aborted output as the tool's result, so the next message reached the old tool cycle as a mid-turn message. A new `<turn_aborted>` note now ends the cycle, and the turn resumes as a stopped turn.
- **Exec-only tools.** The exec description documents 61 nested tools, including the app's own (`mcp__codex_app__…`), MCP server tools and the goal tools. The note that names tools Claude must call from exec covered five; it now covers every documented one. A goal continuation, which tells the model to "call update_goal", also carries a one-line note that the goal tools run inside exec: Haiku called `update_goal` at the top level first in 3 of 3 goal runs, and from exec in 4 of 4 with the note. Every goal run, on Sonnet, Haiku and Opus, ended with a valid `update_goal` and none looped.
- **Content the bridge could not render.** A GPT refusal, an unknown content part, or an image held in the user's ChatGPT files failed every later request in the thread. Through the app's runtime, all five Claude turns after a ChatGPT-files image failed. They are now shown as text, with long values left out.

### Picker mode

- **Identity.** In a thread that started on GPT, the runtime keeps GPT's base prompt, so Claude's system prompt opened "You are Codex, an agent based on GPT-6". That line is now replaced with the selected Claude model's identity.
- **Web search.** With web search turned on, Claude was told it had `web__run` inside exec, which picker mode does not provide. Real Claude spent four tool calls looking for it. Search is now mentioned only when the request offers it.
- **A renamed model.** The first process to report a newer version behind an alias renamed the model, so every session waiting on a tool result for that alias saw changed instructions and rebuilt once. A running process now keeps the name it started with.
- **Effort.** GPT's `none` and `minimal` effort, carried over when a thread switches to Claude, got an error; they now map to the model's lowest effort.
- **Usage warnings.** Claude Code carries a session's usage totals across `--resume`, so switching Claude models logged a false `other_model_usage`. Models the session ran on before are now expected.

### Images and visuals

- **Fenced visuals.** The app's visualize skill shows the reference inside a ```` ```text ```` fence, and real Sonnet copied the fence in 1 of 2 runs, so no visual was drawn. A plain fence that holds nothing but one reference to an existing file now becomes that reference; fences with code or other content stay as written.
- **Images from GPT's turns.** When Claude took a thread back from GPT, Claude Code's copies of the images sent to GPT looked like new attachments: real Haiku opened one with `view_image` and said it came with the new message. The replayed turns now carry the same image note as an import, and Haiku then placed the image correctly.
- **Attachments mid-turn.** Once Claude's own screenshots filled the request window, the images the user had just attached gave way first (2 of 4 kept). The current turn now ends at the last final answer or the app's Stop note, so all 4 stay and older screenshots give way.
- Sizes from 1x1 to 8000x8000 and 16.5 MB, PNG, JPEG, WebP, animated GIF, 22 images in one message, corrupt files, HEIC and SVG all behaved correctly, and so did several visuals in one answer, CRLF line ends, split deltas and a 30 MB HTML file.

### Voice

Voice with a Claude model selected hands its request to the model as an ordinary background turn, which worked with real Claude and resumed without a rebuild. Dictation and call setup are fetched by the app itself and never reach the bridge. The gateway relays the realtime routes with their path, query, subprotocols, headers, binary frames and a 20 MB frame intact.

### Other

- A state folder given as a relative path, such as `CLAUDE_BRIDGE_RUNTIME=runtime`, broke every Claude turn, because Claude Code runs in another folder; the app retried 10 times, each starting a process and a rebuild. The path is now made absolute.

### Automated tests in 0.3.8

201 tests pass: 167 Node tests and 34 Python tests. New in 0.3.8, beyond the resume tests above: a message from another thread mid-turn, between turns and as a created thread's task; MCP app and widget context on a running and a new thread; every output of one exec call; a Stop during a host tool followed by a new message; the exec-only note covering every documented nested tool, and the goal note; a GPT refusal, unknown content parts and a ChatGPT-files image; the identity line in a GPT-started thread; web search mentioned only when offered; a renamed alias keeping a waiting session; GPT's lowest efforts; a fenced visual; images from GPT's turns; attachments kept mid-turn; and a relative state folder.

### Live checks in 0.3.8

On October 14, 2026, with Claude Code 2.1.300, `node e2e/live.mjs` passed 18 of 18 with no bridge errors: the four models, a tool call, a mid-turn message, an image, a model switch, Stop then continue, compaction at a turn boundary and mid-turn, the time note, a message sent mid-response, an inline visualization, an abandoned tool call, and the three resume checks. The reviews above add 62 turns through the app's runtime with real Claude across shell, patches, helper agents, question cards, Stops at six points, mid-turn messages, GPT and Claude switching after GPT searches, four kinds of compaction, bridge restarts and forks, with no errors, hung processes or unexpected rebuilds.

## Release 0.3.7, checked October 14, 2026

An adversarial review of the whole project, with reproductions against the app's own runtime and the bridge source, found these problems. Each new test below fails on 0.3.6 unless noted.

### A GPT web search broke the thread for Claude

In picker mode GPT gets OpenAI's hosted `web_search` tool. Once GPT used it, every later request in the thread carried a `web_search_call` item, which the bridge could not turn into Claude's input, so every Claude request and every Claude compaction in that thread failed with "Cannot safely import conversation item web_search_call". The app's runtime 0.162.0-alpha.17.2, run against a stand-in for OpenAI, sent that item in the next request after a search. Items from another model's hosted tools now reach Claude as text, with long values such as generated images left out; GPT's tool lookups are skipped.

### Message sent with an interrupt

The app sends a message typed during a Claude response as `response.interrupt` followed by a new `response.create`. When both arrived in one packet, the second found the interrupted response not yet released and was refused with 409, "A Claude response is already streaming on this connection". It now waits for the interrupted response to finish closing.

### Stops at the wrong moment

- A Stop or disconnect before the bridge attached its close listener, while the request was still being set up, went unseen and the turn ran to the end with no one reading it. The bridge now notes a close from the moment it accepts a request, and does not start Claude Code for a request that has already gone.
- A tool result waits up to 5 seconds for Claude Code to confirm a message sent with it. A Stop in that window marked the message as seen and still delivered the result to a stopped process, so both were missing when the turn resumed. They are now kept for the resumed turn, and the wait ends at once.

### Other session fixes

- The MCP configuration, which holds the bridge token, was passed to `claude -p` on its command line, where any local user could read it during a turn. It is now an owner-only file.
- The next request in a thread waits for the previous Claude Code process to exit. One that kept running after its turn would have held the thread forever; it is now stopped after 15 seconds. In the separate-window bridge's log, the slowest of 1,919 exits took 3.3 seconds.
- A session record that could not be read made every request in its thread fail. It is now set aside and the thread is imported again.

### Gateway

- An error while reading a WebSocket upgrade request, such as a malformed URL, was thrown outside any handler and stopped the bridge. It now gets 400. A WebSocket attempt outside the gateway, such as the app trying one on the separate window's provider, now gets 404 instead of 401, so the app falls back to HTTP as it did with the separate-window bridge.
- When OpenAI refused a WebSocket, such as for an expired login, the refusal's body could be cut off, and a body that never ended held the connection. The body is now read in full, with a 10-second limit.
- When the app gave up on a WebSocket before OpenAI answered, the connection to OpenAI stayed open. It is now closed.
- A failure to start a Claude response over the WebSocket now reaches the app as an error instead of leaving the request unanswered.
- Code blocks are tracked as Markdown defines them, so a `visualize{...}` line inside a `~~~` block, or a block opened with four backticks, stays as written, and inline code with three backticks no longer opens a block.

### Install and uninstall

- `picker.py` now keeps `config.toml` owner-only while its setting holds the gateway key, and restores the file's mode when picker mode is turned off. Its temporary files and the key file are created owner-only.
- A `config.toml` with a multi-line string before the first table got the setting inside the string. The setting now goes after it.
- A setting left by an earlier installation whose runtime folder is gone is replaced instead of refused.
- Two installs in the same second wrote the same backup folder. Backup names are now unique. Taking the setting out of a file edited since the install no longer leaves an extra blank line before the next table.
- Changing the port or label with setup while picker mode is on left GPT pointing at the old address. Setup now refuses until picker mode is off.
- Running the installer again without an option turned picker mode on for a separate-window installation. An update now keeps whichever you use; `--picker` or `--window` switches.
- `install.sh --uninstall` without the runtime folder now also removes the background service, which otherwise kept restarting against missing files.
- An install starts a new log once the old one passes 20 MB.

### Automated tests in 0.3.7

165 tests pass: 131 Node tests and 34 Python tests. New in 0.3.7:

- A GPT web search and a generated image in a thread reach Claude as text, and the thread keeps working.
- An interrupt and a new request in one WebSocket packet start the next Claude response.
- A Stop while a mid-turn message waits keeps the message and the tool result for the resumed turn.
- Requests dropped at once over HTTP and WebSocket leave no Claude Code process running. These pass on 0.3.6 too, because the drop rarely lands in the setup window; they guard the result.
- A process that keeps running after its turn is stopped, and the next turn starts.
- An unreadable session record is set aside and the thread continues.
- A WebSocket attempt on the separate window's provider gets 404.
- Code blocks of each kind keep a visualization line as written.
- Picker mode makes `config.toml` owner-only and turning it off restores the mode; a multi-line string, a leftover setting and two installs in one second are handled; setup refuses a new port or label while picker mode is on.

### Live checks in 0.3.7

On October 14, 2026, with Claude Code 2.1.300, seven live checks through the bridge source passed with no bridge errors: a tool call, a mid-turn message, Stop then continue, a mid-turn compaction, a message sent mid-response, an inline visualization, and a switch from Opus to Sonnet that resumed the native session.

## Release 0.3.6, checked October 14, 2026

A review of picker mode, which had seen far less daily use than the separate window, found these problems. Each new test below fails on 0.3.5.

### A Claude checkpoint the bridge cannot open

The bridge seals Claude's compaction checkpoints with its own token. After a reinstall that deleted the runtime folder, the token is new, and an older thread where Claude had compacted carried a checkpoint the bridge could no longer open. When such a thread went to GPT over the app's WebSocket, the error was thrown inside the WebSocket handler and stopped the whole bridge, ending every chat's stream, and the app's retries started it again. Over HTTP, and for Claude, the thread failed with an error on every request. Such a checkpoint now becomes a note that the earlier summary can't be read, and the thread continues from the messages kept after it. An error in the WebSocket handler is now reported on that connection only.

### Uninstalling while picker mode is on

`uninstall.py` removed the service without touching the ChatGPT profile, so after `uninstall.py --delete-data`, or after deleting the runtime folder, `config.toml` still pointed GPT at the bridge. `picker.py uninstall` decided only from its state file, which was gone, so nothing could take the setting out again. Now `uninstall.py` turns picker mode off first. `picker.py uninstall` and `install.sh --uninstall` remove the marked setting even without the runtime folder, and `install.sh --uninstall` also finds the copy the service runs when the source folder is gone. If the marked line was edited so it can't be found, uninstall stops and names the line to delete instead of reporting success. In a temporary profile with the real service installed, `uninstall.py --delete-data` restored `config.toml` byte for byte and then removed the service and the folder.

### A symlinked config.toml

The atomic write replaced a symlinked `config.toml`, such as one kept in a dotfiles repository, with a regular file, and the link was lost. Writes now go to the file the link points to.

### Other WebSockets on the Codex route

The gateway accepted a WebSocket only at `/responses` and refused any other path with 404. The app's runtime contains a realtime voice client. Other WebSockets on the Codex route, with any subprotocol OpenAI accepts, are now relayed to OpenAI unchanged. Whether the app's voice uses this route was not checked live.

### Automated tests in 0.3.6

153 tests pass: 122 Node tests and 31 Python tests. New in 0.3.6:

- A checkpoint sealed by an earlier installation reaches GPT over HTTP and WebSocket, and Claude, as a note, and the bridge keeps serving.
- A WebSocket on another path of the Codex route is relayed with its subprotocol, path and login.
- Uninstall without the runtime folder removes the setting and a model list that lists Claude; an edited marker stops uninstall with the line to delete; a symlinked `config.toml` stays a link through install and uninstall.

## Release 0.3.5, checked October 14, 2026

Version 0.3.5 brings seven fixes made in the separate-window bridge after 0.3.4, versions 0.2.31, 0.2.32 and 0.2.34 to 0.2.38 there. Three follow from the ChatGPT desktop update of October 8, 2026. For each fix, a fixture test or a live check fails on 0.3.4.

### Messages sent while a response streams

Since the October 8 update, a message sent while a response is still streaming, before it has produced a tool call, makes the app cancel the response and send the request again with the message appended. A Stop differs: the app adds a `<turn_aborted>` developer note to the next request. The bridge treated both as a Stop, so Claude answered the message and waited for a go. In the separate-window bridge's log from October 9 to 11, 44 of 48 such resumes carried only the message. Now a cancelled response followed by a user message without `<turn_aborted>` resumes as a mid-turn message: Claude answers it in a line and carries on, and no time note is added. In picker mode the app's WebSocket interrupt stops the response the same way as an HTTP disconnect, so the same check applies.

### Inline visualizations

The app's visualize skill draws a visual from a `visualize{"path":"…"}` line wrapped in the private-use characters U+E200, U+E202 and U+E201. Claude models drop those characters, even when asked to copy them, so the app showed the bare line as text. The bridge now adds them as the text streams, to a line that is exactly such a reference to an absolute path of an `.html` file that exists. Lines in code blocks stay as written, and checkpoints are not rewritten.

### Turns paused by the host

Claude Code marks a stopped turn's unanswered tool calls as rejected by the user and the turn as interrupted by the user. When the app compacted in the middle of a turn, Claude took the marks at their word: in the separate-window bridge, 4 of 4 checkpoints said the user had rejected the calls, and each next window waited for the user. The fork is now told that the user did nothing, that output which follows is the call's normal result, and that the checkpoint should record the task as still in progress. A bridge restart that cuts off a turn the user had already stopped keeps the stopped wording.

### Tool calls the app never answers

A thread that is archived, deleted or left after a Stop while the app runs a tool never sends the tool's result. Claude Code waited on it until the bridge restarted, the session counted as active, and `install.py` refused every update while that process ran. In the separate-window bridge this happened three times from October 1 to 12, for up to 24 hours, while the slowest of 28,722 answered tool calls took 45 minutes. A session that has waited two hours for a tool result, with no request in progress, is now stopped and logs `host_tool_abandoned`. A result that arrives later resumes it.

### Time of day

Claude Code gives Claude the date but not the time. Asked about a pull request 8 minutes after its last reply, Opus described what had happened "since yesterday". Each new turn that brings a user message now carries the local time and how long ago Claude last replied. Mid-turn messages and compaction requests get none. In picker mode the gap counts from Claude's last reply.

### Base prompt rename

Since October 9, 2026 the app sends its base prompt as a leading developer message with empty `instructions`. The rename of "As Codex, you are" to "You are" applied only to `instructions`, so it stopped working. It now covers every part of the app's prompt, and empty parts are left out.

### Automated tests in 0.3.5

148 tests pass: 120 Node tests and 28 Python tests. New or changed in 0.3.5:

- A response cancelled before its tool call, then sent again with a user message, resumes as a mid-turn message, and a resume with `<turn_aborted>` keeps the stopped wording.
- A bare visualization reference gets the markers, also when split across stream chunks, and a reference in a code block, to a missing file or to a relative path stays as written.
- A compaction of a turn the host paused says the user did nothing and which interrupted calls ran.
- A tool call left unanswered past the wait limit stops the session, a wait just under the limit does not, and a late result resumes it.
- A new turn carries the time and the gap since Claude's last reply, and a mid-turn message does not.
- The base prompt arriving as a developer message with empty `instructions` is renamed.

### Live checks in 0.3.5

`node e2e/live.mjs` has four new checks: `time`, `resample`, `visualize` and `toolwait`. The mid-turn compaction check now also fails when the checkpoint blames the user. With Claude Code 2.1.300 all fifteen checks pass. Run against the 0.3.4 source, four failed. The mid-response message resumed as a stopped turn, and Claude answered without calling the next job. The visualization reference came out without the markers. The mid-turn checkpoint blamed the user for the pause. Asked for the local time, Sonnet wrote a `date` tool call as text instead of answering.

`install.sh` from this release was run with a temporary runtime folder, port and service label, and a temporary ChatGPT profile signed in with a real ChatGPT login. The app's own runtime (ChatGPT 26.1007.71326, Codex runtime 0.162.0-alpha.17.2) then ran these checks:

| Check | Result |
|---|---|
| Claude Sonnet with a shell tool | Answered 323 |
| GPT (`gpt-6-luna`) through the relay | Answered 667 |
| Claude Haiku continuing GPT's thread | Ran the next command and answered "667 668" |
| GPT after Claude | Read Haiku's turn and answered "667 668" |
| Message sent through the app server 1.6 seconds into Opus's first response | Delivered as a mid-turn message; Opus answered it in a line and ran all three steps |

`--uninstall` restored the temporary `config.toml` byte for byte and removed the service.

## Release 0.3.4, checked October 9, 2026

The MCP SDK moves from 1.30.1 to 1.32.1 for GHSA-6qxp-vccf-f47h, a high-severity flaw in the SDK's OAuth client (stored credentials could be sent to an authorization server chosen by the MCP server). The bridge uses only the SDK's server and has no OAuth client, so it was not exposed. The other changes since 1.30.1 are a client redirect policy, two server options that stay off unless set, and acceptance of tool calls without arguments. All 143 tests pass, `npm audit` reports no vulnerabilities, and all eleven checks in `node e2e/live.mjs` pass with Claude Code 2.1.295.

## Release 0.3.3, checked October 9, 2026

Version 0.3.3 lists Claude Haiku 5.5 with its effort levels, adds `install.sh`, and brings four fixes made in the separate-window bridge after 0.3.2.

| Picker entry | Alias | Model Claude Code started | Context window | Effort levels |
|---|---|---|---|---|
| Claude Fable 5.1 | `fable` | `claude-fable-5-1` | 1,000,000 | low to max, default high |
| Claude Opus 5.5 | `opus` | `claude-opus-5-5` | 1,000,000 | low to max, default medium |
| Claude Sonnet 5.5 | `sonnet` | `claude-sonnet-5-5` | 1,000,000 | low to max, default medium |
| Claude Haiku 5.5 | `haiku` | `claude-haiku-5-5` | 1,000,000 | low to max, default medium |

Claude Code 2.1.295 starts `claude-haiku-5-5` for the `haiku` alias and reports a 1,000,000-token window. Haiku 5.5 accepts all five effort levels and defaults to medium, according to the [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort). Claude Code also accepts `--effort` with `claude-haiku-4-5-20251001` and answers normally, so an account whose alias still starts Haiku 4.5 is not broken by the flag. An entry listed without efforts, such as a pinned Haiku 4.5, still gets one fixed level and no flag.

### One-line installer

`install.sh` checks for macOS, git and python3, the ChatGPT app and the model list it downloads on first launch, Node.js 24 or later (offering Homebrew), and Claude Code and its sign-in. It then downloads or updates a copy of the repository in the runtime folder, runs `npm ci`, `install.py` and `picker.py install`, and offers to reopen ChatGPT when exactly one ChatGPT process is running. `--window` opens the separate window instead, and `--uninstall` turns picker mode off and removes the service.

It was run from a working copy against a temporary runtime folder and a temporary ChatGPT profile, with its own port and service label. Without the app's model list, setup had stopped with a Python traceback; the installer now stops first with "Open the ChatGPT app once and sign in, then run this again." With the list it installed the service and turned picker mode on in the temporary profile. With two ChatGPT processes running, it told the user to reopen ChatGPT rather than quitting either. `--uninstall` restored the temporary `config.toml` byte for byte and removed the service. shellcheck reports no issues.

### Question cards the app does not draw

On October 4, 2026 Opus sent `request_user_input_async` a card with four questions, the first about 1,100 characters long. The app answered `{"accepted":true}` and stored the questions, but drew no card, so the user saw nothing while Opus said the questions were waiting. Fourteen earlier cards, with one to three questions of at most 540 characters, were drawn and answered. GPT never sent more than three questions in 154 cards, and the app's other question cards allow three. The bridge now answers an async card with more than three questions, or a question over 600 characters, with an error that states the limit, and does not forward it. It logs `question_card_refused`. Live with real Opus, asked to put four questions in one card, Opus was refused once and sent a three-question card, which reached the app.

### Pasted screenshots counted toward the request limit

On October 8 a thread stopped with `413 Payload Too Large: The model input still exceeds 24 MiB after bounding older tool screenshots`. Since its last compaction it held 20 images: 12 slide stills and one render returned by tools (15.25 MiB, under the 16 MiB tool-image mark, so none were bounded) and 7 pasted screenshots (8.55 MiB, including two Retina captures of 3.5 MiB each), which the bounding never counted. With 2.5 MiB of compacted history and text the request reached 24.16 MiB, and every retry failed the same way. The bridge now also bounds the whole request: above 20 MiB it replaces the oldest earlier images, tool images and attachments alike, until about 12 MiB remain, keeping attachments sent since Claude last answered and the newest tool image. Replaying that thread's history gives 8.25 MiB with 11 of the 12 newest slide stills kept. Two tests cover the mix of attachments and tool images; both fail on 0.3.2.

### Image copies after a history import

A new context, such as a new side chat, imports the app's transcript as one prompt, with each image in its original place. Claude Code saves every image in a prompt and appends a note listing the copies as `[Image: source: /private/tmp/…/images/1.jpg]`, so the last thing Claude read after the user's question was an image path. In 14 days of transcripts Opus opened such a copy 19 times, all in the first turn after a history import (19 of 70 imports that carried images), and never after one of the 95 prompts with images the user had pasted. On October 9 a side chat answered "any other runs we should be doing" by first opening a screenshot from the main chat. Claude Code 2.1.295 stores prompt images unless transcript saving is off, which the bridge needs for resume, so the bridge now ends an imported transcript that holds earlier images with a note saying the listed lines are copies of images already shown, not new attachments, and naming any images attached to the last user message. Live with real Opus 5.5 on that side chat's first prompt, stopped at the first tool call: without the note, 2 of 2 runs opened the copy first; with it, 0 of 3 did.

### Mid-turn compaction from the cache

The app's automatic compaction usually fires in the middle of a turn: it runs the turn's tool calls, finds the context over its limit and compacts before sampling again. The native session was still waiting on those calls, so the bridge imported the transcript into a new session, writing the whole conversation to the cache at twice the input price, about 40 times the cost of a fork that reads it from the cache. The bridge now stops the waiting session as Stop does, then forks it from its cached prompt; the app continues in a new context, so the old session was stopped after the compaction anyway. Claude Code marks the stopped calls as rejected or interrupted, so the fork is told that a call ran in the host when its output follows. The cache lifetime check uses the session's last response. The integration test that expected an import now expects the fork and fails on 0.3.2.

### Automated tests in 0.3.3

143 tests pass: 115 Node tests and 28 Python tests. New or changed in 0.3.3:

- The shipped catalog lists Claude Haiku 5.5 with five effort levels, a medium default and a 1,000,000-token window, and an entry without efforts still gets one fixed level in both the bridge and the Python setup.
- Question cards over the app's limits are refused with the reason, and a valid card reaches the app.
- Pasted attachments count toward the request window, the oldest earlier images give way first, and the current request's attachments and the newest tool image stay.
- A new side chat imports the main chat's images with the note, and a transcript without earlier images gets none.
- A compaction during a tool cycle stops the waiting turn and forks it warm, with the note on which interrupted calls ran.

### Live checks in 0.3.3

`node e2e/live.mjs` with Claude Code 2.1.295 passes all eleven checks: each of the four models answers (Haiku 5.5 with an effort flag), a tool call, a message sent mid-turn, an image, a switch from Opus to Sonnet that resumes the native session, Stop then continue, a compaction forked from the live session, and the new mid-turn check, where the checkpoint kept the job's build id and was forked from the stopped turn with a warm cache.

With ChatGPT 26.1007.21159, the app's own `codex exec` (Codex runtime 0.162.0-alpha.17.2) used the real ChatGPT login with `openai_base_url` pointed at a picker-mode bridge that `install.sh` had installed in the temporary profile. GPT (`gpt-6-luna` at low effort) answered over the app's Responses WebSocket through the relay, and Claude Haiku 5.5 answered through the same endpoint. A control run with the base URL on a closed port failed to connect, so both requests went through the bridge. The app's window and picker were not opened for this check.

## Release 0.3.1, checked October 4, 2026

The components are the same as for 0.3.0 below. Version 0.3.1 adds Claude Fable and puts the model version in each picker name.

| Picker entry | Alias | Model Claude Code started | Context window | Effort levels |
|---|---|---|---|---|
| Claude Fable 5.1 | `fable` | `claude-fable-5-1` | 1,000,000 | low to max, default high |
| Claude Opus 5.5 | `opus` | `claude-opus-5-5` | 1,000,000 | low to max, default medium |
| Claude Sonnet 5.5 | `sonnet` | `claude-sonnet-5-5` | 1,000,000 | low to max, default medium |
| Claude Haiku 4.5 | `haiku` | `claude-haiku-4-5-20251001` | 200,000 | none |

A one-line probe of `claude --model fable` used only `claude-fable-5-1` and reported a context window of 1,000,000 tokens. Fable starts at high effort, which is Claude Code's own default for Fable 5.1 according to [Anthropic's announcement](https://www.anthropic.com/claude-fable-and-mythos-5-1), and accepts all five levels according to the [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

An alias entry's name ends with the version Claude Code last started for it. The bridge records that model in `sessions/started-models.json`, so a name survives a restart, and the model list's ETag changes with the names, so the app downloads the list again. The record only names entries. After a restart an alias stays unpinned until Claude Code starts it again, so it still moves to a new release.

### Automated tests in 0.3.1

135 tests pass: 108 Node tests and 27 Python tests. The Python tests also pass on `/usr/bin/python3` 3.9.6. New in 0.3.1:

- The shipped catalog lists Fable, Opus, Sonnet and Haiku with versioned names, and Fable starts at high effort.
- Versions are read from model ids: `claude-fable-5-1` is 5.1 and `claude-haiku-4-5-20251001` is 4.5. An entry that pins a model id keeps its catalog name.
- A new version from an alias renames its entry in `/v1/models`, in the app's model list and in Claude's identity line. The name survives a restart, and the alias is not pinned by it.
- The bridge and the Python setup build the same entries and names.
- Fable is pinned to the model Claude Code started, like the other aliases.

### Live checks in 0.3.1

Through the installed service on the real ChatGPT profile, the app's own `codex app-server` listed the 8 GPT models and then Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5 and Claude Haiku 4.5. In one ephemeral thread, GPT ran a shell command and answered 323, then Claude Fable at low effort ran another over the app's WebSocket and answered 1147. Claude Code reported `claude-fable-5-1`.

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

## Tool calls reset on a reused connection, in 0.3.2

Claude Code's call to the tool relay sometimes failed 25 to 130 ms after it was sent with `ECONNRESET: The socket connection was closed unexpectedly`. Claude Code recorded the tool as failed and started its next request, so the bridge saw Claude advance with no open desktop response, stopped the process and rebuilt the conversation from the desktop transcript, writing its whole prompt cache again, while the desktop had already been handed the call and ran it. In the separate-window bridge's transcripts from October 2 to 6 there were 13 such resets; 4 came 5.9 to 6.0 s after the previous tool result, a window that holds about 4% of all tool calls. Node 24.21 closes an idle keep-alive socket after `keepAliveTimeout` (5,000 ms) plus `keepAliveTimeoutBuffer` (1,000 ms), and Claude Code reuses its MCP sockets, so a call sent at that moment lands on a socket the server is closing. The others came 2 to 5 s after the last result, which fits a second pooled socket that had been idle longer. The server now disables its keep-alive timeout; its clients on this local port close their own idle sockets. A test holds a keep-alive socket idle for 6.5 s and reuses it; it fails on 0.3.1.

## References

- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Claude models overview](https://platform.claude.com/docs/en/models/overview)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
