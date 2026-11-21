/**
 * Rendered markup for the login error (2026-11-21). These are the REAL LoginAlert
 * and LoginForm components, with only the Next runtime doubled.
 *
 * Only an unconfirmed-email failure links to /verify-email. That page asks for
 * the address again and always answers neutrally, so the link reveals nothing
 * about which addresses have accounts.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importApp,react,renderToStaticMarkup} from './helpers/rendered-surface.mjs';

const {createElement:h}=react;
const {LoginAlert}=await importApp('app/login/LoginAlert.tsx');
const {EMAIL_NOT_CONFIRMED_MESSAGE,INVALID_LOGIN_MESSAGE}=await importApp('app/login/messages.ts');
const {default:LoginForm}=await importApp('app/login/LoginForm.tsx');

test('an unconfirmed-email alert shows the message and links to the existing /verify-email page',()=>{
  const html=renderToStaticMarkup(h(LoginAlert,{message:EMAIL_NOT_CONFIRMED_MESSAGE,unconfirmed:true}));
  assert.match(html,/role="alert"/);
  assert.ok(html.includes('Please confirm your email address before logging in.'));
  assert.match(html,/<a href="\/verify-email"[^>]*>Send a new confirmation link<\/a>/);
});

test('an invalid-credentials alert is unchanged: generic message, no verify link',()=>{
  const html=renderToStaticMarkup(h(LoginAlert,{message:INVALID_LOGIN_MESSAGE}));
  assert.match(html,/role="alert"/);
  assert.ok(html.includes('Incorrect email or password.'));
  assert.doesNotMatch(html,/verify-email/);
});

test('a link-driven error on /login (for example ?error=confirm_failed) never gets the verify link',()=>{
  const html=renderToStaticMarkup(h(LoginForm,{initialError:'Your confirmation link is invalid or has expired.',googleEnabled:false}));
  assert.ok(html.includes('Your confirmation link is invalid or has expired.'));
  assert.doesNotMatch(html,/href="\/verify-email"/);
  assert.match(html,/href="\/forgot-password"/,'the Forgot password link is still there');
});

test('a clean login form shows no alert at all',()=>{
  const html=renderToStaticMarkup(h(LoginForm,{googleEnabled:false}));
  assert.doesNotMatch(html,/role="alert"/);
  assert.doesNotMatch(html,/verify-email/);
});
