import type { Event, SessionOptions, SessionUsage, TurnOutcome } from '@botiverse/oar';
import type { OarPiPolicy } from './oar-runtime-policy.ts';

export type RunnerCommand =
  | {
      readonly op: 'start';
      readonly runtimeId: string;
      readonly binaryPath?: string;
      readonly options: SessionOptions;
      readonly hostPolicy?: { readonly sandbox?: string; readonly pi?: OarPiPolicy };
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
      /** True only when this OAR session opened a new native conversation. */
      readonly freshSession?: boolean | undefined;
      /** Cumulative usage at native session open, when the runtime can report it. */
      readonly usageBaseline?: SessionUsage | null | undefined;
    }
  | {
      readonly kind: 'event';
      readonly event: Event;
      readonly activationId?: string | undefined;
    }
  | {
      /** A session-cumulative usage snapshot observed during an admitted turn. */
      readonly kind: 'usage_snapshot';
      readonly activationId: string;
      readonly seq: number;
      readonly usage: SessionUsage;
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
      readonly seq?: number | undefined;
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
