# Identity is per-surface — and chat's identifier is the one we MINT

**Status:** accepted · operator ruling, previously undocumented · written 2026-08-12 after a
regression that could not have been caught

## Decision

**Each surface asserts a different KIND of identity, because each product is a different kind of
thing.** One enrolment ceremony, but the evidence it carries is not uniform, and **no verb may demand
evidence a surface cannot possess.**

| surface | what it can assert | why |
|---|---|---|
| **code** | `cli_uuid` (+ `cli_pid`, `cwd`) and a self-reported `host` | it runs in a process on a machine |
| **chat** | **its minted record id** | it has no process, no pid, no socket, and **no hostname — not "missing", but nonexistent** |
| **cowork** | **both** — its own minted id AND `origin_ref` to the parent chat | it is a chat-descended session with lineage |
| **design** | **UNVERIFIED** — not measured; this file says so rather than guessing | — |

**The chat identifier already exists, and this is why it was invented.** `handoff-core.js:189`,
`id(prefix) = prefix + '_' + ulid()`: every record gets a randomly generated, unique, sortable,
**surface-typed** id at creation (`sess_…` for chat, `sess_code_…` for code — `ae6d1bf`). Chat had
nothing natural to identify itself with, so the store **mints** one; the code ids are modelled on the
same shape. **That minted id IS chat's identity. It was created for exactly this purpose.**

So the rule is short: **ask a machine for a machine name; ask a chat for its id.**

## Do NOT add a chat credential — three that were considered and rejected on measurement

- **`mcp-session-id`** — a TRANSPORT id. The relay MINTS it on the `initialize` response
  (`handoff-relay.js:499`) and the client echoes it back, so it **cannot survive a reload by
  construction**: 653 `initialize` calls produced 648 distinct ids. Stable within a connection (some
  spanned hours), which is exactly what makes it look usable. Addressing hint at most.
- **A conversation URL** — shareable and guessable, so anything it authorised could be asserted by
  whoever saw it. Same weakness as the open `from_title` impersonation finding. An identifier, never
  a key.
- **`account_sub` as the key** — it is the only account-VERIFIED thing a chat seat holds, and it
  identifies the **human, not the conversation**. It cannot separate two chats belonging to one
  person. Recording it may still be worth doing (it would be the store's first verified fact about a
  non-code seat), but it is not the drain key and nothing waits on it.

Nothing new is needed. **The identifier is already minted, already unique, already surface-typed.**

## Tracked for OBSERVABILITY, never for authorization

Rejected as *keys* is not rejected as *evidence*. Two of the three are real values already moving
through the system and worth recording; the third does not exist.

| value | real? | today | track it |
|---|---|---|---|
| `account_sub` | **yes** — Access JWT, account-VERIFIED | in ctx; persisted ONLY on the `register_remote_session` path (`handoff-core.js:1785`, `minted_by: access:…`) | **yes** — on every remote call, not one path |
| `mcp-session-id` | **yes** — minted by our relay (`:499`) | written to `relay.access.log`; **dropped before the daemon** (`:200`) | **yes** — it is the JOIN KEY |
| surface-class (from `user-agent`) | **yes** — `Claude-User` vs `claude-code/2.1.x` | read, then dropped | **yes** — cheap and it is the thing `280cb79` needed |
| conversation URL | **NO — nothing on the wire carries one** | does not exist | **no** — see below |

**The join key is the point.** `relay.access.log` records `mcp-session=924002a4`; `ops.jsonl` records
`session_registered`. **They share no field, so a relay-side connection cannot today be correlated
with a daemon-side event** — which is exactly the correlation anyone debugging a remote call needs.
Passing `mcp-session-id` through to `ops()` closes that, and it authorises nothing.

**Where it goes: `ops.jsonl`, NOT the session record.** Observability data on an identity record
becomes identity data by proximity — someone reads it, then keys something on it, and a transport
artefact that cannot survive a reload starts deciding who may read mail. Keeping it in the ops log
keeps the record clean and the debugging complete.

**The URL is not tracked because it is not received.** For it to exist a chat seat would have to
SELF-REPORT it, and **whether a chat seat can even know its own conversation URL is UNMEASURED** —
ask a chat seat before building anything. If it can, it is worth having as an identifier for opening
and tracing a conversation; it still never authorises, because a URL is shareable.

## What this does NOT relax

The invariant is **not** "name your host". It is: *never drain, deliver or attribute on the ABSENCE
of evidence, and never guess an identity — a wrong guess reads someone else's mail AND issues them
the read receipt for it.* Preserved by scoping each operation to what the caller can actually assert:

- **machine-scoped** (records that DECLARE a host) → require a self-reported `host`;
- **record-scoped** (everything else) → require the caller to name its OWN minted id.

Both asserted, both refused **whole** when absent, neither ever inferred. A chat caller gains the
ability to drain the one record it names, and gains nothing else — **stricter** than the pre-
`e1c2487` behaviour, which drained a whole surface and cost seven messages (D9).

**A record-scoped drain returns every message addressed to that record regardless of sender**
(`handoff-core.js:1182` — messages append to the DESTINATION record tagged `from_session`). Two seats
messaging one chat seat both land in its record and both return on one drain.

## The regression this is written against

`280cb79` (2026-08-11 15:16) made `check_inbox` refuse every remote caller lacking `host`. It was a
correct fix for a real defect — a peer could otherwise drain the store host's records — and it
reasons exclusively about machines: *"a remote caller must name its own machine."* All four tests it
added concern hosts and devices. **A chat caller appears nowhere in it**, and the refusal sits above
all surface logic, so the review seat on the Claude app went deaf with no value it could pass.

**Nothing failed, because nothing could.** This ruling existed only in conversation. The project's own
standing rule is that *doctrine is advisory and tests are binding; a rule enforced only by prose is a
rule scheduled for violation.* This one was not even prose, and it lasted about nine hours against a
commit that was careful and correct about its own case.

## Chat has no ceremony — it has arrival

`handoff-core.js:743` mints every session `participation: 'passive'`; `:1010-1012` flips it to
`'active'` on the first actor event. **A chat conversation never introduces itself** — it gets a
record because something else made one for it. Code introduces itself; chat is introduced. That is
why it holds no identity payload beyond the minted id, and why there was nothing for any verb to
check.

A record's `nickname` is untouched by any of this: a property of the record, set through
`register_session`. Drain scoping does not touch naming.

## Enforcement site

**Per-surface admission, checked mechanically — not a convention each verb remembers.** A verb
requiring host-shaped evidence must be reachable only for surfaces whose records declare a host. The
binding check is a test asserting **a relay caller on `surface: chat` is never refused for lacking a
host** — it must go red if the door closes again, which is the thing prose could not do.
