# Validation — 2026-10-10

## Passed

- Node.js 24.x, `npm test`: **21/21 tests passed** after Vietnamese translation support.
- Timezone UTC+7, due-time check, same-day dedup and startup catch-up logic.
- SQLite persistent storage, canonical URL dedup, original day and read state retained.
- Repeated pipeline runs: 18 articles retained, at most 10 automatic summaries; selected articles receive a separate translation task. Summary and translation caches do not add stories to the automatic limit.
- Vietnamese translation schema, technical keyword/URL/code/number preservation, source and prompt-version cache invalidation, independent retry, existing-database migration, shared daily budget, and task-level cost attribution tested with mocks.
- Cost calculation: cached tokens not counted twice, invalid AI output usage still recorded, timeout cost marked unknown, budget blocks before network call.
- RSS/Atom parsing and CDATA with HTML doctype; unsafe external DTD rejected.
- HTTP Host/Origin protection, read/bookmark mutation, nonpublic settings path.
- Settings redaction and local settings permissions 0600.
- Source connectors tested against live GitHub Copilot RSS, Microsoft RSS, Hugging Face Papers, GitHub Search. Copilot-specific RSS parser issue found and fixed during validation.
- Browser checks via headless Chromium: article detail, manual read/unread, bookmark, cost dialog, saving settings and reload. No browser page errors. At 390px viewport, no horizontal overflow.
- Actual screenshots included in `docs/interface.png` and `docs/ai-cost-dialog.png`. They show separate demo data, not a live GPT run.
- Shell syntax checked for start/service scripts.

## Not verified live

- No paid OpenAI call: no user API key supplied. Responses API contract, usage and errors tested with mocks.
- daily.dev private RSS: requires the user's own URL.
- systemd activation/reboot/linger on the user's Ubuntu machine. Service installer included; must be run there.

## Runtime limits

- All fetched items retained; configured sources cap retrieval to 6 items each per run (up to 30). No historical backfill of uncollected days.
- Exact URL dedup only, not semantic clustering or repository version tracking.
- SQLite has no auto-delete policy. Users manage disk space and backups.
