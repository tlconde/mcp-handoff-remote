Continue this conversation seamlessly from the handoff below (arriving from chat). Treat locked decisions as constraints. If a "handoff" MCP is available, you may also call pick_up. When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in chat.

# Work brief — Copilot + GitHub Copilot docs full sweep — capability inventory for handoff

Continued from Chat — "Copilot docs full sweep — capability inventory for handoff"

## Objective

Complete inventory of every shipped Copilot capability — GitHub Copilot (chat, agent mode, coding agent, CLI, code review, Spaces, extensions, Copilot API) AND Microsoft Copilot (365, Studio, agents, connectors) — that touches cross-session / cross-surface / cross-device communication, MCP (local and remote/HTTP), session identity and naming, delegation between IDE and cloud, sync, notifications, scheduled/background work, connectors, and anything resembling handoff / continuity / messaging.

## Task checklist

- [ ] Enumerate every page across BOTH property sets via their own indexes (docs TOC, sitemaps, changelog archives, Learn TOC JSON)
- [ ] Fetch every enumerated page and record status
- [ ] Dissect every relevant capability
- [ ] Produce the coverage manifest, split per property
- [ ] Return via return_to_origin

## Constraints

- "Coverage must be COMPLETE across the seed properties — partial sweeps are a failure. ALL of the websites: no gaps, no misses, no sampling."
- "PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted"
- "Use each property's own index (docs TOC, sitemaps, changelog archives, Learn TOC) to enumerate pages — never sample"
- "Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, slash commands, CLI flags, endpoints, settings keys, config file paths such as mcp.json / copilot-instructions.md / AGENTS.md), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build"
- "DATE VALIDATION IS MANDATORY. Today is 2026-08-10. Record a published/last-updated date for EVERY page fetched (page byline, changelog entry date, Learn 'last updated' stamp, sitemap lastmod, GitHub release date, RSS pubDate — in that order of preference). Pages whose date cannot be established are listed separately as UNDATED and never assumed current."
- "Do not rely on model knowledge of what has shipped — the training cutoff is behind today. If the GitHub Changelog, Learn 'What's new', or a release feed's newest entry predates 2026-08-10, treat that as a signal you have not reached the head of the feed: go find the newer entries (RSS/Atom, GitHub releases API, changelog pagination, sitemap lastmod sort) before reporting. Record the newest entry date found per property in the manifest."
- "Flag every capability that shipped in the last 60 days — i.e. dated 2026-06-11 or later — separately, with its exact date. Recency is where our misses live."
- "Keep GitHub Copilot and Microsoft Copilot findings attributable — never merge a claim across the two without saying which property it came from. Where a capability is really a VS Code feature surfaced through Copilot, say so; the VS Code sweep covers the host."
- "Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)"

## Return contract (what the origin expects back)
The coverage manifest (proof, per property) + the dissection report, organized by: (1) capabilities that replace planned handoff-poc work, (2) capabilities to adopt under native-first, (3) remote/HTTP MCP facts relevant to the t27 cross-device spike (GitHub's remote MCP server, MCP registry, OAuth/PAT auth shapes), (4) everything else relevant, (5) per-property page counts and gaps. Return here via return_to_origin when complete.

## Files
### SEED-URLS.md
```text/markdown
# Seed list — crawl ALL of these, then expand via their own indexes/sitemaps

## GitHub Copilot
- https://docs.github.com/en/copilot — FULL tree via the docs TOC and https://docs.github.com/sitemap.xml (chat, agent mode, coding agent, code review, CLI, Spaces, custom instructions, prompt files, MCP, extensions, knowledge bases, policies/enterprise admin, billing, API)
- https://docs.github.com/en/copilot/reference and /concepts and /how-tos — every page
- https://github.blog/changelog/ — EVERY Copilot-labelled entry, 12 months minimum, each with its date
- https://github.blog/ai-and-ml/github-copilot/ — all posts
- https://github.com/features/copilot and all linked plan/pricing/enterprise pages
- https://githubnext.com/ — every project page (early surfaces often ship later)
- https://github.com/github/gh-copilot, https://github.com/github/github-mcp-server, https://github.com/copilot-extensions — READMEs, docs/, releases
- https://docs.github.com/en/copilot/building-copilot-extensions — every page

## VS Code Copilot surface (boundary-marked, not skipped)
- https://code.visualstudio.com/docs/copilot/ — every page
- https://code.visualstudio.com/updates/ — Copilot sections of every monthly release note, 12 months minimum

## Microsoft Copilot
- https://learn.microsoft.com/en-us/copilot/ — FULL TOC
- https://learn.microsoft.com/en-us/microsoft-365-copilot/ — FULL TOC (extensibility, connectors, agents, Graph connectors, admin)
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/ — FULL TOC
- https://learn.microsoft.com/en-us/copilot/microsoft-365/release-notes and every 'What's new' page in the above trees
- https://www.microsoft.com/en-us/microsoft-copilot/blog/ — all posts, 12 months minimum

Expand: every page's internal links within these properties count as in-scope. External links do not.
```

## Full context

> user: Full documentation sweep of ALL Copilot properties — GitHub Copilot and Microsoft Copilot both. I want all of the websites — no gaps or misses are allowed. This exists because a reviewing session has already missed shipped capabilities twice in a neighbouring ecosystem; assume the same miss class here. The handoff protocol project (handoff-poc: cross-surface envelopes, store daemon, native-first rule) needs a COMPLETE inventory of every shipped capability that touches: cross-session/cross-surface/cross-device communication, MCP servers (local and remote/HTTP), session identity and naming, delegation between IDE and cloud coding agents, sync features, notifications, scheduled and background work, connectors, and anything resembling handoff/continuity/messaging. RUN THIS WITH A COST-EFFECTIVE MODEL and/or spawn cheap subagents for the crawl; the expensive thinking happens at review, not here.
> user: Coverage must be COMPLETE across the seed properties — partial sweeps are a failure
> user: PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted
> user: Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample
> user: Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build
> user: Flag every capability that shipped in the last 60 days separately — recency is where our misses live
> user: Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)
> user: One key thing — everything needs to validate dates. Today is 10 August 2026. Date-stamp every page and every changelog entry, and confirm you reached the head of each feed, so the latest documents are not missed.
