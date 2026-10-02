# Ticket #98 F7: durable unread indicators

The retained product prototype defines unread indicators on the categorized conversation cards, shared by the phone list and desktop scope list. They are **red numeric counters**, despite the CSS name `unread-badge-dot`: see `web/src/prototype/views/chat-view.ts`, `web/src/prototype/prototype.css` at `.unread-badge-dot`, `web/src/prototype/chat.dom.test.ts`, `web/src/prototype/project.dom.test.ts`, and `docs/prototype-project-multiview.md` (Communication Scopes). Disbanded Working groups and ended Direct Message memberships suppress counters. Active selection has separate styling.

The prototype's counts are fixture constants. It specifies neither increment/clear transitions nor durable read markers. Its sidebar Chat entry has no unread badge, and its Feed activity/cards have no unread badge; the Feed navigation badge represents Human Attention. The owner expects Chat navigation and Feed indicators too. This implementation adds those surfaces using the prototype's counter form and reports the extension for owner adjudication. It leaves Attention counts separate from unread.

## Behavior

- Each Project conversation scope has a durable read cursor for its Project's Human member. New messages by another author increase unread; the Human's own messages do not. Project events retain their separate activity/Attention semantics and do not increment message unread.
- Opening a visible conversation advances its cursor through the message identities actually loaded. It does not acknowledge concurrently arriving, unloaded messages. An old receipt cannot move the cursor backwards. A phone list, a hidden page, an unavailable conversation, or another scope never acknowledges that scope's messages.
- On desktop, the visible default conversation is read even without a detail URL. On phone, the unopened default conversation remains unread until its detail is visible.
- Reload obtains counts from the server. No initial-history baseline, browser storage, or client-only `seen` set clears unread. A failed receipt does not clear badges optimistically.
- Zero counts render no badge. Failed or invalid summaries render no guessed numbers; Feed reports unread counts unavailable. Archived/history views remain inspectable. Disbanded groups and ended memberships suppress counters, following the prototype.
- The sidebar Chat counter aggregates the selected Project when the URL names one, otherwise all visible conversations. Phone Chat navigation uses the same aggregate. Feed displays count-only conversation links before Chat opens, and message/activity targets display the owning scope's count. Chat cards display per-scope counts. Legacy ProjectView's fixture unread numbers are removed.

## Durable and privacy boundary

Schema v28 adds `collaboration_read_markers(scope_id, human_id, message_id)` through the established v27→v28 migration runner. Counts are computed by the collaboration store against its append-only message insertion order, independent of message timestamps. Equal timestamps, duplicate delivery and delayed receipts cannot erase a later message. The marker stores a stable Message identity, and resolves its current insertion order when counting or advancing. It contains no message body. The stable identity also avoids tying the persisted cursor to physical SQLite row numbers across a safety-copy restore.

The authenticated operator-only routes are `GET /api/chat/unread` and `POST /api/scopes/:id/read`. Receipts require the existing CSRF boundary and resolve the actor from Project Human authority; client actor fields have no authority. All observed message identities are validated against the scope before any mutation. Agent-to-Agent private Direct Messages are excluded. Responses carry only scope identity, Project identity, and integer counts, never Message content, transcripts, prompts, or run details.

The app shares one count snapshot across surfaces, refreshes while visible at a bounded fifteen-second cadence, and invalidates summaries started before a receipt. Chat's existing scoped arrival reads and announcements remain intact. Server computation makes persistence and own-author exclusion consistent across reloads and browser instances; clients only render the resulting counts.

## Regression risks and evidence shape

| Risk | Verification |
| --- | --- |
| Reload erases unread/read state | SQLite close/reopen tests; authenticated API with a reopened store; app remount at each surface |
| Reading one scope clears another or unseen arrivals | Memory/SQLite cursor tests, mixed-scope receipt rejection, DOM scope switching |
| Hidden or phone list acknowledges unseen content | Phone list/hidden detail DOM test |
| A stale summary or failed receipt lies about read state | Shared unread-state tests |
| Badge exposes prose or private conversation existence | Exact count-only API shape and private DM exclusion; count-only badge assertions |
| Schema migration changes other durable state | Migration, schema snapshots, rollback, safety and diagnostics suites |

The prior Work record's Cumora conversation-list reference at `d0dbf160be6533535cf482cc9e6e9f96eb957c3f` remains the applicable UI design reference. No reference code is copied. Sprout's prototype, Project Human authority, scope privacy and migration boundaries govern this implementation.

The owner must adjudicate the added sidebar/Feed surfaces and validate their visual fit in the integrated preview. This Worker does not operate the existing preview or claim owner acceptance. Global count refresh currently scans collaboration history at the server and checks scope authority; a dedicated aggregate query can reduce this cost for large histories without broadening the payload.
