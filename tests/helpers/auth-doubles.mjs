/**
 * Test doubles for the auth pages' server actions and the auth callback route.
 *
 * Stands in for `@/utils/supabase/server` (the cookie-backed Supabase client),
 * `next/headers` and `next/navigation`. The actions, the callback and the site
 * URL helper stay REAL, so the tests prove the real validation, the real
 * redirect targets and the real "never reveal whether an account exists" rule.
 *
 * `redirect` throws, exactly as Next.js does, so code after a redirect never
 * runs in the test either.
 */

export const state = {
  resetCalls: [],
  updateCalls: [],
  exchangeCalls: [],
  signOutCalls: [],
  redirects: [],
  resetError: null,
  updateError: null,
  exchangeError: null,
  signOutError: null,
  claims: null,
};

export function reset(overrides = {}) {
  state.resetCalls = [];
  state.updateCalls = [];
  state.exchangeCalls = [];
  state.signOutCalls = [];
  state.redirects = [];
  state.resetError = null;
  state.updateError = null;
  state.exchangeError = null;
  state.signOutError = null;
  state.claims = null;
  Object.assign(state, overrides);
}

/* ── next/navigation ────────────────────────────────────────── */
export class RedirectSignal extends Error {
  constructor(path) { super(`redirect:${path}`); this.path = path; }
}
export function redirect(path) {
  state.redirects.push(path);
  throw new RedirectSignal(path);
}
export function notFound() { throw new Error("notFound"); }

/** Runs `fn` and returns the path it redirected to, or null if it returned normally. */
export async function redirectedTo(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.path;
    throw error;
  }
}

/* ── next/headers ───────────────────────────────────────────── */
export async function headers() { return new Headers({ origin: "http://localhost:3000" }); }
export async function cookies() { return { get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }; }

/* ── @/utils/supabase/server ────────────────────────────────── */
export async function createClient() {
  return {
    auth: {
      async resetPasswordForEmail(email, options) {
        state.resetCalls.push({ email, options });
        return { data: {}, error: state.resetError };
      },
      async updateUser(attributes) {
        state.updateCalls.push(attributes);
        return { data: {}, error: state.updateError };
      },
      async exchangeCodeForSession(code, options) {
        state.exchangeCalls.push({ code, options });
        return { data: {}, error: state.exchangeError };
      },
      async signOut(options) {
        state.signOutCalls.push(options);
        return { error: state.signOutError };
      },
      async getClaims() {
        return { data: state.claims ? { claims: state.claims } : null, error: null };
      },
    },
  };
}
