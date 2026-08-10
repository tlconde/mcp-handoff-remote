Continue this conversation seamlessly from the handoff below (arriving from chat). Treat locked decisions as constraints. If a "handoff" MCP is available, you may also call pick_up. When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in chat.

# Work brief — VS Code docs full sweep — capability inventory for handoff

Continued from Chat — "VS Code docs full sweep — capability inventory for handoff"

## Objective

Complete inventory of every shipped Visual Studio Code capability that touches cross-session / cross-surface / cross-device communication, MCP (local and remote/HTTP), session identity and naming, Settings Sync and profiles, Remote Development / Dev Containers / Tunnels / vscode.dev, extension APIs relevant to transport and notifications, tasks and scheduling, URI handlers and deep links, and anything resembling handoff / continuity / messaging.

Copilot-specific surfaces are OUT of scope here — they belong to the Copilot sweep. Note the boundary rather than crossing it.

## Task checklist

- [ ] Enumerate every page across the seed properties via their own indexes (docs TOC, sitemap, release-notes archive, API reference index)
- [ ] Fetch every enumerated page and record status
- [ ] Dissect every relevant capability
- [ ] Produce the coverage manifest
- [ ] Return via return_to_origin

## Constraints

- "Coverage must be COMPLETE across the seed properties — partial sweeps are a failure"
- "PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted"
- "Use each property's own index (docs TOC, sitemap, release-notes archive) to enumerate pages — never sample"
- "Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, command-palette IDs, CLI flags, settings keys, API namespaces, config file paths), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build"
- "DATE VALIDATION IS MANDATORY. Today is 2026-08-10. Record a published/last-updated date for EVERY page fetched (page byline, release-note month, sitemap lastmod, GitHub release date, RSS pubDate — in that order of preference). Pages whose date cannot be established are listed separately as UNDATED and never assumed current."
- "Do not rely on model knowledge of what has shipped — the training cutoff is behind today. If the release-notes index's newest entry predates 2026-08-10, treat that as a signal you have not reached the head of the feed: go find the newer entries (RSS/Atom, GitHub releases and iteration-plan milestones, sitemap lastmod sort) before reporting. Record the newest entry date found per property in the manifest."
- "Flag every capability that shipped in the last 60 days — i.e. dated 2026-06-11 or later — separately, with its exact date. Recency is where our misses live. Cover every monthly release note touching that window in full."
- "Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)"

## Return contract (what the origin expects back)
The coverage manifest (proof) + the dissection report, organized by: (1) capabilities that replace planned handoff-poc work, (2) capabilities to adopt under native-first, (3) remote/HTTP MCP facts and remote-tunnel/vscode.dev facts relevant to the t27 cross-device spike, (4) everything else relevant, (5) per-property page counts and gaps. Return here via return_to_origin when complete.

## Files
### SEED-URLS.md
```text/markdown
# Seed list — crawl ALL of these, then expand via their own indexes/sitemaps

- https://code.visualstudio.com/docs (FULL docs tree via the TOC and https://code.visualstudio.com/sitemap.xml — every page)
- https://code.visualstudio.com/api (FULL extension API tree: extension guides, references/vscode-api, contribution points, activation events, URI handlers, authentication providers, MCP extension APIs, language model API)
- https://code.visualstudio.com/updates/ — EVERY monthly release note, 12 months minimum, each read in full
- https://code.visualstudio.com/docs/configure/settings-sync and profiles docs
- https://code.visualstudio.com/docs/remote/ (Remote Development, SSH, Containers, WSL, Tunnels, Remote Server) — every page
- https://code.visualstudio.com/docs/editor/vscode-web and vscode.dev / github.dev docs
- https://code.visualstudio.com/docs/editor/command-line (CLI reference, `code` and `code tunnel`)
- https://code.visualstudio.com/blog/ (all posts, 12 months minimum)
- https://github.com/microsoft/vscode — release milestones/iteration plans, wiki pages documenting shipped features, and the CHANGELOG-equivalent endgame notes
- https://github.com/microsoft/vscode-docs (source of truth for pages missing from the site nav)

Expand: every page's internal links within these properties count as in-scope. External links do not.
```

## Full context

> user: Full documentation sweep of ALL VS Code properties. I want all of the websites — no gaps or misses are allowed. This exists because a reviewing session has already missed shipped capabilities twice in a neighbouring ecosystem; assume the same miss class here. The handoff protocol project (handoff-poc: cross-surface envelopes, store daemon, native-first rule) needs a COMPLETE inventory of every shipped capability that touches: cross-session/cross-surface/cross-device communication, MCP servers (local and remote/HTTP), session identity and naming, Settings Sync and profiles, remote development and tunnels, URI handlers and deep links, extension APIs for notifications and transport, tasks and scheduling, and anything resembling handoff/continuity/messaging. Copilot surfaces belong to a separate sweep — mark the boundary, do not cross it. RUN THIS WITH A COST-EFFECTIVE MODEL and/or spawn cheap subagents for the crawl; the expensive thinking happens at review, not here.
> user: Coverage must be COMPLETE across the seed properties — partial sweeps are a failure
> user: PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted
> user: Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample
> user: Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build
> user: Flag every capability that shipped in the last 60 days separately — recency is where our misses live
> user: Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)
> user: One key thing — everything needs to validate dates. Today is 10 August 2026. Date-stamp every page and every changelog entry, and confirm you reached the head of each feed, so the latest documents are not missed.
