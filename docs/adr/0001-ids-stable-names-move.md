# Ids are immutable; names move

**Status:** accepted · enforced at the store write layer · thickened 2026-08-10

## Decision

Session records keep a stable protocol id for their lifetime. Titles and `native_ref.name` may
change or diverge; they must never rewrite the id.

## Enforcement site

The store's write layer refuses an id change outright — a **409 choke point** rather than a
convention, so every verb inherits the rule without having to remember it. The refusal names the
remedy in place of the operation it declined:

> Names move, ids do not: change the title or the nickname instead. To link two records use
> adoption (`succeeds`), which supersedes and never rewrites — both keep their ids and resolution
> follows the chain.

One choke point is the whole design. A rule enforced per-verb is a rule that is enforced until
somebody adds a verb.

## Rejected alternatives

1. **Treat the current human-visible name as identity.** Already produced silent mis-delivery when
   the app or the operator renamed a conversation: messages went to a record that merely *contained*
   the typed word while the live terminal that actually answered to it was never a candidate.
2. **Rewrite the id and keep a redirect.** Every holder of the old id — pins, links, transaction
   records, another machine's message queue — would need to learn about the redirect, and the ones
   that did not would fail silently rather than loudly. Adoption solves the same problem
   append-only: nothing is overwritten, the old record keeps its history and gains `superseded_by`.
3. **Enforce uniqueness on names so they could serve as ids.** Overruled separately (R3): a
   nickname that refuses on collision is a name pretending to be an id, and it puts the failure at
   set time on a user who is not yet lost. Uniqueness is what ids are for; resolution carries the
   burden instead — exact beats substring, several matches are listed and never guessed.

## Consequences

- Renaming is always safe, which is why titles can be casual and nicknames can be typed from
  memory.
- Resolution is a search problem, not a lookup, and must therefore be allowed to return several
  candidates and refuse rather than pick.
- Adoption (`succeeds`) is the ONLY link between two records, and its provenance is asserted by the
  caller, never CLI-verified.

## What would reopen this

- A store that is no longer single-writer, where ids are minted in more than one place. The rule
  survives; the choke point would need to move.
- Evidence that the 409 is being routed around — a verb that writes records without going through
  the write layer. That is a defect against this ADR, not a reason to revisit it.
