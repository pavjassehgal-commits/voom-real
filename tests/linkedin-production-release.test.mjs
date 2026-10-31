import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
const { handleLinkedInCron } = await import('../lib/linkedin/cron.ts');

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const request = authorization => new Request('https://example.test/api/cron/linkedin-publish', {
  headers: authorization ? { authorization } : {},
});
const secret = 'synthetic-cron-secret-not-a-real-credential';

test('release preserves both production schedules and adds exactly one bounded LinkedIn schedule', async () => {
  const config = JSON.parse(await read('vercel.json'));
  assert.deepEqual(config.crons, [
    { path: '/api/cron/weekly-plans', schedule: '0 3 * * *' },
    { path: '/api/cron/trend-collection', schedule: '0 4 * * *' },
    { path: '/api/cron/linkedin-publish', schedule: '*/5 * * * *' },
  ]);
  assert.deepEqual(config.git.deploymentEnabled, {
    'codex/linkedin-production-release': false,
    'codex/linkedin-marketing-plan': false,
  });
  assert.equal('env' in config, false);
  assert.equal('build' in config, false);
});

test('release has no staging deployment config or one-shot endpoint/helpers', async () => {
  for (const path of ['vercel.linkedin-staging.json', 'docs/linkedin-staging-preparation.md',
    'app/api/integrations/linkedin/drafts/[id]/publish/route.ts', 'lib/linkedin/one-shot.ts', 'lib/linkedin/one-shot-http.ts']) {
    await assert.rejects(access(new URL(`../${path}`, import.meta.url)), { code: 'ENOENT' });
  }
  const sources = await Promise.all(['lib/linkedin/config.ts', 'lib/linkedin/http.ts',
    'app/api/integrations/linkedin/status/route.ts', 'components/voom/linkedin/LinkedInWorkspace.tsx'].map(read));
  for (const source of sources) assert.doesNotMatch(source, /isLinkedInOneShotStaging|oneShot|linkedin-staging|qcdpegwjofrqnfudyrqq/);
});

for (const environment of [undefined, 'preview', 'development']) {
  test(`cron fails closed in ${environment ?? 'unset'} environment even with a valid bearer`, async () => {
    let calls = 0;
    const response = await handleLinkedInCron(request(`Bearer ${secret}`), {
      environment, secret, run: async () => { calls++; },
    });
    assert.equal(response.status, 503); assert.equal(calls, 0);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
}

test('missing secret rejects before any database or publishing operation', async () => {
  let calls = 0;
  const response = await handleLinkedInCron(request(), {
    environment: 'production', secret: undefined, run: async () => { calls++; },
  });
  assert.equal(response.status, 503); assert.equal(calls, 0);
});

test('missing, invalid and malformed bearer headers cannot invoke the worker', async () => {
  for (const header of [undefined, 'Bearer wrong', secret, `Basic ${secret}`, `Bearer ${secret}extra`]) {
    let calls = 0;
    const response = await handleLinkedInCron(request(header), {
      environment: 'production', secret, run: async () => { calls++; },
    });
    assert.equal(response.status, 401); assert.equal(calls, 0);
    assert.ok(!(await response.text()).includes(secret));
  }
});

test('authenticated production cron invokes the existing worker exactly once', async () => {
  let calls = 0;
  const result = { configured: true, results: [{ id: 'synthetic-job', outcome: 'published' }] };
  const response = await handleLinkedInCron(request(`Bearer ${secret}`), {
    environment: 'production', secret, run: async () => { calls++; return result; },
  });
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.deepEqual(await response.json(), result);
});

test('worker failure returns a truthful generic error without reflecting credentials or provider details', async () => {
  let calls = 0;
  const response = await handleLinkedInCron(request(`Bearer ${secret}`), {
    environment: 'production', secret,
    run: async () => { calls++; throw new Error(`must-not-leak ${secret}`); },
  });
  assert.equal(response.status, 503); assert.equal(calls, 1);
  const text = await response.text();
  assert.ok(!text.includes(secret)); assert.ok(!text.includes('must-not-leak'));
});

test('route creates its admin client only in the authenticated callback and preserves bounded runtime', async () => {
  const route = await read('app/api/cron/linkedin-publish/route.ts');
  assert.match(route, /environment: process\.env\.VERCEL_ENV/);
  assert.match(route, /secret: process\.env\.CRON_SECRET/);
  assert.match(route, /run: \(\) => runLinkedInPublishing\(\{ db: createAdminClient\(\) \}\)/);
  assert.match(route, /export const maxDuration = 180/);
  assert.match(route, /export const POST = GET/);
});
