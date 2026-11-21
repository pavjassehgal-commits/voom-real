/**
 * Rendered password inputs (auth security hardening, 2026-11-21). These are the
 * REAL signup and reset forms, with only the Next runtime doubled.
 *
 * No password input may carry a `maxlength`. A browser silently cuts a pasted
 * value to that length, so a long generated password would become a different,
 * shortened account password. Overlong passwords are refused on the server with
 * a clear message instead (tests/auth-password-policy.test.mjs). The browser
 * still asks for at least 8 characters.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importApp,react,renderToStaticMarkup} from './helpers/rendered-surface.mjs';

const {createElement:h}=react;
const {default:SignupForm}=await importApp('app/signup/SignupForm.tsx');
const {NewPasswordForm}=await importApp('components/voom/auth/AccountEmailForm.tsx');
const passwordInputs=html=>[...html.matchAll(/<input\b[^>]*>/g)].map(m=>m[0]).filter(tag=>/type="password"/.test(tag));

for(const [label,element] of [['signup',h(SignupForm,{googleEnabled:false})],['reset',h(NewPasswordForm)]]){
  test(`${label}: both password inputs render with minlength 8 and no maxlength`,()=>{
    const inputs=passwordInputs(renderToStaticMarkup(element));
    assert.equal(inputs.length,2,`${label} renders a password and a confirmation input`);
    for(const input of inputs){assert.doesNotMatch(input,/maxlength/i,input);assert.match(input,/minLength="8"|minlength="8"/,input);}
  });
}
