---
name: onboard
description: Enrol THIS handoff seat. Triggers: "You will be <name>", "Register this chat as <name>", "Register this session as <name>", "Join as <name>", /name, /onboard. Not a persona. Do not search the web.
---

# You will be \<name\>

The user is naming this conversation. Call register now. Do not search the web. Do not list directories. Do not ask for another word.

1. The word after `You will be` (or `/name` / `/onboard`). One token: letters, digits, hyphen, underscore. None → `whoami` only.
2. Enrol this seat:
   - grok.com, claude.ai, Claude chat, cowork, design → `register_chat_session` (`surface`, `title`, `nickname`, `subscription`, `model_slug`). Relay + no CLI uuid does **not** make this a code seat. If you do not know subscription or model_slug, `whoami` only — do not invent.
   - A machine (Grok Build, Claude Code) → `register_code_session` (`title`, `device` = `os.hostname()`, `session_uuid`, `subscription`, `model_slug`). Never for a chat.
3. `whoami` with `session_uuid` (or `session_id`) set to the `session_id` register just returned. Required over the relay — a no-arg whoami after a successful chat register is unidentified, and that is not a failed enrol. Do not register again.
