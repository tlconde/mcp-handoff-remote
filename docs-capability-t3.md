Continue this conversation seamlessly from the handoff below (arriving from chat). Treat locked decisions as constraints. If a "handoff" MCP is available, you may also call pick_up. When your part is done, call the handoff MCP tool return_to_origin with a summary of the result so it lands back in chat.

# Work brief — T3 (Theo) docs full sweep — capability inventory for handoff

Continued from Chat — "T3 docs full sweep — capability inventory for handoff"

## Objective

Complete inventory of every shipped T3 capability — T3 Chat (the product), create-t3-app, the T3 OSS libraries (t3-env and siblings), and anything else shipped under the T3 / Theo umbrella — that touches cross-session / cross-surface / cross-device communication, MCP (local and remote/HTTP), session identity and naming, sync between web/desktop/mobile, shared and branched threads, notifications, scheduled work, connectors/BYOK, and anything resembling handoff / continuity / messaging.

T3 Chat's thread sharing, branching, and multi-device sync are the highest-value targets here — they are the closest external analogue to the handoff-poc envelope model.

## Task checklist

- [ ] Enumerate every page across the seed properties via their own indexes (docs nav, sitemaps, changelog archives, GitHub releases)
- [ ] Fetch every enumerated page and record status
- [ ] Dissect every relevant capability
- [ ] Produce the coverage manifest
- [ ] Return via return_to_origin

## Constraints

- "Coverage must be COMPLETE across the seed properties — partial sweeps are a failure. ALL of the websites: no gaps, no misses, no sampling."
- "PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted"
- "Use each property's own index (docs navigation, sitemaps, changelog archives, GitHub releases and CHANGELOG.md) to enumerate pages — never sample"
- "Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, CLI flags, endpoints, env vars, config file paths), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build"
- "DATE VALIDATION IS MANDATORY. Today is 2026-08-10. Record a published/last-updated date for EVERY page fetched (page byline, changelog entry date, sitemap lastmod, npm publish date, GitHub release/commit date, RSS pubDate — in that order of preference). Pages whose date cannot be established are listed separately as UNDATED and never assumed current."
- "Do not rely on model knowledge of what has shipped — the training cutoff is behind today. If a changelog or release feed's newest entry predates 2026-08-10, treat that as a signal you have not reached the head of the feed: go find the newer entries (RSS/Atom, GitHub releases API, npm versions, sitemap lastmod sort) before reporting. Record the newest entry date found per property in the manifest."
- "Flag every capability that shipped in the last 60 days — i.e. dated 2026-06-11 or later — separately, with its exact date. Recency is where our misses live."
- "T3 ships a lot of its documentation as video and social posts rather than docs pages. Where a capability is only documented that way, cite the primary artefact (video URL + timestamp, or post URL) and mark it LOW-FIDELITY SOURCE — do not silently promote it to a documented fact."
- "Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)"

## Return contract (what the origin expects back)
The coverage manifest (proof) + the dissection report, organized by: (1) capabilities that replace planned handoff-poc work, (2) capabilities to adopt under native-first, (3) sync / shared-thread / cross-device facts relevant to the t27 cross-device spike — T3 Chat's sync and thread-branching model in particular, (4) everything else relevant, (5) per-property page counts and gaps, (6) the LOW-FIDELITY SOURCE list. Return here via return_to_origin when complete.

## Files
### SEED-URLS.md
```text/markdown
# Seed list — crawl ALL of these, then expand via their own indexes/sitemaps

## T3 Chat
- https://t3.chat/ (every page: landing, pricing, features, login/account, settings docs if public)
- any t3.chat docs / help / FAQ / changelog path that exists (probe /docs, /help, /faq, /changelog, /blog, /support, and the sitemap.xml)
- https://t3.gg/ and https://t3.gg/blog (all posts)
- T3 Chat status/roadmap pages if published

## create-t3-app
- https://create.t3.gg/ — FULL docs tree (en/ index, installation, folder structure, all "usage" pages, deployment, FAQ, other-recommendations, T3 collection)
- https://create.t3.gg/en/deployment/* and /en/usage/* — every page
- https://github.com/t3-oss/create-t3-app — README, CHANGELOG.md, every GitHub release with its date
- npm registry pages for create-t3-app (publish dates as a date-validation cross-check)

## T3 OSS
- https://env.t3.gg/ — FULL docs tree
- https://github.com/t3-oss — EVERY public repo: README, docs/, CHANGELOG.md, releases
- https://github.com/t3dotgg — every public repo README (Theo's personal repos where T3 tooling ships)

## Announcements
- Theo's official announcement channels for shipped-feature confirmation ONLY (YouTube @t3dotgg video descriptions, official X/Twitter announcement posts). Cite the primary artefact and mark LOW-FIDELITY SOURCE.

Expand: every page's internal links within these properties count as in-scope. External links do not.
```

## Full context

> user: Full documentation sweep of ALL T3 properties — Theo's T3 Chat, create-t3-app, and the T3 OSS libraries. I want all of the websites — no gaps or misses are allowed. This exists because a reviewing session has already missed shipped capabilities twice in a neighbouring ecosystem; assume the same miss class here. The handoff protocol project (handoff-poc: cross-surface envelopes, store daemon, native-first rule) needs a COMPLETE inventory of every shipped capability that touches: cross-session/cross-surface/cross-device communication, MCP servers (local and remote/HTTP), session identity and naming, sync between web/desktop/mobile, shared and branched threads, notifications, scheduled work, connectors and BYOK, and anything resembling handoff/continuity/messaging. T3 Chat's sync and thread-sharing model is the closest external analogue to our envelope model — dissect it hardest. RUN THIS WITH A COST-EFFECTIVE MODEL and/or spawn cheap subagents for the crawl; the expensive thinking happens at review, not here.
> user: Coverage must be COMPLETE across the seed properties — partial sweeps are a failure
> user: PROOF REQUIRED: deliver a coverage manifest — every URL visited, fetch status, published/last-updated date (or UNDATED), one-line relevance verdict per page, and totals per property — so coverage is verifiable, not asserted
> user: Use each property's own index (llms.txt, sitemaps, collection pages) to enumerate pages — never sample
> user: Report is DISSECTION not summary: for each relevant capability — what it is, exact invocation (commands, endpoints, config), which handoff-poc component it affects (daemon, transport, identity, envelopes, notifications, cross-device t27), and whether it REPLACES something we planned to build
> user: Flag every capability that shipped in the last 60 days separately — recency is where our misses live
> user: Cheap model does the crawl and dissection; do not editorialize on architecture — deliver facts with citations (URL per claim)
> user: One key thing — everything needs to validate dates. Today is 10 August 2026. Date-stamp every page and every changelog entry, and confirm you reached the head of each feed, so the latest documents are not missed.
