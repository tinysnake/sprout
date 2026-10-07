export const EXECUTION_MODES = ['environment-hosted', 'host-run'] as const;
export type ExecutionMode = typeof EXECUTION_MODES[number];

export const EXECUTION_MODE_USAGE =
  'Usage: npm start -- [--execution-mode environment-hosted|host-run]';

/** Parse the Sprout service arguments before reading host configuration or building Runtime. */
export function parseExecutionModeArguments(args: readonly string[]): ExecutionMode {
  let executionMode: ExecutionMode = 'environment-hosted';
  let seen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equalsValue = argument.startsWith('--execution-mode=')
      ? argument.slice('--execution-mode='.length)
      : undefined;
    if (argument !== '--execution-mode' && equalsValue === undefined) {
      throw new Error(`invalid Sprout startup argument; ${EXECUTION_MODE_USAGE}`);
    }
    if (seen) throw new Error(`--execution-mode may be specified only once; ${EXECUTION_MODE_USAGE}`);
    seen = true;

    const value = equalsValue ?? args[index + 1];
    if (value === undefined || value === '' || (equalsValue === undefined && value.startsWith('-'))) {
      throw new Error(`--execution-mode requires a value; ${EXECUTION_MODE_USAGE}`);
    }
    if (!EXECUTION_MODES.includes(value as ExecutionMode)) {
      throw new Error(`--execution-mode must be environment-hosted or host-run; ${EXECUTION_MODE_USAGE}`);
    }
    executionMode = value as ExecutionMode;
    if (equalsValue === undefined) index += 1;
  }

  return executionMode;
}

export interface ExecutionStrategy {
  readonly mode: ExecutionMode;
  readonly admission: {
    readonly available: boolean;
    readonly refusal?: string;
  };
  readonly taskAdmission: {
    readonly available: boolean;
    readonly refusal?: string;
  };
}

const HOST_RUN_UNAVAILABLE =
  'Host-run execution is unavailable because this host does not meet the isolated Pi conversation controls.';

/** Construct the one immutable execution strategy for a Sprout process. */
const HOST_RUN_TASK_REFUSAL = 'Task execution requires Environment-hosted mode because Tasks need an Environment workspace and lease.';

export function createExecutionStrategy(mode: ExecutionMode, hostRunSupported = false): ExecutionStrategy {
  const supported = mode === 'environment-hosted' || hostRunSupported;
  const tasksSupported = mode === 'environment-hosted';
  return Object.freeze({
    mode,
    admission: supported
      ? Object.freeze({ available: true })
      : Object.freeze({ available: false, refusal: HOST_RUN_UNAVAILABLE }),
    taskAdmission: tasksSupported
      ? Object.freeze({ available: true })
      : Object.freeze({ available: false, refusal: HOST_RUN_TASK_REFUSAL }),
  });
}

export function executionModeAdmissionRefusal(strategy: ExecutionStrategy): string | undefined {
  return strategy.admission.available ? undefined : strategy.admission.refusal;
}

export function taskExecutionModeAdmissionRefusal(strategy: ExecutionStrategy): string | undefined {
  return strategy.taskAdmission.available ? undefined : strategy.taskAdmission.refusal;
}
