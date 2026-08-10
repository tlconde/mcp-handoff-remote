Continue this conversation seamlessly from the handoff below (arriving from chat). Treat locked decisions as constraints. If a "handoff" MCP is available, you may also call pick_up. When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in chat.

# Work brief — OpenAI docs full sweep (Codex + ChatGPT for Work) — capability inventory for handoff

Continued from Chat — "OpenAI docs full sweep — capability inventory for handoff"

## Objective

Complete inventory of every shipped OpenAI capability that touches cross-session / cross-surface / cross-device communication, MCP (local and remote/HTTP), session identity and naming, sync, background/async agents, notifications, scheduled tasks, connectors, and anything resembling handoff / continuity / messaging — with Codex (CLI, IDE extension, cloud, web, GitHub integration) and ChatGPT for Work (Business/Enterprise/Edu admin, connectors, compliance) as the two focal surfaces.

## Task checklist

- [ ] Enumerate every page across the seed properties via their own indexes (llms.txt, sitemaps, collection pages, changelog archives)
- [ ] Fetch every enumerated page and record status
- [ ] Dissect every relevant capability
- [ ] Produce the coverage manifest
- [ ] Return via return_to_origin

## Constraints

- "Coverage must be COMPLETE across the seed properties — partial sweeps are a failure"
- "PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted"
- "Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample"
- "Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config keys, config file paths), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build"
- "DATE VALIDATION IS MANDATORY. Today is 2026-08-10. Record a published/last-updated date for EVERY page fetched (page byline, changelog entry date, sitemap lastmod, GitHub release date, RSS pubDate — in that order of preference). Pages whose date cannot be established are listed separately as UNDATED and never assumed current."
- "Do not rely on model knowledge of what has shipped — the training cutoff is behind today. If a changelog, release-notes index, or news feed's newest entry predates 2026-08-10, treat that as a signal you have not reached the head of the feed: go find the newer entries (RSS/Atom, GitHub releases API, sitemap lastmod sort, pagination) before reporting. Record the newest entry date found per property in the manifest."
- "Flag every capability that shipped in the last 60 days — i.e. dated 2026-06-11 or later — separately, with its exact date. Recency is where our misses live."
- "Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)"

## Return contract (what the origin expects back)
The coverage manifest (proof) + the dissection report, organized by: (1) capabilities that replace planned handoff-poc work, (2) capabilities to adopt under native-first, (3) remote/HTTP MCP facts relevant to the t27 cross-device spike (hosted MCP tool in the Responses API, MCP server registration, auth shapes), (4) everything else relevant, (5) per-property page counts and gaps. Return here via return_to_origin when complete.

## Files
### SEED-URLS.md
```text/markdown
# Seed list — crawl ALL of these, then expand via their own indexes/sitemaps

## Codex
- https://developers.openai.com/codex/ (and EVERY page under it — CLI, IDE extension, cloud, web, GitHub code review, sandbox, config, MCP, AGENTS.md)
- https://developers.openai.com/llms.txt (fetch every page listed)
- https://github.com/openai/codex (README, docs/ directory, config.md, releases/CHANGELOG — every release note)
- https://chatgpt.com/codex (product surface + any linked docs)
- https://help.openai.com/en/collections/ — every Codex collection and every article in it

## Platform / API
- https://platform.openai.com/docs (use its sitemap/llms.txt — include Responses API, Agents SDK, tools, MCP, background mode, webhooks, Realtime, Conversations, connectors/ChatKit)
- https://openai.github.io/openai-agents-python/ (full docs tree)
- https://openai.github.io/openai-agents-js/ (full docs tree)
- https://platform.openai.com/docs/changelog (every entry, 12 months minimum)

## ChatGPT for Work
- https://help.openai.com/en/ — EVERY collection and EVERY article (ChatGPT Business, Enterprise, Edu, admin, workspace, connectors, compliance API, data controls, projects, tasks, shared links, Atlas)
- https://openai.com/business/ and every linked product/solution page
- https://openai.com/chatgpt/enterprise/, /chatgpt/pricing/, /chatgpt/download/

## Announcements
- https://openai.com/news/ (all product announcements, latest 12 months minimum)
- https://openai.com/index/ (all posts in that period)

Expand: every page's internal links within these properties count as in-scope. External links do not.
```

## Full context

> user: Full documentation sweep of ALL OpenAI properties, focused on Codex and ChatGPT for Work. This exists because a reviewing session missed shipped capabilities twice before in a neighbouring ecosystem; the same miss class is assumed here. The handoff protocol project (handoff-poc: cross-surface envelopes, store daemon, native-first rule) needs a COMPLETE inventory of every shipped OpenAI capability that touches: cross-session/cross-surface/cross-device communication, MCP servers (local and remote/HTTP), session identity and naming, sync features, background and asynchronous agents, delegation between CLI and cloud, notifications, scheduled tasks, connectors, and anything resembling handoff/continuity/messaging. RUN THIS WITH A COST-EFFECTIVE MODEL and/or spawn cheap subagents for the crawl; the expensive thinking happens at review, not here.
> user: Coverage must be COMPLETE across the seed properties — partial sweeps are a failure
> user: PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted
> user: Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample
> user: Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build
> user: Flag every capability that shipped in the last 60 days separately — recency is where our misses live
> user: Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)
> user: One key thing — everything needs to validate dates. Today is 10 August 2026. Date-stamp every page and every changelog entry, and confirm you reached the head of each feed, so the latest documents are not missed.
