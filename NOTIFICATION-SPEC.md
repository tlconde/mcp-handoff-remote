# Notification copy spec (final rule, owner-approved 2026-08-08)

Pings are **PERMANENT** (the wake tier never replaces them; it only changes what they mean —
informational, not a to-do). They must read like **a colleague's status line, not a system
event.** This supersedes the earlier "three shapes / label-word" draft.

## The rule
- **The work is always the headline, in the work's own words.** `task` / `update` / `done`
  are *meanings*, never labels — never print them as tags.
- **Title = window name + the work in its own words.**
- **Body = what is happening right now, phrased as a person would say it**, plus an action
  phrase ONLY when a tap does something.
- **Plain words underneath, everywhere user-facing (including tool result lines):** no
  protocol vocabulary — `drain`, `mail`, `envelope`, `store`, `origin`, `carrier`.

## Locked examples
- `ai-product-sense-2a — Continuing the order: the OPERATING-LESSONS installs.` · body:
  `From your chat — say anything there to hand it over.`
- `Docs sweep — Building the coverage manifest: support.claude.com done, 310 pages.` (no action)
- `Wake tier — Live test passed.` · body: `Open your chat to review the proof.`

## The wake line — the knock (amended 2026-08-09, owner-approved)

The rule above governs **notifications**, which the user reads. The **wake line** is different
in audience and in kind: it is agent-facing, and it rides *inside* a native cross-session
message that the relay session sends into the target terminal. It had no spec home at all
until this amendment — which is part of why it could drift.

**Two provenances are in play, and they are not the same fact.**

| | belongs to | carried by |
|---|---|---|
| **Relay attribution** — who knocked | the relay session | native's own sender metadata |
| **Letter provenance** — who wrote the mail | the original sender | the wake line's text |

The old line — `mail waiting on <thread> — checking the inbox will deliver it` — named
neither. The receiving terminal learned that *something* was waiting but not from whom, and
the only way to find out was to go and look, which is a tap the wake tier exists to remove.

**Amended line, locked:**

- with a known sender: `mail from <sender> on <thread> is waiting — checking the inbox will deliver it`
- with none: `mail waiting on <thread> — checking the inbox will deliver it`

**The knock names the sender; it never impersonates one.** The relay says *"mail from your
chat"* and never *"I am your chat"* — it speaks ABOUT the sender, never AS them, and native's
attribution of the knock stays truthfully the relay's. An unnamed sender **stays unnamed**:
we do not invent an origin to make the sentence read better, for the same reason nothing else
here guesses. Asserted in `wake-smoke` both ways, including that the line never opens in the
sender's voice.

## Install status
- **New-work-waiting (the send-site ping): DONE** — `mcp-handoff.js` send_message notify()
  now emits `"<window> — <the work>"` / `"From <sender> — say anything there to hand it over."`.
  `mcp-smoke` asserts colleague-line shape + no label/protocol words.
- **Progress + Return copy: the wake-tier session's** (per the ownership split) — apply this
  same rule there; sent in the coordination ping.
- **Plain-words sweep of tool-result strings: PENDING** — a pass over `mcp-handoff.js`
  user-facing strings to remove `drain`/`mail`/`envelope` etc.

## Coordination
`handoff-notify.js` fires whatever `{title, body}` it is given; the copy is built at the call
site. The wake-tier session reuses `handoff-notify.js`'s API unchanged, so copy edits at the
caller do not collide with its module. Progress/Return copy that fires from the wake-tier
module is that session's to apply, using this table.
