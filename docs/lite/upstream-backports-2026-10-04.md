# DBX Lite upstream backports — 4 October 2026

This batch retains Lite's existing build features, application identity, updater isolation, pooled result cache and inactive-result residency budget. Only query, result-grid and editor fixes the user asked for were taken.

| Upstream commit | Adopted change |
| --- | --- |
| [81850df0d](https://github.com/t8y2/dbx/commit/81850df0d) | Bound the editability metadata preflight to 1 s for every database (previously Oracle/Xugu only), so slow column/index metadata no longer delays showing a result. The unrelated Dameng test that conflicted in the same spec file was not taken. |
| [86467b73c](https://github.com/t8y2/dbx/commit/86467b73c) | Invalidate the manual total row count (and reject a pending COUNT) on refresh, rollback and query-context change. Lite keeps its own `infiniteScrollAllLoaded` reset in the same watcher. Upstream's issue screenshots and Load All source assertions were not taken. |
| [ef1674933](https://github.com/t8y2/dbx/commit/ef1674933) — partial | Scroll jank with a long selection: cache whole-line selection rectangles in the trimmed selection layer, and keep CodeMirror gutters attached during viewport sync. Not taken: the native-selection scroll park (`queryEditorNativeSelection.ts`, `useQueryEditorPointer.ts`), which belongs to a module Lite does not have. |

## Not applicable to Lite

- [1a3c1f527](https://github.com/t8y2/dbx/commit/1a3c1f527) (Load All keeps chunking past the per-request cap): the Load All feature (upstream `35d624764`, 24 September) is not in Lite.
- [ba3e93442](https://github.com/t8y2/dbx/commit/ba3e93442) (guard long native selections on macOS): it patches `queryEditorNativeSelection.ts`, added upstream on 28 September. Lite has its own `createQueryEditorNativeSelectionGuard`; the upstream change does not map onto it.

## Verification

- `pnpm vitest run apps/desktop/src/stores/__tests__/queryStore.hiddenPrimaryKey.spec.ts`: 56 passed, including the new preflight-budget test.
- `pnpm vitest run apps/desktop/src/components/grid/__tests__/DataGridTotalRowCountRefresh.spec.ts`: 5 passed (new spec).
- `pnpm vitest run apps/desktop/src/lib/editor`: 6 files, 97 passed, including the new `codemirrorGutterSync.spec.ts`.
- `pnpm typecheck`: exit 0.
- `pnpm test`: 14196 passed, 1 failed in `DocumentBrowserFieldSearch.spec.ts`. That spec passes when run alone on this branch and fails on a different case when run alone on `main`, so the failure is an existing flaky test, not this batch.

Not run: Rust tests (no Rust change), the desktop application, and any database. The editor and grid changes have no manual check in the running app yet. No memory or frame-time measurement was made in Lite; upstream's frame-time figures are theirs.
