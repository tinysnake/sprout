/** Disposable #229 conformance driver; not a registered production adapter. */
export function prototypeAdapter(openNative, promptAndWait, timeoutMs) {
  return {
    capabilities: { streaming: 'none', supportsInterrupt: true, standingInstructions: 'out-of-band' },
    async startSession(request) {
      const native = await openNative(request);
      return {
        sessionId: native.id,
        get engineSessionKey() { return native.id; },
        run(prompt) {
          return {
            events: (async function* () {})(),
            completion: promptAndWait(native, prompt, { timeoutMs }).then(result => {
              if (result.kind === 'ended' && result.outcome.kind === 'completed') return { status: 'completed', text: result.text };
              if (result.kind === 'interrupted') return { status: 'interrupted' };
              return { status: 'failed', message: 'bounded-prototype-turn-failed' };
            }),
          };
        },
        async interrupt() { return (await native.abort()).kind === 'accepted'; },
        close: () => native.dispose(),
      };
    },
  };
}
