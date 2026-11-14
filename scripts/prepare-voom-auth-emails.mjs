// Deterministic local templates only. Never contacts Supabase/Resend or reads credentials.
// Production (default): node --import ./tests/helpers/server-only-shim.mjs scripts/prepare-voom-auth-emails.mjs
// Staging:             node --import ./tests/helpers/server-only-shim.mjs scripts/prepare-voom-auth-emails.mjs --app http://localhost:3000 --out voom-auth-staging
//
// Confirmation and recovery links carry {{ .TokenHash }} to the app's own page, which verifies it
// only when the person presses the button (mail scanners that prefetch links cannot use it up) and
// needs no PKCE verifier, so the link works in any browser or device. --app must be the exact origin
// of the environment's app; images and the privacy link always come from https://voom.today.
import {mkdir,writeFile} from 'node:fs/promises';
import {emailDocument} from '../lib/transactional-email/core.ts';
const arg=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
const app=new URL(arg('--app')??'https://voom.today').origin;
const out=arg('--out')??'voom-auth';
if(!/^voom-auth(-[a-z]+)?$/.test(out))throw new Error('unexpected output folder');
const directory=new URL(`../supabase/templates/${out}/`,import.meta.url);
await mkdir(directory,{recursive:true});
export const templates=[
  ['confirmation','Confirm your Voom account','Confirm your email address to finish creating your Voom account. If you did not request this, ignore this email.','Confirm email',`${app}/auth/confirm?token_hash={{ .TokenHash }}`],
  ['recovery','Reset your Voom password','You requested a password reset. Continue to choose a new password. If you did not request this, ignore this email; your password has not changed.','Reset password',`${app}/auth/recovery?token_hash={{ .TokenHash }}`],
  ['password-changed','Your Voom password changed','Your account password was changed. If this was not you, request a new reset link and contact no-reply@voom.today.','Secure your account',`${app}/forgot-password`],
  ['email-changed','Your Voom email address changed','Your account email address was changed. If this was not you, contact no-reply@voom.today for help.','Contact Voom','mailto:no-reply@voom.today'],
];
for(const [name,title,message,label,url] of templates)await writeFile(new URL(name+'.html',directory),emailDocument(title,message,label,url,'https://voom.today'));
console.log(`Prepared four local VOOM Auth templates for ${app} in supabase/templates/${out}; no remote settings or emails changed.`);
