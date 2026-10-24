import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
// Assertions about what a screen shows or does ignore the comments that explain what it leaves out.
const code = async (path) => (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("homepage links only to real routes and never claims unsupported channels", async () => {
  const page = await code("app/page.tsx");
  for (const href of ["/login", "/signup", "/privacy", "/terms", "/data-deletion"]) assert.match(page, new RegExp(`href="${href}"`));
  assert.doesNotMatch(page, /Facebook|LinkedIn|and more/i, "Voom publishes to Instagram, TikTok, YouTube and email only");
  assert.doesNotMatch(page, /getClaims|createClient|createAdminClient/, "the public page reads no account data");
  assert.ok(existsSync(new URL("../public/redesign/landing-hero.jpg", import.meta.url)));
});

test("log in and sign up keep the existing server actions, field names and signed-in redirect", async () => {
  const [loginPage, loginForm, signupPage, signupForm] = await Promise.all([
    read("app/login/page.tsx"), read("app/login/LoginForm.tsx"), read("app/signup/page.tsx"), read("app/signup/SignupForm.tsx"),
  ]);
  assert.match(loginForm, /useActionState\(login, initialState\)/);
  assert.match(signupForm, /useActionState\(signup, initialState\)/);
  for (const name of ["email", "password"]) assert.match(loginForm, new RegExp(`name="${name}"`));
  for (const name of ["email", "password", "confirmPassword"]) assert.match(signupForm, new RegExp(`name="${name}"`));
  assert.match(loginForm, /autoComplete="current-password"/);
  assert.match(signupForm, /autoComplete="new-password"/);
  for (const page of [loginPage, signupPage]) {
    assert.match(page, /auth\.getClaims\(\)/);
    assert.match(page, /redirect\("\/app"\)/, "a signed-in visitor is sent to the app");
  }
  assert.match(loginPage, /SAFE_ERRORS/, "only allow-listed error messages are shown");
});

test("auth screens offer no control Voom cannot honour", async () => {
  const all = (await Promise.all([code("app/login/LoginForm.tsx"), code("app/signup/SignupForm.tsx"), code("components/voom/auth/AuthFrame.tsx")])).join("\n");
  assert.doesNotMatch(all, /signInWithOAuth|Continue with Google|Apple/i, "no social sign-in exists");
  assert.doesNotMatch(all, /Forgot password|Keep me logged in|Resend link/i, "no password reset, session toggle or resend flow exists");
  assert.doesNotMatch(all, /10 channels|Facebook/i);
  assert.doesNotMatch(all, /createAdminClient|service_role/i);
});

test("setup keeps the real save path, validation and the completed-account redirect", async () => {
  const [wizard, page, complete] = await Promise.all([
    code("components/voom/onboarding/OnboardingWizard.tsx"), read("app/app/onboarding/page.tsx"), code("components/voom/onboarding/SetupComplete.tsx"),
  ]);
  assert.match(page, /business\?\.onboarding_completed/);
  // An onboarded account opening setup is sent on by the wizard, using what the
  // server said when it FIRST mounted. The page itself must not redirect: the
  // save action's /app revalidation re-renders this page, and a server redirect
  // then would hide the completion summary.
  assert.match(page, /<OnboardingWizard completedOnServer=\{Boolean\(business\?\.onboarding_completed\)\} \/>/);
  assert.doesNotMatch(page, /redirect\(/, "no server redirect inside the save action's re-render");
  assert.match(wizard, /const \[finishedBeforeMount\] = useState\(completedOnServer\)/, "the bypass is decided once, at mount");
  assert.match(wizard, /if \(finishedBeforeMount\) router\.replace\("\/app"\)/, "an onboarded account never restarts setup");
  assert.match(wizard, /const ok = await finishOnboarding\(skipped\);\s*(?:haptic\(ok \? "success" : "error"\);\s*)?if \(ok\) setComplete\(\{ skipped \}\);/, "success shows only after the save succeeds");
  assert.ok(wizard.indexOf("if (complete) return <SetupComplete") < wizard.indexOf("if (finishedBeforeMount) return null"), "a just-finished setup shows its summary, never the bypass");
  assert.match(complete, /href="\/app\/today"[^>]*>Go to dashboard/, "the summary leads to the dashboard");
  assert.match(wizard, /await finishOnboarding\(skipped\)/);
  for (const message of ["Tell MARA what to call you", "Pick the kind of business", "Choose your main marketing goal", "Pick at least one target customer", "Choose a publishing permission"]) {
    assert.match(wizard, new RegExp(message), `validation kept: ${message}`);
  }
  assert.doesNotMatch(wizard, /AnalyzingScreen|setTimeout/, "no timed fake-progress screen");
  assert.match(complete, /\/api\/voom\/workflow/, "the first-week list comes from the real plan");
  assert.doesNotMatch(complete, /Invite your team|seats|3 drafts/i, "no team seats or invented drafts");
  assert.doesNotMatch(complete + wizard, /\.(insert|update|upsert|delete)\(/, "setup screens never write directly");
});

test("public screens stay light and scoped; the workspace shell is untouched", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.voom-shell,\n\.voom-public \{/);
  assert.match(css, /:root\[data-theme="dark"\] \.voom-shell \{/);
  assert.doesNotMatch(css, /\[data-theme="dark"\] \.voom-public/, "no dark design exists for these screens");
  // Setup artwork: native-resolution crops of the reference panels (no stretched full-panel backgrounds).
  for (const art of ["voice", "mara", "audience", "business", "budget"]) {
    assert.ok(existsSync(new URL(`../public/redesign/setup-art-${art}.webp`, import.meta.url)), art);
  }
});

test("setup artwork is height-bounded between the sticky header and footer", async () => {
  const wizard = await code("components/voom/onboarding/OnboardingWizard.tsx");
  // The intro column is exactly the space between the 73px header (+40px padding)
  // and the 73px footer (+24px padding); the art flexes into what the text leaves.
  assert.match(wizard, /lg:sticky lg:top-\[112px\] lg:flex lg:h-\[calc\(100dvh-210px\)\]/);
  assert.match(wizard, /lg:pb-6 lg:pt-10/, "the bottom padding the column height accounts for");
  assert.match(wizard, /min-h-0 w-full max-w-\[360px\] flex-1 lg:block lg:max-h-\[300px\]/, "art shrinks with the space left, capped at 360×300");
  assert.match(wizard, /absolute inset-0 h-full w-full select-none object-contain/, "contained, never cropped or stretched");
});
