/** Test-only PostgREST-shaped bridge to isolated embedded PostgreSQL. No network. */
import assert from 'node:assert/strict';
export function nativeVideoDb(db) {
  const objects = new Map();
  const errors = [];
  const ident = value => { assert.match(value, /^[a-z_][a-z_0-9]*$/); return value; };
  let pending = Promise.resolve();
  function execute(sql, values) {
    const result = pending.then(() => request(sql, values));
    pending = result.catch(() => undefined);
    return result;
  }
  async function request(sql, values) {
    // Real PostgREST errors don't abort the surrounding fixture transaction.
    await db.exec('savepoint bridge_request');
    try {
      const result = await db.query(sql, values);
      await db.exec('release savepoint bridge_request');
      // PostgREST serializes PostgreSQL dates as ISO JSON, unlike PGlite's Dates.
      return { data: JSON.parse(JSON.stringify(result.rows)), error: null };
    } catch (error) {
      await db.exec('rollback to savepoint bridge_request; release savepoint bridge_request');
      errors.push(error.message);
      return { data: null, error: { code: error.code, message: error.message } };
    }
  }
  const admin = {
    objects,
    errors,
    async rpc(name, args) {
      const values = Object.values(args);
      const result = await execute(`select public.${ident(name)}(${Object.keys(args).map((k, i) => `${ident(k)} => $${i + 1}`).join(',')}) as value`, values);
      return { data: result.data?.[0]?.value ?? null, error: result.error };
    },
    from(table) {
      ident(table);
      let columns = '*', patch = null, insert = null, conflict = null, deleting = false, limit = '', order = '', single = false, count = false;
      const filters = [], values = [];
      const bind = value => { values.push(value); return `$${values.length}`; };
      const chain = {
        select(cols, options) { columns = cols; count = options?.head === true; return chain; },
        eq(key, value) { filters.push(`${ident(key)}=${bind(value)}`); return chain; },
        in(key, list) { filters.push(`${ident(key)} in (${list.map(bind).join(',')})`); return chain; },
        gte(key, value) { filters.push(`${ident(key)}>=${bind(value)}`); return chain; },
        lt(key, value) { filters.push(`${ident(key)}<${bind(value)}`); return chain; },
        or(expression) {
          const match = expression.match(/^updated_at\.is\.null,updated_at\.lte\.(.+)$/);
          assert.ok(match); filters.push(`(updated_at is null or updated_at<=${bind(match[1])})`); return chain;
        },
        order(key, options) { order = ` order by ${ident(key)} ${options?.ascending === false ? 'desc' : 'asc'}`; return chain; },
        limit(number) { assert.ok(Number.isInteger(number)); limit = ` limit ${number}`; return chain; },
        update(row) { patch = row; return chain; },
        insert(row) { insert = row; return chain; },
        upsert(row, options) { insert = row; conflict = options.onConflict.split(',').map(ident); return chain; },
        delete() { deleting = true; return chain; },
        maybeSingle() { single = true; return chain; },
        single() { single = true; return chain; },
        async then(resolve, reject) {
          try {
            assert.match(columns, /^(\*|[a-z_,]+)$/);
            let sql;
            if (deleting) {
              sql = `delete from ${table}${filters.length ? ` where ${filters.join(' and ')}` : ''} returning ${columns}`;
            } else if (insert) {
              const update = conflict ? ` on conflict (${conflict.join(',')}) do update set ${Object.keys(insert).map(key => `${ident(key)}=excluded.${ident(key)}`).join(',')}` : '';
              sql = `insert into ${table} (${Object.keys(insert).map(ident).join(',')}) values (${Object.values(insert).map(bind).join(',')})${update} returning ${columns}`;
            } else if (patch) {
              const assignments = Object.entries(patch).map(([key, value]) => `${ident(key)}=${bind(value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value)}`).join(',');
              sql = `update ${table} set ${assignments}${filters.length ? ` where ${filters.join(' and ')}` : ''} returning ${columns}`;
            } else {
              sql = `select ${count ? 'count(*)::int as count' : columns} from ${table}${filters.length ? ` where ${filters.join(' and ')}` : ''}${order}${limit}`;
            }
            const result = await execute(sql, values);
            resolve({ ...result, data: count ? null : single ? result.data?.[0] ?? null : result.data, count: count ? result.data?.[0]?.count : undefined });
          } catch (error) { reject(error); }
        },
      };
      return chain;
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'mara-media');
      return {
        async upload(path, bytes) { objects.set(path, bytes); return {error:null}; },
        async createSignedUrl(path) { return {data:{signedUrl:`https://preview.invalid/${path}?signed=test-only`},error:null}; },
        async remove(paths) { paths.forEach(path => objects.delete(path)); return {error:null}; },
      };
    } },
  };
  return admin;
}

/** Structural MP4 fixture, not a simulated provider-success video or review recording. */
export function mp4({ width = 1080, height = 1920, seconds = 6 } = {}) {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const box = (type, bytes) => Buffer.concat([u32(bytes.length + 8), Buffer.from(type), bytes]);
  const tkhd = Buffer.alloc(24); u32(width << 16).copy(tkhd, 16); u32(height << 16).copy(tkhd, 20);
  const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(12), u32(1000), u32(seconds * 1000)]));
  const hdlr = box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('vide')]));
  return new Uint8Array(Buffer.concat([box('ftyp', Buffer.from('isom0000')),
    box('moov', Buffer.concat([box('mvhd', Buffer.concat([Buffer.alloc(12),u32(1000),u32(seconds*1000)])),
      box('trak', Buffer.concat([box('mdia', Buffer.concat([mdhd,hdlr])),box('tkhd',tkhd)]))]))]));
}
