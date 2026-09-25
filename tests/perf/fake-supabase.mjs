/**
 * Instrumented Supabase double for the navigation performance harness.
 *
 * Implements exactly the PostgREST-client surface Voom's navigation data path
 * uses (`from().select().eq().in().not().gte()...maybeSingle()`, count/head
 * queries, `auth.getClaims()`, `storage.from().createSignedUrl(s)`) against an
 * in-memory row store with real filter semantics — so every downstream
 * derivation (horizon rules, status mapping, approval filtering) executes the
 * real code paths on realistic rows.
 *
 * Every operation is traced with start/end timestamps while a configurable
 * per-round-trip latency is injected, which turns the request's true fetch
 * waterfall (sequential depth vs parallel waves) into measurable wall time.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Row access that tolerates snake_case columns accessed from JS objects. */
function colOf(row, col) {
  return row == null ? undefined : row[col];
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  return String(a) === String(b);
}

export class Trace {
  constructor({ rttMs }) {
    this.rttMs = rttMs;
    this.ops = [];
    this.t0 = performance.now();
  }

  /** Wraps one simulated network round trip and records its interval. */
  async op(label, detail, run) {
    const start = performance.now() - this.t0;
    await sleep(this.rttMs);
    const end = performance.now() - this.t0;
    this.ops.push({ label, detail, start, end });
    return run();
  }

  reset() {
    this.ops = [];
    this.t0 = performance.now();
  }

  get wallMs() {
    if (!this.ops.length) return 0;
    return Math.max(...this.ops.map((op) => op.end)) - Math.min(...this.ops.map((op) => op.start));
  }

