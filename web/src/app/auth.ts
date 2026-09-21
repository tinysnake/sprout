import type { InjectionKey } from 'vue';

import type { OperatorSessionBrowserAdapter } from '../adapters/operator-session-api.js';

export const OPERATOR_SESSION: InjectionKey<OperatorSessionBrowserAdapter> = Symbol('sprout.operator-session');
