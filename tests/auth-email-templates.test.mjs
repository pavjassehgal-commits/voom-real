/**
 * Supabase Auth email templates (auth security hardening, 2026-11-21).
 *
 * The four committed templates in supabase/templates/voom-auth (Production) and
 * voom-auth-staging must equal what lib/transactional-email/auth-templates.ts
 * renders, so the files can never drift from their source. The password-changed
 * and email-changed notifications point people at the PLANNED support address
 * (support@voom.today, not yet verified), never at a no-reply sender, and link
 * only to the app's own pages, the privacy page and that mailbox.
 */
import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const {voomAuthTemplates,renderVoomAuthTemplate,PLANNED_SUPPORT_EMAIL,TEMPLATE_ASSET_SITE}=await import('../lib/transactional-email/auth-templates.ts');
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const ENVIRONMENTS=[['voom-auth','https://voom.today'],['voom-auth-staging','http://localhost:3000']];
const NAMES=['confirmation','recovery','password-changed','email-changed'];
const NOTIFICATIONS=['password-changed','email-changed'];
const files={};
for(const [dir] of ENVIRONMENTS)for(const name of NAMES)files[`${dir}/${name}`]=await read(`supabase/templates/${dir}/${name}.html`);
const hrefs=html=>[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const emails=html=>[...new Set(html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[])];

test('every committed template is exactly what the shared source renders, in both environments',()=>{
  for(const [dir,app] of ENVIRONMENTS){
    const rendered=voomAuthTemplates(app);
    assert.deepEqual(rendered.map(t=>t.name),NAMES);
    for(const template of rendered)assert.equal(files[`${dir}/${template.name}`],renderVoomAuthTemplate(template),`${dir}/${template.name} drifted; run scripts/prepare-voom-auth-emails.mjs`);
  }
});
test('staging and Production differ only in the app origin',()=>{
  for(const name of NAMES)assert.equal(files[`voom-auth-staging/${name}`].replaceAll('http://localhost:3000','https://voom.today'),files[`voom-auth/${name}`],name);
  for(const name of NAMES)assert.doesNotMatch(files[`voom-auth/${name}`],/localhost/,`Production ${name} never links to localhost`);
});
test('no template names a no-reply address as a place to get help',()=>{
  for(const [key,html] of Object.entries(files))assert.doesNotMatch(html,/no-?reply@/i,key);
});
test('notification templates name exactly one address: the planned support mailbox',()=>{
  assert.equal(PLANNED_SUPPORT_EMAIL,'support@voom.today');
  for(const [dir] of ENVIRONMENTS)for(const name of NOTIFICATIONS){
    const html=files[`${dir}/${name}`];
    assert.deepEqual(emails(html),[PLANNED_SUPPORT_EMAIL],`${dir}/${name}`);
    assert.ok(text(html).includes(`contact Voom support`),`${dir}/${name} tells people who to contact`);
  }
});
test('notification links go only to the app, the privacy page and the support mailbox; images only to voom.today',()=>{
  for(const [dir,app] of ENVIRONMENTS){
    assert.deepEqual(hrefs(files[`${dir}/password-changed`]),[`${app}/forgot-password`,`${app}/forgot-password`,`${TEMPLATE_ASSET_SITE}/privacy`]);
    assert.deepEqual(hrefs(files[`${dir}/email-changed`]),[`mailto:${PLANNED_SUPPORT_EMAIL}`,`mailto:${PLANNED_SUPPORT_EMAIL}`,`${TEMPLATE_ASSET_SITE}/privacy`]);
    for(const name of NAMES){
      const html=files[`${dir}/${name}`];
      for(const src of [...html.matchAll(/src="([^"]+)"/g)].map(m=>m[1]))assert.ok(src.startsWith('https://voom.today/'),`${dir}/${name} image ${src}`);
      for(const href of hrefs(html))assert.ok(href.startsWith(`${app}/`)||href.startsWith('https://voom.today/')||href===`mailto:${PLANNED_SUPPORT_EMAIL}`,`${dir}/${name} link ${href}`);
    }
  }
});
test('notifications are short and clear, and carry no Supabase placeholders',()=>{
  const pw=text(files['voom-auth/password-changed']),em=text(files['voom-auth/email-changed']);
  assert.match(pw,/Your Voom password was changed/);assert.match(pw,/If you made this change, you don't need to do anything\./);assert.match(pw,/reset your password now/);assert.match(pw,/Reset your password/);
  assert.match(em,/Your Voom email address was changed/);assert.match(em,/If you made this change, you don't need to do anything\./);assert.match(em,/right away/);assert.match(em,/Contact Voom support/);
  for(const t of voomAuthTemplates('https://voom.today').filter(t=>NOTIFICATIONS.includes(t.name)))assert.ok(t.message.length<=220,`${t.name} message stays short (${t.message.length})`);
  for(const name of NOTIFICATIONS)assert.doesNotMatch(files[`voom-auth/${name}`],/\{\{/,'notifications need no per-user data');
});
test('confirmation and recovery keep their token_hash links and their exact wording',()=>{
  for(const [dir,app] of ENVIRONMENTS){
    assert.ok(files[`${dir}/confirmation`].includes(`href="${app}/auth/confirm?token_hash={{ .TokenHash }}"`));
    assert.ok(files[`${dir}/recovery`].includes(`href="${app}/auth/recovery?token_hash={{ .TokenHash }}"`));
  }
  assert.match(text(files['voom-auth/confirmation']),/Confirm your email address to finish creating your Voom account\./);
  assert.match(text(files['voom-auth/recovery']),/You requested a password reset\./);
});
test('the planned address is documented as unverified, and the legal contact is untouched',async()=>{
  const source=await read('lib/transactional-email/auth-templates.ts');
  assert.match(source,/NOT YET VERIFIED/);assert.match(source,/MUST NOT be installed in Supabase/);
  assert.match(await read('scripts/prepare-voom-auth-emails.mjs'),/NOT YET VERIFIED/);
  assert.doesNotMatch(await read('lib/legal/contact.ts'),/support@voom\.today/,'this task does not change the public legal contact');
});
