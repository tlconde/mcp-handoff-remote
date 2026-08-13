---
name: onboard
description: Name this handoff seat. Use when the user says "Name this seat", /name, /onboard, or "Start onboarding for" (same meaning — not HR, not a web search).
---

# Name this seat

The user is naming **this** handoff conversation. Not employee onboarding. Not a company. Do not search the web. Do not list directories.

1. Take the one word after `Name this seat` / `/name` / `/onboard` / `Start onboarding for`. If none, `whoami` and stop.
2. Enrol this seat with that word as title and nickname:
   - chat / cowork / design → `register_session` with that `surface`
   - Claude Code terminal → `register_session`, omit `surface`
   - Grok / asserted code → `register_remote_session` (title = the word; device, session_uuid, subscription, model_slug already known — do not invent)
3. `whoami`. Relay the line.

