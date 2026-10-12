/** Disposable #229 hook; delegates parsing to the pinned vendor projection. */
import * as vendor from 'oar-claude-original-projection';
export const initialClaudeProjection = vendor.initialClaudeProjection;
export const claudePrompted = vendor.claudePrompted;
export const claudeAbortRequested = vendor.claudeAbortRequested;
export function foldClaudeStdout(state, message) {
  const folded = vendor.foldClaudeStdout(state, message);
  if (message.type !== 'result' || message.origin === undefined || message.origin === null) return folded;
  // An autonomous result cannot discharge the host prompt, its abort intent,
  // or its usage. Unknown origin kinds are also kept out of root settlement.
  return {
    state,
    commands: folded.commands.map(command => command.kind !== 'frame' ? command : {
      ...command,
      agentPath: ['autonomous-origin'],
      body: { ...command.body, events: command.body.events.filter(event => !['turn_ended', 'usage'].includes(event.kind)) },
    }),
  };
}
