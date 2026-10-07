import type { InjectionKey } from 'vue';
import type { TaskBrowserAdapter } from '../../adapters/task-api.js';

/** Production Task authority for the Project Tasks destination. */
export const TASKS_API: InjectionKey<TaskBrowserAdapter> = Symbol('sprout.tasks.api');
