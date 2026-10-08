import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Public OS ICU timezone data, resolved to literal files rather than a database subtree. */
export function macOsTimezoneFiles(): string[] {
  if (process.platform !== 'darwin') return [];
  try {
    const root = realpathSync('/var/db/timezone/icutz');
    if (!/^\/private\/var\/db\/timezone\/tz\/[^/]+\/icutz$/.test(root)) return [];
    return readdirSync(root).filter(name => /^icutz\d+l\.dat$/.test(name)).flatMap(name => {
      const path = join(root, name);
      return realpathSync(path) === path ? [path] : [];
    });
  } catch {
    // Missing OS data never widens the file boundary.
    return [];
  }
}
