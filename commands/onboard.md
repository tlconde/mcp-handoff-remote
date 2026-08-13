---
description: You will be <name> — enrol THIS seat as that word
---
<!-- handoff-protocol command v1 -->
The user said "You will be $ARGUMENTS". That names THIS conversation. Not a job, not a person to look up. Do not search the web. Do not list files.

Call register_session with title: $ARGUMENTS, nickname: $ARGUMENTS. Pass surface only for chat/cowork/design. Omit surface on a Claude Code terminal. Then whoami. Empty → whoami only.

Grok / asserted code: register_remote_session with that title; device, session_uuid, subscription, model_slug already known.
