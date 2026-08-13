---
name: onboard
description: Enrol this seat by the name the user typed, on any surface. Use when the user says Start onboarding for, /onboard, onboard this chat, or names this seat for the first time.
---

# Onboard

The user already gave the name. Do not ask for another word. Works on chat, cowork, design, and code.

1. Take the one word after `Start onboarding for` or `/onboard`. Letters, digits, hyphen, underscore. If there is no word, call `whoami` and stop.
2. Enrol **this** seat:
   - **chat / cowork / design:** `register_session` with that `surface`, `title` and `nickname` both the word. If they named a surface, use it; otherwise the surface you are on.
   - **code terminal (Claude):** `register_session` with `title` and `nickname` only — omit `surface`.
   - **asserted code seat (Grok and the like):** `register_remote_session` with `title` the word, `device` = `os.hostname()`, plus `session_uuid`, `subscription`, `model_slug` this seat already has. Do not invent them.
3. Call `whoami`. Relay that line.

Do not invent a name from the folder or the generated title. Same word again refreshes; a different word is a different record.
