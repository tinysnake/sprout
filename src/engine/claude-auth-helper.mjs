import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Claude Code's helper channel reads the existing credential in place. The
// control pin binds that read to the accepted model, effort, endpoint, and auth
// value without retaining the credential outside the original settings file.
try {
  const settings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const pin = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const env = settings?.env;
  if (typeof settings?.model !== 'string' || typeof settings?.effortLevel !== 'string' ||
      typeof env?.ANTHROPIC_BASE_URL !== 'string' || !pin || typeof pin !== 'object') process.exit(2);
  const token = [env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY]
    .find(value => typeof value === 'string' && value.length > 0);
  if (typeof token !== 'string') process.exit(2);
  const authorizationFingerprint = createHash('sha256').update(JSON.stringify({
    model: settings.model,
    effortLevel: settings.effortLevel,
    baseUrl: env.ANTHROPIC_BASE_URL,
    authToken: token,
  })).digest('hex');
  if (settings.model !== pin.model || settings.effortLevel !== pin.effortLevel ||
      env.ANTHROPIC_BASE_URL !== pin.baseUrl || authorizationFingerprint !== pin.authorizationFingerprint) process.exit(2);
  process.stdout.write(token);
} catch {
  process.exit(2);
}
