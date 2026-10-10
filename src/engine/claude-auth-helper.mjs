import { readFileSync } from 'node:fs';

// Claude Code's helper channel reads the existing user credential in place.
// It never writes, copies, or logs the credential to a file.
try {
  const settings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const token = settings?.env?.ANTHROPIC_AUTH_TOKEN ?? settings?.env?.ANTHROPIC_API_KEY;
  if (typeof token !== 'string' || token.length === 0) process.exit(2);
  process.stdout.write(token);
} catch {
  process.exit(2);
}
