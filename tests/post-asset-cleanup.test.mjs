import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const {removePostAssetObject} = await import('../lib/post/server-data.ts');
const OWNER = '11111111-1111-4111-8111-111111111111';
const PATH = `${OWNER}/post-assets/test.mp4`;
const REFERENCES = ['mara_media_generations', 'post_draft_assets', 'reel_draft_assets', 'instagram_media_assets'];

function fixture(overrides = {}) {
  const calls = {lookups: [], removed: []};
  const admin = {
    from(table) {
      const lookup = {table, filters: {}};
      calls.lookups.push(lookup);
      const chain = {
        select(columns, options) {
          assert.equal(columns, 'id');
          assert.deepEqual(options, {count: 'exact', head: true});
          return chain;
        },
        eq(column, value) { lookup.filters[column] = value; return chain; },
        then(resolve, reject) {
          const response = overrides[table] ?? {count: 0, error: null};
          return (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)).then(resolve, reject);
        },
      };
      return chain;
    },
    storage: {from(bucket) {
      assert.equal(bucket, 'mara-media');
      return {remove: async paths => { calls.removed.push(...paths); return {error: null}; }};
    }},
  };
  return {admin, calls};
}

for (const table of REFERENCES) {
  test(`${table}: any retained reference protects the object`, async () => {
    const {admin, calls} = fixture({[table]: {count: 1, error: null}});
    await removePostAssetObject(admin, OWNER, PATH);
    assert.deepEqual(calls.removed, []);
  });
  for (const [reason, response] of [
    ['database failure', {count: null, error: {code: '08006'}}],
    ['timeout despite a zero count', {count: 0, error: {code: '57014'}}],
    ['missing count', {error: null}],
    ['null count', {count: null, error: null}],
    ['malformed count', {count: '0', error: null}],
    ['invalid count', {count: -1, error: null}],
    ['transport exception', new Error('synthetic connection failure')],
  ]) test(`${table}: ${reason} never authorizes deletion`, async () => {
    const {admin, calls} = fixture({[table]: response});
    await removePostAssetObject(admin, OWNER, PATH).catch(() => undefined);
    assert.deepEqual(calls.removed, []);
  });
}

test('genuinely unused Instagram/media objects are removed only after all reference checks succeed', async () => {
  const {admin, calls} = fixture();
  await removePostAssetObject(admin, OWNER, PATH);
  assert.deepEqual(calls.lookups.map(call => call.table), REFERENCES);
  assert.ok(calls.lookups.every(call => call.filters.owner_user_id === OWNER && call.filters.storage_path === PATH));
  assert.deepEqual(calls.removed, [PATH]);
});

test('cleanup never inspects or deletes a path outside the supplied owner namespace', async () => {
  const {admin, calls} = fixture();
  for (const path of ['other-owner/post-assets/test.mp4', `${OWNER}/../other/test.mp4`, '', `/${PATH}`]) {
    await removePostAssetObject(admin, OWNER, path);
  }
  assert.deepEqual(calls.lookups, []);
  assert.deepEqual(calls.removed, []);
});
