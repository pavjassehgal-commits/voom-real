// Deterministic local templates only. Never contacts Supabase/Resend or reads credentials.
// Production (default): node --import ./tests/helpers/server-only-shim.mjs scripts/prepare-voom-auth-emails.mjs
// Staging:             node --import ./tests/helpers/server-only-shim.mjs scripts/prepare-voom-auth-emails.mjs --app http://localhost:3000 --out voom-auth-staging
//
// Confirmation and recovery links carry {{ .TokenHash }} to the app's own page, which verifies it
// only when the person presses the button (mail scanners that prefetch links cannot use it up) and
// needs no PKCE verifier, so the link works in any browser or device. --app must be the exact origin
// of the environment's app; images and the privacy link always come from https://voom.today.
//
// The wording lives in lib/transactional-email/auth-templates.ts. Its PLANNED_SUPPORT_EMAIL
// (support@voom.today) is NOT YET VERIFIED: do not install or enable the password-changed or
// email-changed notifications in Supabase until that mailbox exists and has been tested.
import {mkdir,writeFile} from 'node:fs/promises';
import {renderVoomAuthTemplate,voomAuthTemplates} from '../lib/transactional-email/auth-templates.ts';
const arg=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
const app=new URL(arg('--app')??'https://voom.today').origin;
const out=arg('--out')??'voom-auth';
if(!/^voom-auth(-[a-z]+)?$/.test(out))throw new Error('unexpected output folder');
const directory=new URL(`../supabase/templates/${out}/`,import.meta.url);
await mkdir(directory,{recursive:true});
for(const template of voomAuthTemplates(app))await writeFile(new URL(template.name+'.html',directory),renderVoomAuthTemplate(template));
console.log(`Prepared four local VOOM Auth templates for ${app} in supabase/templates/${out}; no remote settings or emails changed.`);
