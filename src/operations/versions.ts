import { readFileSync } from 'node:fs';
import { SUPPORTED_WORKER_PROTOCOL } from '../environment/enrollment-service.ts';
const productVersion: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const version = typeof productVersion === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(productVersion) ? productVersion : 'unknown';
export const PRODUCT_VERSIONS = { sprout: version, web: version, worker: version, workerProtocol: { ...SUPPORTED_WORKER_PROTOCOL } };
