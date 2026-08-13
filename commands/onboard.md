---
description: Enrol THIS chat in one word so it can be addressed by name
---
<!-- handoff-protocol command v1 -->
Call register_session with surface: chat, title: $ARGUMENTS, nickname: $ARGUMENTS (one human word — "Checker", "review", "nicky"). No ids, no second question. The name they typed is the name. Then call whoami and relay that line. If $ARGUMENTS is empty, call whoami only.

This is the chat equivalent of /name. It does not name a terminal. Code seats still use /name.
