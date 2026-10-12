import type { Event, SessionOptions, SessionUsage, TurnOutcome } from '@botiverse/oar';

export type RunnerCommand =
  | {
      readonly op: 'start';
      readonly runtimeId: string;
      readonly options: SessionOptions;
      readonly hostPolicy?: { readonly sandbox?: string };
    }
  | {
      readonly op: 'prompt';
      readonly input: string;
      readonly activationId: string;
    }
  | {
      readonly op: 'abort';
    }
  | {
      readonly op: 'dispose';
    };

export type RunnerMessage =
  | {
      readonly kind: 'ready';
      readonly sessionId: string;
      readonly engineSessionKey: string;
    }
  | {
      readonly kind: 'event';
      readonly event: Event;
    }
  | {
      readonly kind: 'prompt_accepted';
      readonly activationId: string;
      readonly seq: number;
      readonly spanId?: string | undefined;
    }
  | {
      readonly kind: 'prompt_rejected';
      readonly activationId?: string | undefined;
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'turn_ended';
      readonly activationId?: string | undefined;
      readonly spanId?: string | undefined;
      readonly outcome: TurnOutcome;
      readonly usage?: SessionUsage | null | undefined;
    }
  | {
      readonly kind: 'abort_delivered';
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly stage?: string;
      readonly code?: string;
    }
  | {
      readonly kind: 'disposed';
    };
