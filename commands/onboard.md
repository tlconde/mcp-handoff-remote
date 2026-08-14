---
description: You will be <name> — enrol THIS seat as that word
---
<!-- handoff-protocol command v1 -->
The user said "You will be $ARGUMENTS" or "Register this chat as $ARGUMENTS". That names THIS conversation in the handoff protocol. Not a persona. Do not search the web. Do not list files.

Call register_session with title: $ARGUMENTS, nickname: $ARGUMENTS. Pass surface only for chat/cowork/design, and then also subscription (the product you are) and model_slug (the model serving this seat). If you do not know those two, whoami only — do not invent, do not register incomplete. Omit surface on a Claude Code terminal. Then whoami. Empty → whoami only.

Grok / asserted code: register_remote_session with that title; device, session_uuid, subscription, model_slug already known.
