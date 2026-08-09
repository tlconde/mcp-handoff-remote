'use strict';
/**
 * The forwarder↔daemon wire contract version. ONE constant, imported by BOTH the daemon
 * and every forwarder (daemon acceptance test (a)). Bump on ANY change to the request/
 * response envelope below. A forwarder whose CONTRACT differs from the daemon's is refused
 * loud and must exit so Claude Code respawns a matching one — never a silent version drift.
 *
 * Envelope (newline-delimited JSON, the approved framing):
 *   request : {"contract":<n>,"id":<any>,"method"|"tool":…,"args":{},"ctx":{cli_uuid,pinned,cwd},"identity":{cli_uuid,cwd}}
 *   response: {"id":<any>,"code":<httpish>,"result":<payload>,"ctx_update":{pinned}?}  OR  {"id","error","fatal":<bool>,…}
 * A response with fatal:true means the forwarder must exit (contract mismatch or daemon stale).
 *
 * v2 (2026-08-08): pin write-back. A tool that changes the caller's pinned transaction
 * (pick_up, continue_from set it; a close may clear it) returns `ctx_update: {pinned: <id|null>}`
 * in the response. The DAEMON is the sole pin writer — it decides the pin from the tool's
 * result; the forwarder MUST apply it verbatim to its own per-session pin (symmetric: an id
 * sets, null clears). `ctx_update` absent = no change.
 *
 * v3 (2026-08-08): identity write-back — `ctx_update: {identity: <id>}`. Same mechanism, one
 * more field. register_session resolves the CALLER'S OWN protocol record, which the caller
 * must then remember for later ctx (status renders it; sends attribute to it). Without this
 * a pure forwarder could register and never learn its own id — its very next status would
 * report "not yet registered" immediately after registering. Both keys are independent and
 * optional: a tool sends back only what it changed, and an absent key means no change.
 */
module.exports = { CONTRACT: 3 };
