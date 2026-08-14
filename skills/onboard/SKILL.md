---
name: onboard
description: Enrol THIS handoff seat. Triggers: "You will be <name>", "Register this chat as <name>", "Register this session as <name>", "Join as <name>", /name, /onboard. Not a persona. Do not search the web.
---

# You will be \<name\>

The user is naming this conversation. Call register now. Do not search the web. Do not list directories. Do not ask for another word.

1. The word after `You will be` (or `/name` / `/onboard`). One token: letters, digits, hyphen, underscore. None → `whoami` only.
2. Enrol this seat:
   - chat / cowork / design → `register_session` with that `surface`, `title` and `nickname` = the word, plus `subscription` (the product you are: grok, claude, …) and `model_slug` (the model serving this seat). If you do not know either, `whoami` only — do not invent, do not register incomplete.
   - Claude Code → `register_session`, omit `surface`. Pass subscription/model_slug if you know them; do not invent.
   - Grok / asserted code → `register_remote_session` (`title` = the word; do not invent device, session_uuid, subscription, model_slug)
3. `whoami`. Relay the line.
