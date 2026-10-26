/** Synthetic, loopback-only real Chromium checks. No real APIs or credentials. */
import assert from "node:assert/strict";
import test from "node:test";
import { documentFrom, importApp, measureRenderedPages, react, withClientBundle } from "./helpers/rendered-surface.mjs";
import { buildClientBundle } from "./helpers/client-bundle.mjs";
const {renderToString}=await import("react-dom/server");
const {createElement:h}=react;
const {PlanWorkspace}=await importApp("components/voom/operating/PlanWorkspace.tsx");
const {LinkedInWorkspace}=await importApp("components/voom/linkedin/LinkedInWorkspace.tsx");
const {ModalProvider}=await importApp("lib/voom/modal.tsx");
const fixture=await importApp("tests/helpers/workspace-surfaces.tsx");
const DRAFT="33333333-3333-4333-8333-333333333333";
const item=fixture.planItem({draftId:DRAFT,channel:"linkedin",format:"text",channelLabel:"LinkedIn",contentType:"text",
  contentTypeLabel:"LinkedIn Text Post",concept:"A practical business lesson",caption:"A professional insight for business owners.",
  status:"planned",statusLabel:"Draft — explicit LinkedIn approval required",hasMedia:false,mediaFromMara:false,
  sourcePlanId:"synthetic-plan",sourcePlanItemKey:`${fixture.TODAY}|linkedin_text`,script:[],queueStatus:null});
const snapshot={...fixture.planSnapshot(),selectedChannels:["instagram","tiktok","youtube","linkedin"],items:[item]};
const props={initial:snapshot,channelReadiness:[{channel:"linkedin",connected:false,configured:true}]};
const connection={configured:true,connected:true,id:"44444444-4444-4444-8444-444444444444",memberSub:"synthetic-member",
  displayName:"Synthetic Reviewer",status:"connected",expiresAt:"2099-01-01T00:00:00Z"};
const draft={id:DRAFT,content:item.caption,status:"draft",content_version:1,proposed_publish_at:"2099-01-01T12:00:00Z"};

const bundle=buildClientBundle(`
 import {hydrateRoot} from 'react-dom/client';import {createElement as h} from 'react';
 import {PlanWorkspace} from './components/voom/operating/PlanWorkspace';
 import {LinkedInWorkspace} from './components/voom/linkedin/LinkedInWorkspace';
 import {ModalProvider} from './lib/voom/modal';
 hydrateRoot(document.getElementById('root'),window.__mode==='plan'?h(ModalProvider,null,h(PlanWorkspace,window.__props)):h(LinkedInWorkspace));
 window.__hydrated=true;
`);
function before(mode,connected=true){return `
 window.__mode=${JSON.stringify(mode)};window.__props=${JSON.stringify(props)};window.__requests=[];
 history.replaceState(null,'','?draft=${DRAFT}');
 window.fetch=async(input,init={})=>{
  const path=typeof input==='string'?input:input.url;window.__requests.push({path,method:init.method??'GET'});
  if(init.method&&init.method!=='GET')throw new Error('Writes are forbidden in this browser test');
  if(path==='/api/integrations/linkedin/status')return new Response(JSON.stringify({connection:${JSON.stringify({...connection,connected})}}),{headers:{'Content-Type':'application/json'}});
  if(path==='/api/integrations/linkedin/drafts?draft=${DRAFT}')return new Response(JSON.stringify({drafts:[${JSON.stringify(draft)}],queue:[]}),{headers:{'Content-Type':'application/json'}});
  throw new Error('Unexpected API request in isolated test');
 };
 `;}
async function html(mode){return withClientBundle(await documentFrom(renderToString(h('main',{id:'root',className:'min-w-0 p-4'},
  mode==='plan'?h(ModalProvider,null,h(PlanWorkspace,props)):h(LinkedInWorkspace)))),bundle);}

test("Marketing Plan shows disconnected LinkedIn text and opens the same draft for explicit review",async()=>{
 const page=await html('plan');
 const results=await measureRenderedPages([1440,320].map(width=>({name:`linkedin-plan-${width}`,html:page,width,height:width===320?640:900,
  onDocumentStart:before('plan'),screenshot:`/private/tmp/voom-linkedin-plan-${width}.png`,evaluate:`(async()=>{
   await new Promise(r=>setTimeout(r,200));
   const filter=document.getElementById('plan-channel');filter.value='linkedin';filter.dispatchEvent(new Event('change',{bubbles:true}));
   await new Promise(r=>setTimeout(r,50));
   const card=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('A practical business lesson'));
   card.click();await new Promise(r=>setTimeout(r,50));
   const dialog=document.querySelector('[role=dialog]');
   return {filter:filter.value,text:document.body.innerText,dialog:dialog?.innerText,
     href:dialog?.querySelector('a[href*="/app/linkedin?draft="]')?.getAttribute('href'),
     mediaButton:dialog?.innerText.includes('No video file'),writes:window.__requests.filter(r=>r.method!=='GET')};
 })()`})));
 for(const result of results){
  assert.equal(result.evaluateError,null,JSON.stringify(result.consoleMessages));
  assert.equal(result.evaluate.filter,'linkedin');assert.match(result.evaluate.text,/LinkedIn ideas can be planned while disconnected/);
  assert.match(result.evaluate.dialog,/Personal-profile text post/);assert.equal(result.evaluate.href,`/app/linkedin?draft=${DRAFT}`);
  assert.equal(result.evaluate.mediaButton,false);assert.deepEqual(result.evaluate.writes,[]);
  assert.ok(result.documentScrollWidth<=result.innerWidth+1,JSON.stringify(result.overflowing));
  assert.deepEqual(result.consoleMessages.filter(m=>m.level==='error'||m.level==='exception'),[]);
 }
});

test("LinkedIn draft deep link loads saved text and future time without implicitly granting consent",async()=>{
 const page=await html('linkedin');
 const results=await measureRenderedPages([true,false].map(connected=>({name:`linkedin-review-${connected}`,html:page,width:390,height:844,
  onDocumentStart:before('linkedin',connected),screenshot:`/private/tmp/voom-linkedin-review-${connected}.png`,evaluate:`(async()=>{
   await new Promise(r=>setTimeout(r,250));
   const approve=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Approve and'));
   const consent=document.querySelector('input[type=checkbox]');
   const initial={text:document.getElementById('linkedin-text').value,consent:consent.checked,disabled:approve.disabled,schedule:document.getElementById('linkedin-schedule').value};
   if(!consent.disabled){consent.click();await new Promise(r=>setTimeout(r,50));}
   return {initial,enabledAfterConsent:!approve.disabled,body:document.body.innerText,writes:window.__requests.filter(r=>r.method!=='GET')};
 })()`})));
 for(const [index,result] of results.entries()){
  assert.equal(result.evaluateError,null,JSON.stringify(result.consoleMessages));
  assert.equal(result.evaluate.initial.text,draft.content);assert.equal(result.evaluate.initial.consent,false);
  assert.equal(result.evaluate.initial.disabled,true);assert.match(result.evaluate.initial.schedule,/2099-01-01/);
  assert.equal(result.evaluate.enabledAfterConsent,index===0);assert.deepEqual(result.evaluate.writes,[]);
  if(index===1)assert.match(result.evaluate.body,/Connect or reconnect LinkedIn before approving/);
  assert.ok(result.documentScrollWidth<=result.innerWidth+1,JSON.stringify(result.overflowing));
  assert.deepEqual(result.consoleMessages.filter(m=>m.level==='error'||m.level==='exception'),[]);
 }
});