  /** Maximum number of round trips in flight at the same instant. */
  get maxConcurrency() {
    const points = [];
    for (const op of this.ops) {
      points.push([op.start, 1]);
      points.push([op.end, -1]);
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let live = 0;
    let max = 0;
    for (const [, delta] of points) {
      live += delta;
      if (live > max) max = live;
    }
    return max;
  }

  /** Effective sequential round trips on the critical path. */
  get criticalPathRtts() {
    return this.rttMs > 0 ? this.wallMs / this.rttMs : 0;
  }

  counts() {
    const byLabel = new Map();
    for (const op of this.ops) byLabel.set(op.label, (byLabel.get(op.label) ?? 0) + 1);
    return Object.fromEntries([...byLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  }

  /** Labels fetched more than once in the same request — pure duplicate reads. */
  duplicates() {
    return Object.entries(this.counts())
      .filter(([, count]) => count > 1)
      .map(([label, count]) => `${label} ×${count}`);
  }

  timeline(limit = 40) {
    const rows = [...this.ops]
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .slice(0, limit)
      .map((op) => `    +${op.start.toFixed(0).padStart(5)}ms … +${op.end.toFixed(0).padStart(5)}ms  ${op.label}${op.detail ? `  ${op.detail}` : ""}`);
    if (this.ops.length > limit) rows.push(`    … ${this.ops.length - limit} more ops`);
    return rows.join("\n");
  }
}

class FakeQuery {
  constructor(ctx, table) {
    this.ctx = ctx;
    this.table = table;
    this.filters = [];
    this.orderBy = null;
    this.limitN = null;
    this.isMaybeSingle = false;
    this.countMode = null;
    this.headOnly = false;
  }

  select(_cols, opts) {
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }

  insert(values) {
    this.mutation = { kind: "insert", values: Array.isArray(values) ? values : [values] };
    return this;
  }

  update(values) {
    this.mutation = { kind: "update", values };
    return this;
  }

  eq(col, value) { this.filters.push((row) => looseEq(colOf(row, col), value)); return this; }
  neq(col, value) { this.filters.push((row) => !looseEq(colOf(row, col), value)); return this; }
  in(col, values) {
    const list = values ?? [];
    this.filters.push((row) => list.some((value) => looseEq(colOf(row, col), value)));
    return this;
  }
  is(col, value) { this.filters.push((row) => colOf(row, col) === value); return this; }
  not(col, operator, value) {
    if (operator === "is" && value === null) {
      this.filters.push((row) => colOf(row, col) !== null && colOf(row, col) !== undefined);
      return this;
    }
    throw new Error(`fake-supabase: unsupported not(${col}, ${operator}, …)`);
  }
  gte(col, value) { this.filters.push((row) => colOf(row, col) != null && String(colOf(row, col)) >= String(value)); return this; }
  lte(col, value) { this.filters.push((row) => colOf(row, col) != null && String(colOf(row, col)) <= String(value)); return this; }
  gt(col, value) { this.filters.push((row) => colOf(row, col) != null && String(colOf(row, col)) > String(value)); return this; }
  lt(col, value) { this.filters.push((row) => colOf(row, col) != null && String(colOf(row, col)) < String(value)); return this; }
  order(col, { ascending = true } = {}) { this.orderBy = { col, ascending }; return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.isMaybeSingle = true; return this; }

  then(onFulfilled, onRejected) { return this._run().then(onFulfilled, onRejected); }
  catch(onRejected) { return this._run().catch(onRejected); }
  finally(fn) { return this._run().finally(fn); }

  _run() {
    const ctx = this.ctx;
    const detail = this._describe();
    return ctx.trace.op(`rest:${this.table}`, detail, () => {
      const rows = ctx.store.get(this.table) ?? [];
      if (this.mutation?.kind === "insert") {
        for (const values of this.mutation.values) rows.push({ ...values });
        return { data: this.mutation.values, error: null, count: null };
      }
      if (this.mutation?.kind === "update") {
        const updated = [];
        for (const row of rows) {
          if (this.filters.every((predicate) => predicate(row))) {
            Object.assign(row, this.mutation.values);
            updated.push(row);
          }
        }
        return { data: updated, error: null, count: null };
      }
      let matched = rows.filter((row) => this.filters.every((predicate) => predicate(row)));
      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        matched = [...matched].sort((a, b) => {
          const av = colOf(a, col);
          const bv = colOf(b, col);
          if (av === bv) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (String(av) < String(bv) ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      const total = matched.length;
      if (this.limitN != null) matched = matched.slice(0, this.limitN);
      if (this.countMode && this.headOnly) return { data: null, count: total, error: null };
      if (this.isMaybeSingle) return { data: matched[0] ? { ...matched[0] } : null, error: null, count: null };
      return { data: matched.map((row) => ({ ...row })), error: null, count: this.countMode ? total : null };
    });
  }

  _describe() {
    const parts = this.filters.length ? `filters×${this.filters.length}` : "no-filter";
    const shape = this.isMaybeSingle ? "maybeSingle" : this.headOnly ? "head/count" : this.limitN != null ? `limit ${this.limitN}` : "rows";
    return `(${parts}, ${shape})`;
  }
}

function fakeStorage(ctx, bucket) {
  return {
    createSignedUrl(storagePath, expiresIn) {
      return ctx.trace.op(`storage.sign:${bucket}`, `1 path, exp ${expiresIn}`, () => ({
        data: { signedUrl: `https://fake-storage.local/${bucket}/${storagePath}?token=sig` },
        error: null,
      }));
    },
    createSignedUrls(paths, expiresIn) {
      return ctx.trace.op(`storage.sign:${bucket}`, `${paths.length} paths (batch), exp ${expiresIn}`, () => ({
        data: paths.map((storagePath) => ({
          signedUrl: `https://fake-storage.local/${bucket}/${storagePath}?token=sig`,
          path: storagePath,
        })),
        error: null,
      }));
    },
  };
}

/**
 * Creates the instrumented client pair (session + admin) for one scenario.
 * `store` is a Map<table, row[]>; `claims` are returned by auth.getClaims().
 */
export function createFakeClients({ store, trace, claims }) {
  const ctx = { store, trace, claims };
  const client = () => ({
    from: (table) => {
      if (!store.has(table)) store.set(table, []);
      return new FakeQuery(ctx, table);
    },
    auth: {
      getClaims() {
        return ctx.trace.op("auth.getClaims", "", () => ({
          data: { claims: { ...ctx.claims }, header: {}, signature: new Uint8Array() },
          error: null,
        }));
      },
    },
    storage: {
      from: (bucket) => fakeStorage(ctx, bucket),
    },
  });
  return { session: client(), admin: client() };
}
