---
name: onboard
description: User said "You will be <name>" — enrol THIS handoff seat as that word. Also /name and /onboard. Not HR. Do not search the web.
---

# You will be \<name\>

The user is naming this conversation. Call register now. Do not search the web. Do not list directories. Do not ask for another word.

1. The word after `You will be` (or `/name` / `/onboard`). One token: letters, digits, hyphen, underscore. None → `whoami` only.
2. Enrol this seat:
   - chat / cowork / design → `register_session` with that `surface`, `title` and `nickname` = the word
   - Claude Code → `register_session`, omit `surface`
   - Grok / asserted code → `register_remote_session` (`title` = the word; do not invent device, session_uuid, subscription, model_slug)
3. `whoami`. Relay the line.
