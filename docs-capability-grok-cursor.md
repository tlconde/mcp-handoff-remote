Continue this conversation seamlessly from the handoff below (arriving from chat). Treat locked decisions as constraints. If a "handoff" MCP is available, you may also call pick_up. When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in chat.

# Work brief — Grok (xAI) + Cursor docs full sweep — capability inventory for handoff

Continued from Chat — "Grok + Cursor docs full sweep — capability inventory for handoff"

## Objective

Complete inventory of every shipped xAI/Grok and Cursor capability that touches cross-session / cross-surface / cross-device communication, MCP (local and remote/HTTP), session identity and naming, sync, background agents, notifications, scheduled tasks, connectors, and anything resembling handoff / continuity / messaging. Two properties, one report — but per-property manifests kept separate.

## Task checklist

- [ ] Enumerate every page across BOTH property sets via their own indexes (llms.txt, sitemaps, changelog archives, forum category indexes)
- [ ] Fetch every enumerated page and record status
- [ ] Dissect every relevant capability
- [ ] Produce the coverage manifest, split per property
- [ ] Return via return_to_origin

## Constraints

- "Coverage must be COMPLETE across the seed properties — partial sweeps are a failure. ALL of the websites: no gaps, no misses, no sampling."
- "PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted"
- "Use each property's own index (llms.txt, sitemaps, collection pages, changelog archives) to enumerate pages — never sample"
- "Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config keys, config file paths), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build"
- "DATE VALIDATION IS MANDATORY. Today is 2026-08-10. Record a published/last-updated date for EVERY page fetched (page byline, changelog entry date, sitemap lastmod, GitHub release date, RSS pubDate — in that order of preference). Pages whose date cannot be established are listed separately as UNDATED and never assumed current."
- "Do not rely on model knowledge of what has shipped — the training cutoff is behind today. If a changelog, release-notes index, or news feed's newest entry predates 2026-08-10, treat that as a signal you have not reached the head of the feed: go find the newer entries (RSS/Atom, GitHub releases API, sitemap lastmod sort, pagination) before reporting. Record the newest entry date found per property in the manifest."
- "Flag every capability that shipped in the last 60 days — i.e. dated 2026-06-11 or later — separately, with its exact date. Recency is where our misses live."
- "Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)"
- "Keep Grok and Cursor findings attributable — never merge a claim across the two without saying which property it came from"

## Return contract (what the origin expects back)
The coverage manifest (proof, per property) + the dissection report, organized by: (1) capabilities that replace planned handoff-poc work, (2) capabilities to adopt under native-first, (3) remote/HTTP MCP facts relevant to the t27 cross-device spike, (4) everything else relevant, (5) per-property page counts and gaps. Return here via return_to_origin when complete.

## Files
### SEED-URLS.md
```text/markdown
# Seed list — crawl ALL of these, then expand via their own indexes/sitemaps

## xAI / Grok
- https://docs.x.ai/ (full docs tree — use its sitemap/llms.txt; include API reference, agent tooling, MCP, server-side tools, Live Search, Agent Tools API, responses/chat APIs)
- https://docs.x.ai/docs/changelog (every entry)
- https://x.ai/api
- https://x.ai/news (all posts, 12 months minimum) and https://x.ai/blog
- https://x.ai/grok, https://grok.com (product surfaces: Projects, Tasks, Workspaces, Voice, Agents, Grok Code / Grok CLI if present)
- https://github.com/xai-org (every public repo README + docs, notably any CLI / SDK / MCP repos)
- https://help.x.com/en/using-x/about-grok and every Grok article on help.x.com

## Cursor
- https://cursor.com/docs (full docs tree — use https://cursor.com/docs/llms.txt / llms-full.txt and the sitemap; include Agent, Background Agents, Composer, Rules, AGENTS.md, MCP, Hooks, CLI, Slack/GitHub/Linear integrations, Team/Enterprise admin, API)
- https://cursor.com/changelog (EVERY release entry, 12 months minimum)
- https://cursor.com/blog (all posts)
- https://cursor.com/ product/pricing/enterprise/security pages
- https://forum.cursor.com (official announcements category only — for shipped-feature confirmation)
- https://github.com/cursor (public repos, CLI docs, releases)

Expand: every page's internal links within these properties count as in-scope. External links do not.
```

## Full context

> user: Full documentation sweep of ALL Grok/xAI and ALL Cursor properties. I want all of the websites — no gaps or misses are allowed. This exists because a reviewing session has already missed shipped capabilities twice in a neighbouring ecosystem; assume the same miss class here. The handoff protocol project (handoff-poc: cross-surface envelopes, store daemon, native-first rule) needs a COMPLETE inventory of every shipped capability that touches: cross-session/cross-surface/cross-device communication, MCP servers (local and remote/HTTP), session identity and naming, sync features, background/cloud agents and delegation between local and remote, notifications, scheduled tasks, connectors, and anything resembling handoff/continuity/messaging. RUN THIS WITH A COST-EFFECTIVE MODEL and/or spawn cheap subagents for the crawl; the expensive thinking happens at review, not here.
> user: Coverage must be COMPLETE across the seed properties — partial sweeps are a failure
> user: PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted
> user: Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample
> user: Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build
> user: Flag every capability that shipped in the last 60 days separately — recency is where our misses live
> user: Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)
> user: One key thing — everything needs to validate dates. Today is 10 August 2026. Date-stamp every page and every changelog entry, and confirm you reached the head of each feed, so the latest documents are not missed.
