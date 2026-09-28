import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentEnrollmentService } from './enrollment-service.ts';
import { InMemoryEnrollmentStore } from './enrollment-store.ts';
import { InMemoryEnvironmentReadinessStore, type EnvironmentReadinessStore } from './readiness-store.ts';
import { SqliteEnvironmentReadinessStore } from './sqlite-readiness-store.ts';

for (const backend of ['memory', 'sqlite'] as const) {
  for (const decision of ['revoke', 'reset'] as const) {
    test(`#172 ${backend}: ${decision} winning before the entitlement write cannot leave fresh authorization evidence`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'sprout-172-race-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const store: EnvironmentReadinessStore = backend === 'sqlite'
        ? new SqliteEnvironmentReadinessStore({ filename: join(directory, 'readiness.db') })
        : new InMemoryEnvironmentReadinessStore();
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let delayNext = false;
      const readiness: EnvironmentReadinessStore = new Proxy(store, {
        get(target, key) {
          if (key === 'recordModelAuthorizations') {
            return async (...args: Parameters<EnvironmentReadinessStore['recordModelAuthorizations']>) => {
              if (delayNext && args[1].length > 0) {
                delayNext = false;
                arrived.resolve();
                await release.promise;
              }
              return target.recordModelAuthorizations(...args);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const service = new EnvironmentEnrollmentService({
        enrollments: new InMemoryEnrollmentStore(), readiness,
        currentConnectionEpoch: () => undefined, idFactory: () => 'enroll-1', clock: () => 1000,
      });
      const id = (await service.requestEnrollment({
        environmentInstanceId: 'env-1', displayName: 'Environment', platform: 'macos',
        publicKey: 'worker-public-key', capabilityRequests: [], engineFacts: [],
      })).enrollment.id;
      await service.approve(id, { capabilityPermissions: {} });
      delayNext = true;
      const authorizing = service.authorizeModels(id, { modelAuthorizations: { codex: ['new-model'] } });
      await arrived.promise;
      try {
        await service[decision](id, 'Human lifecycle decision');
      } finally {
        release.resolve();
      }
      await authorizing;
      assert.equal((await service.get(id))?.status, decision === 'reset' ? 'pending' : 'revoked');
      assert.deepEqual((await store.listModelAuthorizationEvidence('env-1')).flatMap((e) => e.authorizations), []);
      assert.deepEqual((await store.getReadiness('env-1'))?.engines.flatMap((e) => e.modelAuthorizations ?? []) ?? [], []);
    });
  }
}
