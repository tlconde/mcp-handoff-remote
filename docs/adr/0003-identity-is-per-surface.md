# Identity is per-surface — a chat seat is not a machine

**Status:** accepted · operator ruling, previously undocumented · written 2026-08-12 after a
regression that could not have been caught

## Decision

**Each surface asserts a different KIND of identity, because each product is a different kind of
thing.** There is one enrolment ceremony, but the evidence it carries is not uniform across
surfaces, and no verb may demand evidence a surface cannot possess.

| surface | what it can assert about itself | what it CANNOT |
|---|---|---|
| **code** | `cli_uuid` (+ `cli_pid`, `cwd`), and a self-reported `host` — it runs in a process on a machine | — |
| **chat** | its own record; a browser conversation can name a **URL**. It has no process, no pid, no socket | **a hostname. It does not run on a machine in any sense the store can mean.** |
| **cowork / design** | per their own product shape; **UNVERIFIED** here until measured, and this file says so rather than guessing | — |

**A chat conversation has no hostname and never will.** Asking one for `os.hostname()` is not a
strict check, it is an unanswerable question, and a caller with no valid move is a door that is
closed rather than guarded.

## What is measurably on the wire — no new field needs inventing

Measured 2026-08-12 over **2,476 live `Claude-User` requests** (`relay.access.log`, 3,766 lines,
08-09 → 08-12). A chat call already arrives carrying a discriminator, and the relay already reads it:

| on the wire | value | today |
|---|---|---|
| Access JWT → `account_sub` | the account — **the only account-VERIFIED thing a chat seat holds** | passed to ctx |
| `user-agent` | `Claude-User` for chat **and cowork** (one app); `claude-code/2.1.x` for code | **read, then dropped** |
| `mcp-session-id` | transport connection id | **read at `:428`, then dropped** |

`handoff-relay.js:200` hands the daemon only `{remote:true, sender_class:'asserted', account_sub}`.
**The relay can already tell a chat call from a code call, and discards that before the verb that
demands a hostname.** The fix is to stop dropping what arrives — not to invent a chat credential.

**`mcp-session-id` is NOT a conversation identifier.** The relay MINTS it on the `initialize`
response (`:499`) and the client echoes it back; 653 `initialize` calls produced 648 distinct ids,
so it is 1:1 with connections and **cannot survive a reload by construction**. It is stable within a
connection — some spanned hours — which is exactly what makes it look usable. **Addressing hint or
telemetry, never a credential or a key.** Whether one id can span several conversations is Q15,
unmeasured; until it is run, it keys nothing.

**A conversation URL is not a credential either.** A URL is shareable and guessable, so anything it
authorised could be asserted by whoever saw it — the same weakness as the open `from_title`
impersonation finding. Useful as an identifier and for opening a conversation; never as a drain key.

## What this does NOT relax

The invariant is **not** "name your host". It is: *never drain, deliver or attribute on the
ABSENCE of evidence, and never guess an identity — because a wrong guess reads someone else's mail
AND issues them a read receipt for it.* That is preserved by scoping each drain to the strongest
thing the caller can actually assert:

- **machine-scoped** operations (records that DECLARE a host) require a self-reported `host`;
- **record-scoped** operations require the caller to name its OWN record.

Both are ASSERTED, both are refused **whole** when absent, neither is ever inferred. Same rule, two
scopes. A chat caller gains the ability to drain the one record it asserts and gains nothing else.

## The regression this is written against

`280cb79` (2026-08-11) made `check_inbox` refuse every remote caller lacking `host`. It was a
correct fix for a real defect — a peer could otherwise drain the store host's records — and its
commit message reasons exclusively about **machines**: *"a remote caller must name its own
machine."* All four tests it added concern hosts and devices. **A chat caller appears nowhere in
it**, and the refusal sits above all surface logic, so the review seat on the Claude app went deaf
over the relay with no value it could pass.

**Nothing failed, because nothing could.** This ruling existed only in conversation — not in
`CONTEXT.md`, not in an ADR, not in a test. The project's own standing rule is that *doctrine is
advisory and tests are binding; a rule enforced only by prose is a rule scheduled for violation*.
This one was not even prose, and it was violated within hours by a commit that was careful, correct
about its own case, and blind to a class it had no reason to consider.

The lesson is not "be more careful". It is that an operator ruling which never becomes an artifact
cannot survive the next correct-looking commit.

## Chat has no ceremony — it has arrival

`handoff-core.js:743` creates every session `participation: 'passive'`; `:1010-1012` flips it to
`'active'` on the first actor event. **A chat conversation never introduces itself.** It gets a
record because something else made one for it, and goes active when an event touches it. Code has a
ceremony; chat has arrival — **which is precisely why chat holds no identity payload, and why
nothing existed for a careful commit to violate.**

A record's `nickname` is unaffected by any of this: it is a property of the record, set through
`register_session`, and 3 of 35 chat records already carry one. Drain scoping does not touch naming.

## The plan this ADR authorises

1. **Stop dropping what already arrives.** Carry the surface-class (from UA) and `mcp-session-id`
   into ctx beside `account_sub`. No new fields, no new ceremony, no URL scheme.
2. **`host` is asked only where records declare one** — i.e. host-declaring records. A `Claude-User`
   call is definitionally not a machine, so the question is never put to it. This alone reopens the
   chat door.
3. **Drain scope is the caller's own record**, asserted and refused whole when absent. Stricter than
   the pre-`e1c2487` behaviour (whole-surface drains, which cost seven messages — D9) and looser
   than today (no valid move at all).
4. **Cowork carries BOTH** — its own record id and `origin_ref` to its parent chat.
5. **Deferred, not assumed:** recording `account_sub` on a chat record at first contact (Q16) would
   give chat its first verified fact and its first real ceremony. It identifies the HUMAN, not the
   conversation, so it scopes to "records this account owns" and needs the record id for the other
   half.

**A record-scoped drain returns every message addressed to that record regardless of sender**
(`handoff-core.js:1182`: messages append to the DESTINATION record tagged `from_session`). Two seats
messaging one chat seat both land in its record and both return on a single drain.

## Enforcement site

**Per-surface admission, checked mechanically — not a convention each verb remembers.** A verb that
requires host-shaped evidence must be reachable only for surfaces whose records declare a host. The
binding check is a test asserting that **a relay caller on `surface: chat` is never refused for
lacking a host** — it must fail if the door closes again, which is the thing prose could not do.

Where a surface's assertable identity is not yet measured, this file says **UNVERIFIED** rather
than describing something plausible, per the standard `TRANSPORT-MATRIX.md` already holds itself to.
