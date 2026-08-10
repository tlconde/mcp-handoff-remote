Continue this conversation seamlessly from the handoff below (arriving from chat). Treat locked decisions as constraints. If a "handoff" MCP is available, you may also call pick_up. When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in chat.

# Work brief — Anthropic docs full sweep — capability inventory for handoff

Continued from Chat — "Anthropic docs full sweep — capability inventory for handoff" (2026-08-08T19:24:50.712Z)

## Objective

Full context attached — 8 messages travel whole (2049 chars, under compaction threshold).

## Task checklist

- [ ] Derive tasks from context

## Constraints

- "Coverage must be COMPLETE across the seed properties — partial sweeps are a failure"
- "PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted"
- "Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample"
- "Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelo"
- "Flag every capability that shipped in the last 60 days separately — recency is where our misses live"
- "Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)"

## Return contract (what the origin expects back)
The coverage manifest (proof) + the dissection report, organized by: (1) capabilities that replace planned handoff-poc work, (2) capabilities to adopt under native-first, (3) remote/HTTP MCP facts relevant to the t27 cross-device spike (especially api.anthropic.com/v1/design/mcp as precedent), (4) everything else relevant, (5) per-property page counts and gaps. Return here via return_to_origin when complete.

## Files
### SEED-URLS.md
```text/markdown
# Seed list — crawl ALL of these, then expand via their own indexes/sitemaps

- https://support.claude.com/en/collections/4078531-claude (and EVERY article in every collection on support.claude.com — Claude.ai, Claude Code, Cowork, Desktop, mobile, billing, connectors, Design)
- https://code.claude.com/docs/llms.txt (the full Claude Code docs index — fetch every page listed)
- https://docs.claude.com (platform + API docs — use its llms.txt / sitemap; include agent SDK, MCP, tool use, connectors)
- https://www.anthropic.com/news (all product announcements, latest 12 months minimum)
- https://www.anthropic.com/engineering (all posts)
- https://claude.com product pages (Claude Code, Cowork, Desktop, Design, Dispatch, pricing/plans)
- https://support.claude.com/en/articles/14604416-get-started-with-claude-design (start here — the article that triggered this sweep)
- https://modelcontextprotocol.io/docs (spec + transports — remote MCP shapes)

Expand: every page's internal links within these properties count as in-scope. External links do not.
```

## Full context

> user: Full documentation sweep of ALL Anthropic properties, ordered by Taissa after two misses: Claude Code cross-session messaging (shipped Aug 7) and the Claude Design MCP server (claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp, /design-sync, /design-login, Design↔Code handoff) were both missed by the reviewing session. The handoff protocol project (handoff-poc: cross-surface envelopes, store daemon, native-first rule) needs a COMPLETE inventory of every shipped Anthropic capability that touches: cross-session/cross-surface/cross-device communication, MCP servers (local and remote/HTTP), session identity and naming, sync features (design-sync, ProjectSync, project knowledge), Dispatch, Remote Control, channels, hooks, agent teams, agent view, subagents, notifications, scheduled tasks, connectors, and anything resembling handoff/continuity/messaging. RUN THIS WITH A COST-EFFECTIVE MODEL (Haiku-class) and/or spawn cheap subagents for the crawl; the expensive thinking happens at review, not here.
> user: Coverage must be COMPLETE across the seed properties — partial sweeps are a failure
> user: PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted
> user: Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample
> user: Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build
> user: Flag every capability that shipped in the last 60 days separately — recency is where our misses live
> user: Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)