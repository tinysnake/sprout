/**
 * The one polite announcement channel for shell state.
 *
 * A surface injects this and calls `announce()` with a sentence. The Shell
 * renders the single `aria-live` region, which is what keeps simultaneous
 * changes readable instead of interleaved across several live regions.
 *
 * The channel is provided at the application level rather than by the Shell
 * component, because slot content (the router view) is resolved in the parent's
 * component context and would not otherwise see the Shell's own `provide`.
 */
import { inject, ref, type InjectionKey, type Ref } from 'vue';

export interface Announcer {
  announce(text: string): void;
}

export interface AnnouncerChannel {
  readonly announcer: Announcer;
  readonly message: Ref<string>;
}

export const ANNOUNCER_KEY: InjectionKey<Announcer> = Symbol('sprout.announcer');
export const ANNOUNCER_MESSAGE_KEY: InjectionKey<Ref<string>> = Symbol('sprout.announcer.message');

export function createAnnouncerChannel(): AnnouncerChannel {
  const message = ref('');
  return {
    message,
    announcer: {
      announce(text: string) {
        // Reassigning to a new string is what makes a screen reader read a
        // repeated sentence again; an identical value reads as no change.
        message.value = text;
      },
    },
  };
}

/** Returns the Shell announcer, or a no-op when no Shell region is mounted. */
export function useAnnouncer(): Announcer {
  return inject(ANNOUNCER_KEY, { announce: () => {} });
}

/** Returns the message the Shell's live region renders. */
export function useAnnouncerMessage(): Ref<string> {
  return inject(ANNOUNCER_MESSAGE_KEY, ref(''));
}
