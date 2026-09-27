# DBX Lite upstream backports — 27 September 2026

This batch retains Lite's existing build features, application identity, updater isolation, v2 pooled result cache, and 5-tab / 128 MiB inactive-result residency budget.

| Upstream commit | Adopted change |
| --- | --- |
| [f1c178595](https://github.com/t8y2/dbx/commit/f1c1785959bb0738cfc880970c67e31763b42a11) | Remove redundant result-row conversion before JS serialization. |
| [7a7edfb2b](https://github.com/t8y2/dbx/commit/7a7edfb2b8ac99c44a8c88ef8f9c4b6a7104d7fe) | Read complete MCP bridge requests, reject browser-shaped requests, restrict port-file permissions. |
| [42980e516](https://github.com/t8y2/dbx/commit/42980e5163b76c8bcb0d2826ddec9bbce2084d50) | Stream SQL table import instead of loading the whole file; remove its 100 MB cap. Includes the decoder's byte-progress prerequisites adapted to the old module layout. |
| [29cd60be4](https://github.com/t8y2/dbx/commit/29cd60be4faca2befd94ac6ff57a122b35e90219) | Flush SQL execution batches at 8 MiB of SQL text or 256 statements. One statement can exceed the byte threshold. |
| [88dccd7cd](https://github.com/t8y2/dbx/commit/88dccd7cded9080cae4f193ea384272582bd5632) | Stream JSON table import; remove its 100 MB cap. |
| [fac270fc8](https://github.com/t8y2/dbx/commit/fac270fc8a9117f7ad8fe348f5fe36b1b5fc0b08) — partial | Clean up open MySQL batch transactions and manual transactions on disconnect. Does not include grid-refresh changes or read-only snapshot rotation. |
| [2b075625f](https://github.com/t8y2/dbx/commit/2b075625f2cdbd25c7adcfb0809756600e1d3a4d) | Prevent a standalone BEGIN from pinning an autocommit tab's MySQL snapshot. Integration regression is adapted to hardcoded loopback, not upstream live-database environment variables. |

## Corrections found during backport review

- MCP: stop reading once the declared request is complete. Upstream could wait forever when headers and body arrived together. Reject incomplete, oversized, malformed or ambiguous Content-Length framing and unsupported Transfer-Encoding.
- MySQL: bound rollback cleanup and discard interrupted connections before issuing more SQL. Disconnect cleanup also bounds acquisition of the transaction mutex.
- SQL import: use a row queue to avoid repeatedly shifting the remaining rows of a large extended INSERT.

## Deliberately deferred

The upstream cache rewrite is not applied over Lite's pooled v2 cache. Credential encryption/migration, plugin framework changes, the broad crate reorganization, grid-refresh changes and manual read-only snapshot rotation remain separate work.

Streaming avoids materializing an entire file, but individual SQL statements and individual JSON values still need memory. No claim about a measured percentage reduction in total application RAM is made for this batch.

All database integration verification must use localhost or owned SQLite fixtures. Never use live or remote database profiles.

## Verification

- Frontend cache/query regressions: 39 files, 354 tests passed.
- Vue TypeScript check passed.
- Rust table import: 172 tests passed, including streaming SQL/JSON and owned SQLite fixtures.
- Rust SQL-file import: 41 tests passed.
- Native MCP bridge: 18 tests passed.
- Targeted query serialization, timeout classification, and cancelled MySQL batch regressions: 3 tests passed.
- MySQL integration: 1 regression passed against hardcoded 127.0.0.1:3306. Homebrew MySQL was initially stopped; it was started temporarily for this check. No remote database was contacted.
- Lite macOS debug bundle built successfully; the output copy passed ad-hoc code-signature verification.
- Independent source review completed, including a follow-up review of fixes.

The 589 passing tests above are selected regressions, not the entire repository test suite. The MCP small-request test was also demonstrated failing before the framing correction and passing afterward. This batch was built and tested; no interactive GUI session or new total-RAM benchmark was performed.
