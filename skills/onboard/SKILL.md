---
name: onboard
description: Enrol a chat or cowork seat by the name the user typed. Use when the user says Start onboarding for, /onboard, onboard this chat, or names a chat seat for the first time.
---

# Onboard

The user already gave the name. Do not ask for another word.

1. Take the one word after `Start onboarding for` or `/onboard`. Letters, digits, hyphen, underscore. If there is no word, call `whoami` and stop.
2. Call `register_session` with `surface: "chat"` (or `cowork` / `design` if they said that surface), `title` and `nickname` both that word.
3. Call `whoami`. Relay that line. The receipt's `session_id` is this conversation's identity.

Do not invent a name from the folder or the generated title. A second `Start onboarding for` with the same word refreshes; a different word is a different record.
