/**
 * The short-lived grant that lets one published model request use a staged
 * remote tool catalog. The Environment Operations module checks it before each
 * new operation; closing an old session does not by itself fence a queued call.
 */
export interface BindingGenerationFence {
  readonly generation: number;
  isCurrent(): boolean;
}
