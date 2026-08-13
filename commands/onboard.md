---
description: Enrol THIS seat in one word so it can be addressed by name
---
<!-- handoff-protocol command v1 -->
Call register_session with title: $ARGUMENTS, nickname: $ARGUMENTS (one human word). No ids, no second question. Pass surface only if this seat is chat, cowork, or design — omit surface on a code terminal. If they named a surface in the sentence, use that. Then whoami. If $ARGUMENTS is empty, whoami only.

A Grok or other asserted code seat that has a product session id uses register_remote_session instead (title, device=os.hostname(), session_uuid, subscription, model_slug). Do not invent those fields.
