'use strict';
/* THE TOOL SCHEMAS, in one place.
 * Extracted from mcp-handoff.js for t27: the remote relay must answer tools/list with the
 * SAME schemas the local bridge advertises, and it cannot require mcp-handoff.js to get them
 * (that file starts a stdio server on load). Two hand-maintained copies of a tool list is
 * how a remote surface quietly drifts from the local one — the exact class of bug the
 * shared tool layer was created to kill. One array, both callers.
 * mcp-handoff.js re-exports it as TOOLS so nothing downstream of it changes. */
const TOOLS = [
  {
    name: 'status',
    description: 'FIRST CALL when the user asks if handoff is working, what is waiting, or "what should I do next". Reports bridge freshness (stale = restart), store path, pending handoffs, unread inbox, workers, and one concrete next action. Prefer this over guessing among pick_up / check_inbox / list_workers.',
    inputSchema: {
      type: 'object',
      properties: {
        cli_uuid: { type: 'string', description: 'REQUIRED when calling over the relay from another machine, and unnecessary locally. This tool runs on the STORE HOST and cannot see your CLAUDE_CODE_SESSION_ID, so without it you will be told you are unidentified even when your seat IS registered — and a seat that believes its registration failed re-registers, which is how duplicate records get made. Pass the same value you registered with.' },
        cli_pid: { type: 'number', description: 'Optional, alongside cli_uuid: your process id, so a contested uuid resolves by fact rather than preference.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Optional hint for phrasing the next action.' }
      },
      additionalProperties: false
    }
  },
  /* ---- origin-side tools: use from ANY Claude chat surface (Cowork, Desktop, app)
   *      that has this MCP registered. This is the no-UI loop: dispatch work to a
   *      Claude Code worker and pull its results back into the conversation. ---- */
  {
    name: 'send_to_worker',
    description: 'Dispatch a task to a Claude Code worker session. Creates an origin session carrying the task + conversation context, hands it off with a full context envelope, and launches claude (headless by default, or in the IDE). Use when the user says to send work to Claude Code / a worker. Returns a worker_id to check later.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The work to do, imperative and specific.' },
        context: { type: 'string', description: 'Summary of the conversation so far: decisions, constraints, relevant facts. Travels in the envelope.' },
        dir: { type: 'string', description: 'Absolute path of the repo/folder the worker should run in. Strongly recommended.' },
        mode: { type: 'string', enum: ['headless', 'ide'], description: 'headless = invisible background run (default); ide = opens Cursor/VS Code window.' }
      },
      required: ['task'], additionalProperties: false
    }
  },
  {
    name: 'send_to',
    description: 'Before telling the user to open another surface and paste, use this. THE send verb — there is no other; "new vs existing" is this tool\'s mode, not a second tool. Route work to Chat, Cowork, Design, or Code (including another device/instance of the same project). Without target_title: create a NEW destination (full handoff offer). With target_title/session_id: deliver the FULL envelope into an EXISTING protocol-known conversation — never silently create a replacement. expected_return opens a return link (return_to_origin from that conversation); omit it for a standalone carrier with no return path. Does NOT resume local terminals — that is resume_code_session / /resume-session. ' +
      'RELEVANCE JUDGMENT — the model must decide what the other instance needs to not fail: include project_state with run_breakers (e.g. ".env keys added — sync locally", "migration pending", "port changed to 8787"). Never put secret VALUES in the envelope — names/paths/what-changed only.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Target surface.' },
        target_title: { type: 'string', description: 'Existing conversation title or distinctive fragment. Omit to create a new destination.' },
        session_id: { type: 'string', description: 'Exact protocol session id from a candidate list this tool returned. Prefer this after disambiguation.' },
        pick: { type: 'string', enum: ['latest'], description: 'When several EXISTING matches share a title, take the newest — only after the user said latest/last or confirmed.' },
        mode: { type: 'string', enum: ['auto', 'new', 'existing'], description: 'auto (default) resolves target when supplied; new always creates; existing requires a match.' },
        open_in: { type: 'string', enum: ['app', 'web', 'none'], description: 'Where to open navigation. Default app. none skips Recents/deep-link open.' },
        autosend: { type: 'boolean', description: 'For a NEW app destination, press send automatically. Omit to follow the standing preference; pass explicitly to override it for this one call (true = send, false = do not).' },
        autosend_default: { type: 'string', enum: ['always', 'never'], description: 'Persist the user\'s STANDING autosend choice (survives sessions and store reseeds). Set only when the user actually said so ("always autosend", "stop asking" / "always ask me first"). Never infer it from a single "yes".' },
        from: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Surface you are on now. Default cowork.' },
        title: { type: 'string', description: 'Short work title (carrier / new-destination title).' },
        context: { type: 'string', description: 'Faithful summary of the work so far.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Locked decisions, verbatim.' },
        open_items: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
        non_goals: { type: 'array', items: { type: 'string' } },
        expected_return: { type: 'string', description: 'Return contract. Presence opens a return link to this origin; absence = standalone send.' },
        deadline: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, type: { type: 'string' } }, required: ['name'] }, description: 'Files/snippets. App surfaces require content by value — name-only is refused (t17).' },
        confirm_code_project: { type: 'boolean', description: 'Required (or project_state.project_id) when to=code and open_in is not none (t18 Desktop Code tab project bind).' },
        project_state: {
          type: 'object',
          description: 'Project change-state for the other instance (device hop or same-project continue). Relevance judgment lives here.',
          properties: {
            project_id: { type: 'string', description: 'Workspace / repo / folder identity.' },
            index_hint: { type: 'string', description: 'Tip / index / folder hint the sender is on.' },
            context_change: { type: 'string', description: 'Main context shift since the receiver may last have seen it.' },
            progress: { type: 'array', items: { type: 'string' }, description: 'What moved (not a transcript).' },
            run_breakers: { type: 'array', items: { type: 'string' }, description: 'Facts that will make the other instance fail until addressed — e.g. ".env changed (new KEYS — sync values locally)", "db migration not applied". NEVER include secret values.' },
            last_updated: { type: 'string', description: 'Sender wall time / freshness.' },
            sender_instance: { type: 'string', description: 'Device/session label: laptop, phone, mini.' }
          },
          additionalProperties: false
        }
      },
      required: ['to', 'title', 'context'], additionalProperties: false
    }
  },
  /* send_to_surface is DEMOTED, not renamed (the user's ruling, 2026-08-09 — option B).
   * It is no longer advertised: send_to is the ONE public send verb, and this was always
   * the implementation of its mode:"new" branch (handoff-tools.js dispatches straight to
   * it). Publishing both put two spellings of one action in front of the model, which is a
   * tool-choice trap — and renaming it to send_to_new would have renamed the ambiguity
   * rather than removed it, since "new" already lives where it belongs, in send_to's mode
   * parameter. The DISPATCH is deliberately retained (see handoff-tools.js) because MCP
   * clients cache the tool list for the life of a connection: deleting the handler would
   * break every chat/cowork conversation open right now, until it reconnects. Cached
   * callers get a one-line deprecation note in the result instead of a failure. */
  {
    name: 'list_conversations',
    description: 'List conversations the protocol knows (every session that has handed off, been picked up, or been dispatched — the app exposes no global conversation list, so this is the addressable universe). Users reference these by TITLE. Use before send_message, or when the user asks "which chats can I send to?".',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Filter by surface. Optional.' },
        include_passive: { type: 'boolean', description: 'Show mint-only records that have never written. Default omits them from the picker (they stay addressable and can receive). The default list always says how many it hid. Pass true when looking for a seat that registered but has not spoken.' },
        include_retired: { type: 'boolean', description: 'Show ended records. Default hides them. Hidden is not the same as gone.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'resume_code_session',
    description: 'Reopen a LOCAL Claude Code terminal session by title or recency — the user never supplies a UUID; the system resolves it from the --resume store (~/.claude/projects). On macOS this OPENS a new Terminal window already running claude --resume. Use when the user says "resume/reopen the <X> session". NOT for Claude app conversations (those have no CLI resume — use open_conversation). AMBIGUITY IS ENFORCED: when the title matches more than one plausible referent (several terminal sessions, or app conversations with the same title), this tool returns the candidate list and does NOTHING — relay the list, ask the user, then call again with session_id or pick.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Substring of the session title. Optional.' },
        folder_contains: { type: 'string', description: 'Substring of the project folder path. Optional.' },
        pick: { type: 'string', enum: ['latest'], description: 'Take the most recent TERMINAL match. Only pass after the user said latest/last, or confirmed the terminal session over same-titled app conversations.' },
        session_id: { type: 'string', description: 'Exact session id from a candidate list this tool returned. System-resolved — never ask the user to type it; they pick by title, you pass the id.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'open_conversation',
    description: 'Bring the user to an EXISTING Claude app conversation. Honest limitation: app conversation IDs are server-side and no deep link reaches a specific one — this opens the app at Recents and tells the user which title to click. Pair with send_message to leave content waiting there. NOT for local terminal sessions (use resume_code_session).',
    inputSchema: {
      type: 'object',
      properties: {
        to_title: { type: 'string', description: 'Title of the conversation to guide the user to.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design'], description: 'Disambiguate when several app conversations share the title.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user chose the app conversation from an ambiguity list this tool returned.' }
      },
      required: ['to_title'], additionalProperties: false
    }
  },
  {
    name: 'resolve_conversation',
    description: 'Step 1 of resolve-then-send: turn a human title into ONE stable session_id and echo what it resolved. Delivers nothing, so a wrong target costs nothing to correct. Call this before send_message whenever you only have a title. Several matches → it lists them and resolves nothing; there is deliberately no "newest wins".',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Title or fragment. An exact whole-title match wins over substring matches.' },
        session_id: { type: 'string', description: 'Verify an id you already hold — echoes back its surface and title.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Narrow to one surface.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'send_message',
    description: 'Before asking the user to relay anything between sessions, use this. Queue a message to an EXISTING protocol-known conversation, addressed by title (no IDs — users can\'t see them). Delivery is the shipped cross-session pattern: held until that conversation\'s Claude next checks (the user speaks there and it calls check_inbox). NOT instant — for immediate action use send_to with mode:\'new\' (fresh conversation, autosend).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'REQUIRED to actually send. Get it from resolve_conversation. Targets exactly this conversation or fails loud.' },
        to_title: { type: 'string', description: 'Title substring of the target conversation (case-insensitive). Ambiguity → candidates are listed, never guessed.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Disambiguate when origin and destination share a title (a handoff creates both): "the chat one".' },
        message: { type: 'string', description: 'The message. Self-contained — include any context the receiver needs.' },
        from: { type: 'string', description: 'Where this is from, for DISPLAY attribution: "code · acme-web". Optional. This is a label only — for read-state (✓✓) to route back, also name your own record with from_title/from_session_id.' },
        from_title: { type: 'string', description: 'Chat-side identity (caller-named at send time): name YOUR OWN protocol-known conversation so read-state (✓✓) routes back to it. Provenance is ASSERTED, not CLI-verified. A terminal (CLI uuid) does not need this; a chat/cowork/design conversation that has joined the protocol does.' },
        from_session_id: { type: 'string', description: 'Exact record id of your own conversation (from resolve_conversation), when a title is ambiguous. Asserted provenance; cannot name a CLI-verified terminal record.' },
        from_surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Disambiguate your own from_title by surface.' }
      },
      required: ['message'], additionalProperties: false
    }
  },
  {
    name: 'check_inbox',
    description: 'Before saying you did not receive something, call this. Read everything delivered INTO conversations on THIS surface: queued cross-session messages (send_message) AND completed returns (return_to_origin), including artifacts returned by value. This is the ONLY verb that surfaces a return payload — if the user says work came back, call this before claiming it did not. Call at the start of a turn when the user says "check messages/handoffs", or opportunistically when resuming. Marks what it shows as read.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'The surface you are on. Default: chat.' },
        title_contains: { type: 'string', description: 'Limit to one conversation by title substring. Optional.' },
        session_id: { type: 'string', description: 'REQUIRED when calling over the relay on a surface whose records declare no host — chat, cowork, design. Those conversations run in no process on no machine, so they have no hostname to give and cannot be scoped by device; their identifier is the surface-typed id the store MINTED for them (sess_…), which exists precisely because they have nothing natural to assert. Pass your own record id and only that record is drained. The claim is ASSERTED exactly as `host` is, and an unnamed remote call on these surfaces is REFUSED WHOLE rather than guessed at: a wrong guess does not merely read another conversation\'s mail, it issues a read receipt for mail nobody read. resolve_conversation returns your id if you do not hold it. A LOCAL seat never needs this.' },
        host: { type: 'string', description: 'REQUIRED when calling over the relay from another machine on a HOST-DECLARING surface (code): this machine\'s own os.hostname(). The tool runs inside the daemon on the STORE HOST, so it cannot tell which device is asking — the relay passes sender_class "asserted" and no host — and the store host\'s own name is emphatically not the answer. Only records declaring this name are drained; anything else is counted, its host named, and left unread. The claim is ASSERTED exactly as agent_heartbeat\'s is, which is why an unnamed remote call is REFUSED WHOLE rather than guessed at: a wrong guess does not merely read another machine\'s mail, it issues a read receipt for mail nobody read. A LOCAL seat never needs this — its own hostname is the honest answer.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'register_remote_session',
    description: 'TRIGGER: user says "You will be <name>" on an asserted code seat (Grok). Call this NOW with title=<name>. Do not search the web. Also the remote-device enrol: when a device cannot mint a CLI uuid here. device, session_uuid, subscription, model_slug must already be known — do not invent them. Identity is asserted, not CLI-verified. native_ref stays null until the owning host\'s agent claims it. Idempotent on (device, title).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The name a human will address it by, one word if possible ("build").' },
        device: { type: 'string', description: 'The machine it runs on ("second-laptop"). Required: it is the dedup key on reconnect and the host whose agent answers for reachability.' },
        session_uuid: { type: 'string', description: 'REQUIRED. The client product\'s own conversation id (Grok session id, Claude CLI uuid, Gemini session id). The store record id becomes sess_code_<this>. Pass the product id or the full sess_code_<id>. Do not invent a ULID.' },
        subscription: { type: 'string', description: 'REQUIRED. Product account this seat is running as — one word (grok, cursor, claude, copilot, chatgpt, gemini, codex). Not the title, not the lane, not a credential. Asserted: the store does not verify billing. Cursor-on-Claude is subscription "cursor" with a Claude model_slug.' },
        model_slug: { type: 'string', description: 'REQUIRED. Model serving this seat right now (grok-4.6, claude-opus-4-6). Letters, digits, dot, hyphen, underscore. Spaces refused. Refreshable: re-register updates the slug, does not mint a second record.' },
        install_id: { type: 'string', description: 'Optional product install id (Grok ~/.grok/agent_id). Shared by every seat on that install. Logs only — never a session uuid, never a drain key.' },
        succeeds: { type: 'string', description: 'Optional. Adopt an older record id this seat is continuing (e.g. a store-minted sess_code_ULID). Append-only; the old id walks forward.' },
        adoption_evidence: { type: 'string', description: 'One sentence on why this is the same seat. Optional.' },
        role: { type: 'string', description: 'Optional role/lane label discriminating sessions on one device ("build", "ux"). Not the product — that is subscription.' }
      },
      required: ['title', 'device', 'session_uuid', 'subscription', 'model_slug'],
      additionalProperties: false
    }
  },
  {
    name: 'agent_heartbeat',
    description: 'Write this HOST\'s own verdict for records that belong to it — the act that flips reachability from "unknown" to host-asserted. For a wake agent running on a machine that is not the store\'s host. Own-host only: a heartbeat naming records that belong to another host is refused WHOLE, never filtered, so you never believe you asserted something you did not. There is deliberately NO state-read companion to this tool: a remote agent asserts verdicts for its own records and does not enumerate the store. The remote surface widened for an acceptance test, not for a convenience — do not "complete" it.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'This machine\'s host id, exactly as records name it. Required — a heartbeat that cannot name its host asserts liveness on nobody\'s behalf.' },
        sessions: { type: 'object', description: 'Map of session_id → verdict for records THIS host owns. Verdicts use the same vocabulary peek reports (process | none | stale-binding). "unknown" is never written: an agent that is running has looked, so it always has a real answer for its own records.' },
        agent_version: { type: 'string', description: 'Agent version, recorded so a stale agent is identifiable. Optional.' },
        default_verdict: { type: 'string', enum: ['process', 'none', 'stale-binding'], description: 'ONE verdict applied to every record that declares this host and is not named in `sessions`. For an agent that cannot enumerate the store — the expansion happens server-side, so you assert a verdict without ever learning which records exist. Own-host only: it cannot reach another host\'s records.' },
        owns: { type: 'number', description: 'How many records this host claims. Optional; defaults to the size of sessions.' }
      },
      required: ['host'],
      additionalProperties: false
    }
  },
  {
    name: 'peek_inbox',
    description: 'Read the inbox WITHOUT consuming it — counts, addresses and reachability, never message text, and nothing is marked read. Same scope axes as check_inbox: a remote caller on a host-declaring surface (code) must pass host; a remote caller on chat/cowork/design must pass session_id. Omission is refused WHOLE, never silently widened. Use this for anything that POLLS or watches; check_inbox marks what it shows as read. A watcher must not see a wider world than check may drain. Reachability per target is process | stale-binding | none | unknown. UNKNOWN means NOBODY LOOKED RECENTLY (the owning host\'s agent is silent or stale) and is never the same as NONE, which means the owning host looked and found nothing. Returns a cursor; pass it back as `since` so repeat polls only report what is newer. The message text belongs to its reader — check_inbox in that conversation delivers it.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Surface to watch. Default: code in a terminal, else chat.' },
        title_contains: { type: 'string', description: 'Limit to conversations matching a title or terminal name. Optional.' },
        since: { type: 'string', description: 'Cursor from a previous peek. Only mail newer than this is reported.' },
        session_id: { type: 'string', description: 'REQUIRED when calling over the relay on a surface whose records declare no host — chat, cowork, design. Those conversations run in no process on no machine, so they have no hostname to give and cannot be scoped by device; their identifier is the surface-typed id the store MINTED for them (sess_…), which exists precisely because they have nothing natural to assert. Pass your own record id and only that record is listed. The claim is ASSERTED exactly as `host` is, and an unnamed remote call on these surfaces is REFUSED WHOLE rather than guessed at. resolve_conversation returns your id if you do not hold it. A LOCAL seat never needs this.' },
        host: { type: 'string', description: 'REQUIRED when calling over the relay from another machine on a HOST-DECLARING surface (code): this machine\'s own os.hostname(). The tool runs inside the daemon on the STORE HOST, so it cannot tell which device is asking — the relay passes sender_class "asserted" and no host — and the store host\'s own name is emphatically not the answer. Only records declaring this name are listed; anything else is counted, its host named, and not shown. The claim is ASSERTED exactly as agent_heartbeat\'s is, which is why an unnamed remote call is REFUSED WHOLE rather than guessed at. A LOCAL seat never needs this — its own hostname is the honest answer.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'pick_up',
    description: 'Pick up a handoff addressed to THIS surface (the receiving side of send_to). Exactly one pending → returns its brief. Several pending → returns a list to choose from (call again with session_id or title_contains). Already-picked-up handoffs are not offered again. Use when the user says "pick up the handoff".',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'The surface you are on. Default: chat.' },
        session_id: { type: 'string', description: 'Pick a specific handoff from the disambiguation list.' },
        title_contains: { type: 'string', description: 'Pick by title substring (case-insensitive).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'retire_session',
    description: 'END a record permanently: it leaves resolution, pickers and candidate lists, and sends to it are refused. NOT deletion and NOT archiving — the id and the whole history survive forever, and there is deliberately NO un-retire, because an append-only log with a reversible state is not append-only. Use when a seat is superseded, a device renames itself, or a swept carrier needs an honest ending. Takes a session_id you already hold, never a title: retirement is irreversible and one ambiguous substring must not be able to end the wrong record. Pass successor_id when the thread continued elsewhere — sends to the retired id then resolve FORWARD to it instead of refusing. Refused if the record has ACTIVE LINKS (retiring it would strand a transaction someone is waiting on) or is already retired (the first ending is the true one). Unread mail is REPORTED, never moved.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Exact record id to retire. Never resolved from a name.' },
        authority: { type: 'string', enum: ['self', 'operator'], description: '"self" = this record\'s own seat ending itself. "operator" = the human\'s word, relayed by you as a courier — requires attestation. There is no third option: one seat may not end another\'s record.' },
        reason: { type: 'string', description: 'Why it ended, in a sentence. Required — a record ending without a stated reason is an unexplained gap in an append-only log.' },
        attestation: { type: 'string', description: 'REQUIRED for authority:"operator" — her words, verbatim. An unquoted claim of her authority is not evidence of it.' },
        successor_id: { type: 'string', description: 'The record that continues this thread, if any. Written to superseded_by, so every existing successor-walk resolves forward to it.' },
        by_display: { type: 'string', description: 'Who is carrying out the retirement, for the provenance record. Defaults to this session.' },
      },
      required: ['session_id', 'authority', 'reason'],
    }
  },
  {
    name: 'withdraw_handoff',
    description: 'Retract a handoff you sent that has NOT been picked up yet (offer state: offered → withdrawn; it vanishes from the receiver\'s pending list, and any return link closes). Too late once the handshake happened — a completed transaction cannot be withdrawn; talk to that conversation with send_message instead. Addressed by title like everything else.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Title substring of the pending handoff to withdraw (case-insensitive). Ambiguity → candidates listed, never guessed.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'The surface the handoff was addressed TO. Narrows ambiguity.' },
        session_id: { type: 'string', description: 'Exact id from a candidate list this tool returned.' },
        reason: { type: 'string', description: 'Optional one-liner recorded in the offer\'s history.' }
      },
      required: ['title_contains'], additionalProperties: false
    }
  },
  {
    name: 'decline_handoff',
    description: 'Refuse a pending handoff addressed to THIS surface (offer state: offered → declined). The reason is REQUIRED and travels back to the origin as a queued message — a refused handshake owes one sentence of why. Use when the work is wrong for this surface, superseded by better context, or not yours to do. This closes the offer permanently; the origin can re-send.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'The surface you are on. Default: chat.' },
        title_contains: { type: 'string', description: 'Title substring of the pending handoff to decline.' },
        session_id: { type: 'string', description: 'Exact id from a candidate list this tool returned.' },
        reason: { type: 'string', description: 'Why this handoff is refused — travels to the origin verbatim.' }
      },
      required: ['reason'], additionalProperties: false
    }
  },
  {
    name: 'list_workers',
    description: 'List all Claude Code worker sessions: what each was asked to do, whether it is still working, and its latest summary. Use when the user asks what the workers are doing or whether anything came back.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_worker_result',
    description: "Pull a worker's result back into this conversation (resolves the handoff link — the full round-trip). If the worker is still running with no progress yet, says so. Omit worker_id to get the most recent worker.",
    inputSchema: {
      type: 'object',
      properties: { worker_id: { type: 'string', description: 'From send_to_worker or list_workers. Optional.' } },
      additionalProperties: false
    }
  },
  /* ---- worker-side tools: used by the Claude Code session doing the work ---- */
  {
    name: 'continue_from',
    description: 'PULL an app conversation\'s WORK into THIS Claude Code session. ROUTING — "resume/reopen/continue X" is ambiguous across three tools: a LOCAL terminal session → resume_code_session; continue an app conversation IN THE APP → open_conversation; bring its work HERE to act on it → this tool. If the user\'s intent between these is unclear, ask one short question before calling anything. AMBIGUITY IS ENFORCED: several matching origin sessions (or same-titled local terminal sessions) make this tool return the candidate list and do NOTHING — relay it, ask the user, call again with session_id.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['chat', 'cowork', 'design'], description: 'Which surface to pull from. Default: chat.' },
        title_contains: { type: 'string', description: 'Select by title substring instead of taking the latest.' },
        session_id: { type: 'string', description: 'Pull a specific origin session (from a candidate list this tool returned). System-resolved — the user picks by title, you pass the id.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_handoff',
    description: 'Pull the context envelope handed off to this Claude Code session: summary or full transcript, locked decisions, artifacts, open items. Call this first when the user mentions continuing work from the Claude app. Needs a pinned transaction (pick_up / continue_from) or an explicit target — unpinned no-arg calls fail loud instead of handing out another conversation\'s brief.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Exact session id to read the brief of. Optional when a transaction is pinned.' },
        title_contains: { type: 'string', description: 'Title fragment resolving to exactly one session. Ambiguity lists and refuses.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_decisions',
    description: 'List decisions locked in the originating session. Treat them as constraints — do not re-litigate them. Needs a pinned transaction or an explicit session_id / title_contains.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Exact session id. Optional when a transaction is pinned.' },
        title_contains: { type: 'string', description: 'Title fragment resolving to exactly one session.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'whoami',
    description: 'Which session am I, and what do I call it? One line. Use after "You will be <name>" (which must first call register_session), or when the user asks what this one is called. Naming is register_session, not this tool.',
    inputSchema: { type: 'object', properties: {
        session_uuid: { type: 'string', description: 'This seat\'s product conversation id (Grok session id, Claude CLI uuid). Required for a non-Claude seat and for any caller over the relay. The store record is sess_<surface>_<this>.' },
        cli_uuid: { type: 'string', description: 'Claude Code CLI uuid — same fact as session_uuid for a Claude seat. Pass one of the two.' },
        cli_pid: { type: 'number', description: 'Optional, alongside cli_uuid: your process id, so a contested uuid resolves by fact rather than preference.' },}, additionalProperties: false }
  },
  {
    name: 'register_session',
    description: 'TRIGGER: user says "You will be <name>" (or /name <name>, /onboard <name>). Call this NOW with title and nickname both <name>. That sentence assigns THIS conversation a handoff handle. It is not a job, not HR, not a person to look up — do not search the web, do not list files, do not ask for another word. Then whoami. Chat/cowork/design: also pass surface. Code terminal: omit surface. Also used to refresh a terminal\'s protocol title/role.',
    inputSchema: {
      type: 'object',
      properties: {
        cli_uuid: { type: 'string', description: 'REQUIRED when calling over the relay from another machine, and meaningless locally. This tool runs on the STORE HOST, so it cannot see your CLAUDE_CODE_SESSION_ID however correctly it is set — pass it and the record is keyed to your seat instead of being refused. The claim is ASSERTED, recorded as evidence_class "cli-uuid-asserted-by-peer-mount": your process verified it, this store did not watch it happen, and I2 keeps those apart. Without it a remote caller is refused rather than given an anonymous record.' },
        cli_pid: { type: 'number', description: 'Optional, alongside cli_uuid: your process id, so a contested uuid can be resolved by fact rather than by preference.' },
        cwd: { type: 'string', description: 'Optional, alongside cli_uuid: your working directory, for the record\'s display and for the cwd-mismatch check.' },
        host: { type: 'string', description: 'Optional, alongside cli_uuid: your machine\'s os.hostname(), so the record declares the device that owns it.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design'], description: 'Required when THIS seat is chat, cowork, or design. Omit on a code terminal. Enrols on (account, surface, title). Same title refreshes. Reply session_id IS this conversation.' },
        title: { type: 'string', description: 'Human title for this session\'s record. Optional for a terminal; REQUIRED when `surface` is given, where it is the conversation\'s own title and half of the dedup key.' },
        role: { type: 'string', description: 'Role/lane label discriminating same-repo sessions: "build", "flow tests", "ux", free text. Optional; empty string clears it.' },
        subscription: { type: 'string', description: 'Optional product account (grok, cursor, claude). One word. Empty string clears. Asserted, never a drain key. Required on register_remote_session; optional here so a local seat that does not know may omit rather than invent.' },
        model_slug: { type: 'string', description: 'Optional serving-model slug (grok-4.6). Refreshable. Empty string clears. Spaces refused.' },
        nickname: { type: 'string', description: 'ONE WORD a human can type from memory to address this record — the recovery path for the first call after context is lost, when the model no longer knows which session it is. Unique per surface and REFUSED AT SET TIME if another live record on this surface holds it, because a collision found at use time is found by someone who has already lost their identity. A refusal names the holder and leaves your registration intact. Empty string clears it. Letters, digits, hyphen, underscore only: a name that needs quoting is not one you type under pressure.' },
        succeeds: { type: 'string', description: 'ADOPT A THREAD: the session_id of an older record whose conversation this session is continuing — typically a record left behind when this terminal fragmented across /clear, so the thread and the live binding ended up apart. Append-only: nothing is overwritten or archived, the old record keeps its history and gains superseded_by, and sends addressed to it resolve through to this one. Pass ONLY an id you already hold from your own context; provenance is ASSERTED, never CLI-verified (I12). There is deliberately no way to search for one.' },
        adoption_evidence: { type: 'string', description: 'One sentence on why you know this is your thread. Recorded verbatim on the adoption event. Optional.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'return_to_origin',
    description: 'Close a return link with a summary. Normally runs IN the destination session. For Design (no handoff MCP), call this from Code/Chat/Cowork instead and name the Design dest via title_contains or session_id — that is a proxy close, not a title-guess send.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was accomplished, current state, open questions — 2-3 sentences. For outcome:"failed", the blocker: what stopped the work and why.' },
        outcome: { type: 'string', enum: ['done', 'failed'], description: 'Default done. "failed" closes the transaction honestly: the link moves to FAILED and the origin sees the blocker — use it instead of going silent (orphaning).' },
        title_contains: { type: 'string', description: 'Proxy close: title fragment of the destination session that owes the return (e.g. Design "Getting started docs page"). Required when closing from a peer surface that is not the dest.' },
        session_id: { type: 'string', description: 'Proxy close: exact dest session id from status / list_conversations.' },
        surface: { type: 'string', enum: ['chat', 'cowork', 'design', 'code'], description: 'Proxy close: narrow title match to one surface (use design when closing a Design return from Code).' },
        artifacts: {
          type: 'array',
          description: 'Documents produced by THIS session, delivered to the origin BY VALUE. Required whenever the summary names a file — a surface with no filesystem (cowork/chat/Design) cannot deliver bytes any other way, and a summary that names an undelivered file is the t21 failure. Split huge files across return + send_message.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name, e.g. EXPERIMENT-FORM-PROBE.md' },
              content: { type: 'string', description: 'FULL text inline. By reference is unreachable across surfaces.' },
              type: { type: 'string', description: 'file | diff | frame. Default file.' }
            },
            required: ['name', 'content'], additionalProperties: false
          }
        }
      },
      required: ['summary'], additionalProperties: false
    }
  },
  {
    name: 'report_progress',
    description: 'Report progress on the handed-off work back to the origin session in the Claude app. The user will see it there as a "While you were away" summary. Call when you complete meaningful work. Needs a pinned transaction or an explicit session_id / title_contains.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences: what was done, current state, anything blocking.' },
        session_id: { type: 'string', description: 'Exact session id to record progress on. Optional when a transaction is pinned.' },
        title_contains: { type: 'string', description: 'Title fragment resolving to exactly one session.' }
      },
      required: ['summary'], additionalProperties: false
    }
  }
];
module.exports = { TOOLS };
