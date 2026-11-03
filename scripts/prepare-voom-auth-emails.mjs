// Deterministic local templates only. Never contacts Supabase/Resend or reads credentials.
// node --import ./tests/helpers/server-only-shim.mjs scripts/prepare-voom-auth-emails.mjs
import {mkdir,writeFile} from 'node:fs/promises';
import {emailDocument} from '../lib/transactional-email/core.ts';
const directory=new URL('../supabase/templates/voom-auth/',import.meta.url);
await mkdir(directory,{recursive:true});
const templates=[
  ['confirmation','Confirm your Voom account','Confirm your email address to finish creating your Voom account. If you did not request this, ignore this email.','Confirm email','{{ .ConfirmationURL }}'],
  ['recovery','Reset your Voom password','You requested a password reset. Continue to choose a new password. If you did not request this, ignore this email; your password has not changed.','Reset password','https://voom.today/auth/recovery?token_hash={{ .TokenHash }}'],
  ['password-changed','Your Voom password changed','Your account password was changed. If this was not you, request a new reset link and contact no-reply@voom.today.','Secure your account','https://voom.today/forgot-password'],
  ['email-changed','Your Voom email address changed','Your account email address was changed. If this was not you, contact no-reply@voom.today for help.','Contact Voom','mailto:no-reply@voom.today'],
];
for(const [name,title,message,label,url] of templates)await writeFile(new URL(name+'.html',directory),emailDocument(title,message,label,url,'https://voom.today'));
console.log('Prepared four local VOOM Auth templates; no remote settings or emails changed.');
