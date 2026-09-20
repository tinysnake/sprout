import type {
  AgentInstance,
  AgentTrafficLight,
  AgentWorkOptionRow,
} from './types.js';

/**
 * The page's deterministic status language (#91).
 *
 * This composes the backend's facts into the traffic light and its mandatory
 * textual reason. It owns no domain rule of its own: availability is whatever
 * the Environment-facts projection reported, lifecycle is the durable status,
 * and the sentence only names the decisive fact. The wording follows the
 * product prototype: Ready, Attention / Degraded, Action Required, Archived.
 *
 * It is a pure function so tests can reach every state without a fixture.
 */

function optionAvailable(option: AgentWorkOptionRow): boolean {
  return option.compatibility === 'available';
}

export function evaluateAgentStatus(input: {
  readonly status: AgentInstance['status'];
  readonly workOptions: readonly AgentWorkOptionRow[];
  readonly compatibility?: AgentInstance['compatibility'];
}): { readonly trafficLight: AgentTrafficLight; readonly reason: string } {
  if (input.status === 'archived') {
    return {
      trafficLight: 'neutral',
      reason:
        'Archived Agent · New work is barred; attribution, instructions, and version history are preserved.',
    };
  }

  if (input.workOptions.length === 0) {
    // The backend's minimum-one-option invariant means this is unreachable over
    // the wire; the page still reports it honestly rather than guessing green.
    return {
      trafficLight: 'red',
      reason: 'Invalid configuration: an Agent requires at least one ordered work option.',
    };
  }

  if (input.compatibility === undefined) {
    return {
      trafficLight: 'yellow',
      reason:
        'Attention: Environment compatibility facts are not reachable; the last known options are shown.',
    };
  }

  const primary = input.workOptions[0]!;
  const fallbackCount = input.workOptions.length - 1;

  if (input.compatibility.environmentAvailable) {
    if (optionAvailable(primary)) {
      return {
        trafficLight: 'green',
        reason:
          `Ready: Priority 1 option (${primary.engine.toUpperCase()} · ${primary.workModel} · ${primary.effort}) is ready on the current Environment` +
          (fallbackCount > 0 ? ` · ${fallbackCount} fallback option(s) configured` : '') +
          '.',
      };
    }
    // Overall available but through a lower-priority option: pre-acceptance
    // fallback is real, so this is attention rather than failure.
    return {
      trafficLight: 'yellow',
      reason: `Attention: Priority 1 option (${primary.engine.toUpperCase()} · ${primary.workModel}) is unavailable; a pre-acceptance fallback option would be admitted.`,
    };
  }

  return {
    trafficLight: 'red',
    reason:
      input.compatibility.unavailableReason ??
      'Action Required: no configured work option is compatible with the current Environment.',
  };
}

/** The option row's own badge text; never colour-only (ADR-0009). */
export function optionStateLabel(compatibility: AgentWorkOptionRow['compatibility']): string {
  switch (compatibility) {
    case 'available':
      return 'Ready';
    case 'login-required':
      return 'Login Required';
    case 'missing':
      return 'Missing';
    case 'model-unavailable':
      return 'Model Unavailable';
    default:
      return 'Not Yet Observed';
  }
}

/** The badge variant each option state renders with. */
export function optionStateVariant(
  state: AgentWorkOptionRow['compatibility']
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'available':
      return 'success';
    case 'login-required':
    case 'model-unavailable':
      return 'warning';
    case 'missing':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** The detail banner's status title, matching the prototype's status language. */
export function bannerTitle(trafficLight: AgentTrafficLight): string {
  switch (trafficLight) {
    case 'green':
      return 'Ready';
    case 'yellow':
      return 'Attention / Degraded';
    case 'red':
      return 'Action Required';
    default:
      return 'Archived';
  }
}
