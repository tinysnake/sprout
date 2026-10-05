# Agent Task-group messages

An Agent sends collaboration messages to its current Task group through the session-local Task-group post command. The command is available only to a Worker-hosted session for a Project-bound Task run. Core binds it to that run's Task, Project, Agent, and Task-held Environment lease; the command accepts no destination or identity fields.

The Worker supplies `SPROUT_TASK_GROUP_POST_URL` and `SPROUT_TASK_GROUP_POST_TOKEN` only in the engine process environment. They are session credentials: adapters must not write them into instruction files, standing context, Task files, or durable records. Closing or stopping the session revokes the bridge. Core rechecks the run, active Task link, lease, and Stop state under the Task-group lifecycle lock immediately before persistence. A frozen Task group rejects a post with HTTP 409 and keeps its history unchanged.

The command accepts a free-form `body`, a stable `deliveryKey`, optional `kind` (`handoff`, `assignment`, `question`, or `status`; default `status`), optional `inReplyTo` naming an earlier Message in the same Task group, and optional `awaitReply` (default `false`). Body text has no schema or required template. Sprout stores it unchanged. One stable delivery key identifies one intended post; retrying that key returns the original Message and wake facts without creating another Message or wake.

The channel stamps the envelope from trusted state. It records the selected kind, server-resolved sender, Task and run ids, work-item id, and Task-group id. The group id is the durable conversation scope bound to that Task. `to` is the ordered set of exact `@member` tokens found in the body. Client-supplied sender, Task, run, work-item, group, recipient, or envelope fields are ignored; they cannot move a post to another Task group or change its author. `@all` is retained as a mention target for routing consumers.

Use a shell tool to send a JSON request like this to `$SPROUT_TASK_GROUP_POST_URL`:

```json
{
  "body": "The report draft is ready. @reviewer, please check the final section.",
  "kind": "handoff",
  "deliveryKey": "report-review-01",
  "awaitReply": false
}
```

Send it with the session token in the Authorization header. Do not print or copy the token. Reuse `deliveryKey` only when retrying that same intended post. Set `inReplyTo` to an earlier Message id when the post is an explicit reply in this Task group; omit it for an independent send. Inspect the returned envelope, wakes, and runs: a stored Message or admitted wake does not prove that a recipient run completed successfully.

## Soft handoff template

This is a writing aid in Agent instructions only. Sprout does not require these headings or reject a body that uses different wording.

```text
完成：what is complete
交付：artifacts and context the next Agent can resume from
请下游：@next-agent or @lead, when known; otherwise omit
未决：open questions, risks, or remaining work
```

Keep the report factual and concise. A recipient may be named with an exact `@member` token when known. The body remains ordinary prose, so an Agent can describe a result in whatever structure fits the work.

Human-to-Agent direct conversations remain available through Human Chat. A Human's direct message wakes the addressed Agent, and the Agent's final reply is projected into that same conversation. For explicit collaboration messages between Agents, use the Task-group post command so each message stays attached to the Task it advances.
