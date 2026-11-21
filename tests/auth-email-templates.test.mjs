/**
 * Supabase Auth email templates (2026-11-21; no support mailbox, by owner decision).
 *
 * The committed templates in supabase/templates/voom-auth (Production) and
 * voom-auth-staging must equal what lib/transactional-email/auth-templates.ts
 * renders, so the files can never drift from their source.
 *
 * All of them are sent from the no-reply sender, so none names a contact
 * address or invites a reply. The password-changed notification points only to
 * the forgot-password flow. There is deliberately no email-changed template:
 * Supabase recovers accounts by their current address only, so the old address
 * that receives that notice could not recover the account. Without a safe path
 * to offer, that notification stays disabled.
 */
import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {test} from 'node:test';
const {voomAuthTemplates,renderVoomAuthTemplate,TEMPLATE_ASSET_SITE}=await import('../lib/transactional-email/auth-templates.ts');
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const ENVIRONMENTS=[['voom-auth','https://voom.today'],['voom-auth-staging','http://localhost:3000']];
const NAMES=['confirmation','recovery','password-changed'];
const files={};
for(const [dir] of ENVIRONMENTS)for(const name of NAMES)files[`${dir}/${name}`]=await read(`supabase/templates/${dir}/${name}.html`);
const hrefs=html=>[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

test('every committed template is exactly what the shared source renders, in both environments',()=>{
  for(const [dir,app] of ENVIRONMENTS){
    const rendered=voomAuthTemplates(app);
    assert.deepEqual(rendered.map(t=>t.name),NAMES);
    for(const template of rendered)assert.equal(files[`${dir}/${template.name}`],renderVoomAuthTemplate(template),`${dir}/${template.name} drifted; run scripts/prepare-voom-auth-emails.mjs`);
  }
});
test('each template folder holds exactly these three files: no email-changed template exists',async()=>{
  for(const [dir] of ENVIRONMENTS){
    const listed=(await readdir(new URL(`../supabase/templates/${dir}/`,import.meta.url))).filter(f=>f.endsWith('.html')).sort();
    assert.deepEqual(listed,['confirmation.html','password-changed.html','recovery.html'],dir);
  }
});
test('staging and Production differ only in the app origin',()=>{
  for(const name of NAMES)assert.equal(files[`voom-auth-staging/${name}`].replaceAll('http://localhost:3000','https://voom.today'),files[`voom-auth/${name}`],name);
  for(const name of NAMES)assert.doesNotMatch(files[`voom-auth/${name}`],/localhost/,`Production ${name} never links to localhost`);
});
test('no template names any email address or mailto link: no support inbox, and no-reply is never offered as a contact',()=>{
  for(const [key,html] of Object.entries(files)){
    assert.doesNotMatch(html,EMAIL,key);
    assert.doesNotMatch(html,/mailto:/i,key);
    assert.doesNotMatch(html,/support@|contact (us|voom)/i,key);
  }
});
test('password-changed: short, says replies are not read, and points only to the forgot-password flow',()=>{
  for(const [dir,app] of ENVIRONMENTS){
    const html=files[`${dir}/password-changed`],t=text(html);
    assert.deepEqual(hrefs(html),[`${app}/forgot-password`,`${app}/forgot-password`,`${TEMPLATE_ASSET_SITE}/privacy`]);
    assert.match(t,/Your Voom password was changed/);
    assert.match(t,/If you made this change, you don't need to do anything\./);
    assert.match(t,/If you didn't, reset your password now with the button below; resetting signs you out on every device\./);
    assert.match(t,/Replies to this email aren't read\./);
    assert.match(t,/Reset your password/);
    assert.doesNotMatch(html,/\{\{/,'needs no per-user data');
  }
  const message=voomAuthTemplates('https://voom.today').find(t=>t.name==='password-changed').message;
  assert.ok(message.length<=260,`message stays short (${message.length})`);
});
test('the reset the notice promises really signs out every session (no misleading recovery instruction)',async()=>{
  const actions=await read('app/forgot-password/actions.ts');
  assert.match(actions,/signOut\(\{ scope: "global" \}\)/);
  assert.match(actions,/resetPasswordForEmail/);
});
test('images come only from voom.today; every link is the app, the privacy page or a token_hash page',()=>{
  for(const [dir,app] of ENVIRONMENTS)for(const name of NAMES){
    const html=files[`${dir}/${name}`];
    for(const src of [...html.matchAll(/src="([^"]+)"/g)].map(m=>m[1]))assert.ok(src.startsWith('https://voom.today/'),`${dir}/${name} image ${src}`);
    for(const href of hrefs(html))assert.ok(href.startsWith(`${app}/`)||href===`${TEMPLATE_ASSET_SITE}/privacy`,`${dir}/${name} link ${href}`);
  }
});
test('confirmation and recovery keep their token_hash links and their exact wording',()=>{
  for(const [dir,app] of ENVIRONMENTS){
    assert.ok(files[`${dir}/confirmation`].includes(`href="${app}/auth/confirm?token_hash={{ .TokenHash }}"`));
    assert.ok(files[`${dir}/recovery`].includes(`href="${app}/auth/recovery?token_hash={{ .TokenHash }}"`));
  }
  assert.match(text(files['voom-auth/confirmation']),/Confirm your email address to finish creating your Voom account\./);
  assert.match(text(files['voom-auth/recovery']),/You requested a password reset\./);
});
test('the email-changed blocker is documented in the source, the script and the rollout plan; the legal contact is untouched',async()=>{
  const source=await read('lib/transactional-email/auth-templates.ts');
  assert.match(source,/email-changed: deliberately NOT provided/);assert.match(source,/must stay\s+\*?\s*disabled/);
  assert.doesNotMatch(source,/support@voom\.today/);
  assert.match(await read('scripts/prepare-voom-auth-emails.mjs'),/NO email-changed template/);
  const plan=await read('docs/auth-security-hardening.md');
  assert.match(plan,/email-changed notification: blocked/i);
  assert.doesNotMatch(plan,/support@voom\.today/,'the plan no longer depends on a support mailbox');
  assert.doesNotMatch(await read('lib/legal/contact.ts'),/support@voom\.today/);
});
