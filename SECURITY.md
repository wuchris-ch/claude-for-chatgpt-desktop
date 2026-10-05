# Security policy

## Reporting a vulnerability

Report security problems privately: open the [Security tab](https://github.com/wuchris-ch/claude-for-chatgpt-desktop/security) and choose **Report a vulnerability**. Only the maintainer sees the report until a fix is published. Please don't open a public issue for these.

Include:

- the version from `package.json`, your macOS version and your ChatGPT app version
- steps to reproduce, and what happened compared with what you expected

Leave out your bridge token, gateway key and any Claude or OpenAI credentials, and redact them from logs you attach. The gateway key appears in the `openai_base_url` line of `~/.codex/config.toml`.

## Scope

In scope:

- reaching the bridge without its key, from a web page, another local user or the network
- running commands or reading files through the bridge beyond the app's own tools and approvals
- reading Claude or ChatGPT credentials, or another conversation's data, through the bridge
- the picker gateway sending your ChatGPT login or requests anywhere other than OpenAI

Problems in Claude Code, the ChatGPT app or the models themselves belong with Anthropic or OpenAI.

## Supported versions

Fixes go into the latest version on `main`.
