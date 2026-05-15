# Diff Notes Bulk Clear

## Problem

Users can add many AI notes from diff views, including combined diffs opened by `View all`, but cleanup is one note at a time. The only delete controls today are per-note trash buttons in the inline Monaco card and sidebar note list: [DiffCommentCard.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/diff-comments/DiffCommentCard.tsx:144), [SourceControl.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/right-sidebar/SourceControl.tsx:2815). The Source Control Notes shelf already treats notes as a batch for send/copy, but not for cleanup: [SourceControl.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/right-sidebar/SourceControl.tsx:1792).

## Goal

Make AI note cleanup feel like a batch workflow:

1. Clear all notes for the active worktree from the Source Control Notes header.
2. Clear all notes for a single file from the expanded Notes list.
3. Persist each bulk clear as one worktree metadata write, with the same optimistic rollback guarantees as single-note delete.
4. Keep per-note delete, edit, send, copy, and scroll-to-note behavior unchanged.

Conductor reference: its visible changes/chat layout keeps batch-oriented actions in the persistent side panel, not inside each individual message. That supports placing cleanup beside Orca's existing Notes batch send/copy controls. VS Code reference: comments have a dedicated Comments view grouped by file and line, with thread/file-level action menus rather than forcing every action through inline editor widgets.

## Non-goals

- Do not auto-clear notes after sending to an agent. The user may want to verify the prompt or resend it.
- Do not add note archive/history or undo persistence.
- Do not migrate the persisted `diffComments` shape in `WorktreeMeta`.
- Do not add bulk clear to GitHub-hosted PR review comments; this feature is only for local worktree AI notes persisted in worktree metadata.

## Design

1. Add bulk mutation APIs to the diff comments store.
   - Extend `DiffCommentsSlice` with:
     - `clearDiffComments(worktreeId): Promise<boolean>`
     - `clearDiffCommentsForFile(worktreeId, filePath): Promise<boolean>`
   - Implement both via existing `mutateComments`, `enqueuePersist`, and `rollback` in [diffComments.ts](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/store/slices/diffComments.ts:95).
   - `clearDiffComments` changes the list to `[]`.
   - `clearDiffCommentsForFile` filters out exact `filePath` matches and no-ops if none match.
   - Return semantics:
     - `true`: mutation persisted (or no-op because nothing matched).
     - `false`: persist failed and rollback ran.
   - Both operations must trigger exactly one `enqueuePersist` attempt, not N calls to `deleteDiffComment`.

2. Add a guarded destructive confirmation in `SourceControl`.
   - Keep the existing Notes header layout and add a compact `MoreHorizontal` menu after Send and Copy.
   - Menu items:
     - `Clear all notes...` with `Trash2`, destructive styling, enabled only when note count > 0.
   - Open a `Dialog` with title `Clear Notes`, body `Clear N notes from this worktree?`, and buttons `Cancel` + destructive `Clear Notes`.
   - On confirm, call `clearDiffComments(activeWorktreeId)` and `await` it.
   - If `activeWorktreeId` changes (or becomes null) while the dialog is open, close the dialog and clear pending state; never execute against a stale worktree.
   - While pending, disable confirm and cancel to avoid duplicate submits/racey dialog closure.
   - If the call returns `false`, keep the dialog open and show `toast.error('Failed to clear notes.')`.
   - If it returns `true`, close the dialog.

3. Add per-file bulk cleanup in the expanded Notes list.
   - In `DiffCommentsInlineList`, compute grouped counts as it already does.
   - Add a hover/focus-visible trash button on each file group header with title/aria label `Clear notes for <filePath>`.
   - The button opens the same confirmation dialog, scoped to file: `Clear M notes from <filePath>?`.
   - On confirm, call `clearDiffCommentsForFile(activeWorktreeId, filePath)` and follow the same pending/success/failure handling as clear-all.
   - If the grouped file no longer exists by confirm time, treat as no-op success and close.
   - Keep note row click/copy/delete behavior as siblings, preserving the current no-nested-interactive-elements pattern: [SourceControl.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/right-sidebar/SourceControl.tsx:2795).

4. Make cleanup visible but not loud.
   - Do not put a red trash icon directly in the primary Notes header row. The common actions remain expand, send, copy; destructive cleanup sits in a menu.
   - File-group clear can be a subtle hover/focus icon because it acts on a narrower, visibly grouped set.
   - Use existing UI primitives and tokens from [STYLEGUIDE.md](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/docs/STYLEGUIDE.md:1): `Button`, `DropdownMenu`, `Dialog`, `destructive`, `muted`, `accent`, `border`.

5. Keep diff views consistent automatically.
   - Diff cards and file badges already subscribe to the worktree `diffComments` array: [DiffViewer.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/editor/DiffViewer.tsx:66), [DiffSectionItem.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/editor/DiffSectionItem.tsx:83).
   - Clearing comments should remove inline Monaco zones through the existing diff-based zone cleanup: [useDiffCommentDecorator.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx:416).
   - If the pending scroll target is cleared, the decorator already drops stale requests when zones disappear: [useDiffCommentDecorator.tsx](/Users/jinjingliang/Documents/projects/orca/improve-sending-notes-to-ai/src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx:425).
   - Do not introduce any extra `scrollToDiffCommentId` reset in `SourceControl`; decorator ownership avoids cross-viewer races.

## Edge cases

- No active worktree or note count becomes zero while the dialog is open: close the dialog or disable confirm without calling the store.
- Persist failure: rollback to the previous note array and show an error toast.
- Concurrent add/edit/delete while a clear is in flight: use the existing identity-guard rollback so a failed clear does not erase later successful mutations.
- Concurrent clears from two surfaces (e.g. sidebar + inline card delete, or two windows): the second clear should be treated as a no-op success if target notes are already gone.
- Active worktree switch while confirm dialog is open: auto-close dialog and drop pending action; do not remap the pending clear onto the newly active worktree.
- Remote runtime active: bulk clear must use `worktree.set` through the existing persist queue, same as single delete.
- File path no longer appears in the diff: file-scoped clear still works from the Notes list because notes are grouped by persisted `filePath`.
- Expanded Notes shelf becomes empty after clear: the whole shelf should disappear, matching the existing hidden-empty design.
- Keyboard access: menu trigger, confirmation buttons, and file-group clear buttons must be focusable and have explicit aria labels.
- External metadata refresh (another window/process) landing mid-flight: rely on rollback identity guard; never overwrite a newer array identity during failure recovery.
- Cross-window/process success races: with current `worktree.set` / `updateMeta` semantics there is no revision/CAS guard, so simultaneous successful writers are last-write-wins. This feature should preserve existing behavior (no extra regression), not claim strict multi-writer linearizability.

## Rollout

1. Add store methods and unit tests for:
   - all-notes clear success
   - file-scoped clear success
   - no-op success when nothing matches
   - remote runtime persistence path
   - rollback on persist failure
   - no rollback clobber when a later mutation already replaced the array identity
2. Wire `SourceControl` to the new store methods and add the Notes header `More` menu plus confirmation state.
3. Extend `DiffCommentsInlineList` props to support file-scoped clear and add the file-group affordance.
4. Run focused tests for `diffComments` and TypeScript/lint.
5. Validate in Electron with existing notes: clear file-scoped notes, clear all notes, cancel confirmation, and verify inline diff cards/sidebar badges disappear.
