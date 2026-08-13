---
description: Name THIS seat in one word so others can send to it
---
<!-- handoff-protocol command v1 -->
The user said "Name this seat <word>" or /onboard or /name. This is handoff enrolment, not HR, not a web search. Do not search the web. Do not list files.

Call register_session with title: $ARGUMENTS, nickname: $ARGUMENTS (one word). Pass surface only for chat/cowork/design. Omit surface on a Claude Code terminal. Then whoami. Empty → whoami only.

Asserted code (Grok): register_remote_session with that title; device, session_uuid, subscription, model_slug must already be known.
