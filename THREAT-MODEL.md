# Threat model — Continue in… / handoff protocol

*Security & privacy note for reviewers. Covers the reference MCP and the intended native Dispatch-source design. Not a penetration test.*

## Assets

| Asset | Sensitivity | Where it lives (reference MCP) |
|---|---|---|
| Session envelope (summary, decisions, open items, notes) | User work product; may include secrets if the user put them in chat | `~/.claude-handoff/data.json` |
| Ops telemetry | Workflow metadata (routes, dispatch, errors) | `~/.claude-handoff/ops.jsonl` |
| Native Claude Code transcripts | Full conversation | `~/.claude/projects/<slug>/<uuid>.jsonl` (unchanged; protocol links, does not replace) |
| Titles used as handles | Low–medium (often descriptive of work) | Same stores; listed to the local user only |
| Pitch / demo store | Synthetic | `~/.claude-handoff-demo` — never the live store |

## Trust boundaries

```
┌─────────────────────────────────────────────┐
│  Claude app (Chat / Cowork / Design / Dispatch) │  ← Anthropic trust boundary
└──────────────────┬──────────────────────────┘
                   │ stdio MCP (local process)     reference only
┌──────────────────▼──────────────────────────┐
│  mcp-handoff.js + handoff-core.js             │  ← user machine, same uid
│  ~/.claude-handoff/                           │
└──────────────────┬──────────────────────────┘
                   │ spawns / resumes
┌──────────────────▼──────────────────────────┐
│  Claude Code CLI (local sessions)             │
└─────────────────────────────────────────────┘
```

**Native ask:** handoff cards enter Dispatch *inside* the app boundary — no new network surface, no third-party host.

## What we explicitly do not claim

- Session UUID is **not** a capability token. `claude --resume <uuid>` only opens sessions already on that machine; cloud teleport requires the same claude.ai account (documented in README).
- The pitch HTTP server (`server.js`) binds `127.0.0.1`, no auth — demo-only. Override via `HANDOFF_BIND` is conscious and out of the product path.
- External MCP cannot push into idle app conversations without a user turn (or OS accessibility hacks). That limitation is a **feature** for untrusted deep links; trusted Dispatch handoffs should not need those hacks.

## Threats & mitigations

| ID | Threat | Severity | Mitigation (reference) | Mitigation (native) |
|---|---|---|---|---|
| T1 | Malicious deep link auto-sends into a conversation | High | Deep links require human send; no clipboard injection path | Trusted Dispatch cards skip untrusted-link consent; untrusted links keep human send |
| T2 | Cross-account / cross-machine session steal via UUID | High | UUID ≠ capability; local store only | Same; no cross-account handoff (non-goal v1) |
| T3 | Prompt injection via queued cross-session message | High | Queued delivery; receiver model still must treat inbound as untrusted text; titles disambiguate | Same + product framing: inbound cards are attributed, quoted |
| T4 | Carrier drift / fabrication traveling as fact (t16) | Medium–High | Fidelity graders; A12 "verify before affirm"; predictions labeled | Sample graded returns; show uncertainty on resume cards |
| T5 | Store wipe by tests / demos (t10) | High (integrity) | `HANDOFF_HOME` mandatory for tests; demo store separate; no force-seed on default | Prod analytics ≠ experiment scratch |
| T6 | Stale bridge / dual process lying about protocol state (A8) | Medium | `STALE BRIDGE` self-report; refuse to grade | Single shipped binary; no multi-bridge fleet |
| T7 | Ambiguous title → wrong session routed (t11) | Medium | List-and-refuse when &gt;1 candidate | Same UX rule in Dispatch routing |
| T8 | Local malware reads `~/.claude-handoff/` | Medium | Same as any local Claude data; filesystem permissions | App sandbox / OS user isolation |
| T9 | Pitch server exposed beyond loopback | Medium | Default 127.0.0.1; not in product path | N/A — do not ship pitch server |
| T10 | Secrets in summaries / `project_state` compact into envelopes | Medium–High | Carrier contract: `run_breakers` carry **names/paths/what-changed** only (e.g. ".env gained DATABASE_URL — sync locally"), never values; user-controlled chat may still leak | Same + redaction hooks on compaction; Dispatch cards must not echo secret values from chat into `project_state` |

## Privacy principles

1. **Local-first reference path** — product MCP has no network surface (stdio only).
2. **No third-party analytics** in the reference impl; ops stay on disk.
3. **Delivery is queued, never injected** — content does not appear in a composer without an explicit pull (`check_inbox`) or native trusted Dispatch delivery.
4. **Honest failure** — `outcome: failed` and decline reasons travel back; silent orphan is graded as a defect, not hidden.
5. **Titles are user-visible handles** — avoid putting secrets in titles; UUIDs stay system-resolved.

## Review checklist (before showing Anthropic security / privacy)

- [ ] Confirm non-goals: no cross-account, no live sync, no third-party host.
- [ ] Confirm Dispatch-source ask adds no new egress.
- [ ] Confirm session UUID story matches shipped teleport/resume docs.
- [ ] Confirm demo server is labeled non-product and loopback-only.
- [ ] Confirm t16-class drift is in the fidelity / abuse narrative (not only "quality").
- [ ] Confirm interview / demo scripts never require pasting secrets into chat for the pitch.

## Residual risk (accept or escalate)

| Residual | Owner |
|---|---|
| Model may still treat a quoted malicious message as instructions | Model + product safety (existing) |
| User may put API keys in chat that then enter envelopes | User education + future redaction (v2) |
| Power-user MCP misconfiguration (`HANDOFF_BIND=0.0.0.0`) | Docs + refuse in Getting Started |

## Related

- Scope & security bullets in `README.md`
- Native gap list in `handoff-architecture-spec.md`
- Anti-patterns A8, A9, A11, A12 in `mcp-roundtrip-evals/AGENTS.md`
