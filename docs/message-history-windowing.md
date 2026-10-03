# Message history windows

Messages remain durable for their conversation scope. The Web API and Chat view
read that history in bounded pages; paging never deletes or rewrites stored
Messages.

## API

`GET /api/messages` returns the newest 50 Messages by default in the existing
`{ messages }` response shape. `limit` accepts a positive integer and is capped
at 100. `scopeId` restricts a page to one conversation scope. Messages are
ordered by `(createdAt, id)` ascending so timestamps that tie have a stable
position.

`before=<messageId>` returns the preceding page, excluding the cursor Message.
The cursor must exist and belong to the requested scope when `scopeId` is
provided; otherwise the route returns 404 naming the unknown cursor. Invalid
limits and an empty cursor return 400. Pages ending before the oldest Message
return an empty `messages` array.

The collaboration store exposes a bounded page query for the Web route. Its
existing full-history `listMessages` operation remains available to internal
routing, unread, and evidence calculations that need durable history.

## Chat view

On project open, Chat loads the newest 50 Messages for each conversation scope.
Scrolling the active conversation to its top requests the page before its oldest
loaded Message. Chat anchors the first visible timeline row across the prepend,
so older rows do not move the viewport. Refreshes merge new rows by Message id
with pages already loaded; arrival polling, run-triggered refreshes, delivery
keys, and generation checks continue through their existing paths.

Chat retains at most 200 Messages per scope in the view. At the cap, older-page
loading stops and the view explains that it is showing the latest 200. This is a
presentation bound only: the durable conversation history remains available to
continue from a later page or another client.

The store and routing contracts do not impose a Message retention or truncation
window. This document establishes the Web paging and in-view memory limits
without changing durable history or bounded wake-model context.

## Reference check

The repository's standing references (Cumora, Paperclip, and AionUi) have no
absorbed conversation-history paging implementation recorded in
`docs/references.md`; the existing Sprout collaboration store and scope model
therefore remain the design authority for this addition.

## Verification

Focused server cursor tests live in `src/web/api-messages.test.ts`. Adapter query
encoding is covered in `web/src/adapters/message-api.test.ts`, and up-scroll,
viewport anchoring, and arrivals while paging are covered in
`web/src/app/routes.dom.test.ts`.
