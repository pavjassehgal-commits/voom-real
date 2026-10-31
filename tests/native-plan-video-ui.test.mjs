/** Real components in loopback-only Chromium, all requests answered by synthetic fakes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {documentFrom,importApp,measureRenderedPages,react,withClientBundle} from './helpers/rendered-surface.mjs';
import {buildClientBundle} from './helpers/client-bundle.mjs';
const {renderToString}=await import('react-dom/server');
const {createElement:h}=react;
const {PlanItemCard}=await importApp('components/voom/operating/PlanItemCard.tsx');
const {ModalProvider}=await importApp('lib/voom/modal.tsx');
const fixture=await importApp('tests/helpers/workspace-surfaces.tsx');
const ID='33333333-3333-4333-8333-333333333333';
function item(channel='tiktok',format='video',extra={}) {
  return fixture.planItem({draftId:ID,channel,format,contentType:format,contentTypeLabel:channel==='tiktok'?'TikTok Video':'YouTube Short',
    sourcePlanId:'synthetic-plan',sourcePlanItemKey:`${fixture.TODAY}|${channel}_${format}`,concept:'Original native video concept',
    caption:'Original caption #original',script:['Existing script'],status:'planned',statusLabel:'Awaiting generation',hasMedia:false,
    mediaStatus:null,queueStatus:null,canGenerateNativeVideo:true,...extra});
}
const bundle=buildClientBundle(`
 import {hydrateRoot} from 'react-dom/client';import {createElement as h,useState} from 'react';
 import {PlanItemCard} from './components/voom/operating/PlanItemCard';import {ModalProvider} from './lib/voom/modal';
 function Test(){const [item,setItem]=useState(window.__item);return h(ModalProvider,null,h('ul',null,h(PlanItemCard,{item,mode:'manual',timeZone:'UTC',onChanged:s=>setItem(s.items[0])})));}
 hydrateRoot(document.getElementById('root'),h(Test));
`);
async function html(initial) {return withClientBundle(await documentFrom(renderToString(h('main',{id:'root',className:'min-w-0 p-4'},
  h(ModalProvider,null,h('ul',null,h(PlanItemCard,{item:initial,mode:'manual',timeZone:'UTC',onChanged:()=>{}})))))),bundle);}
function setup(initial,{ambiguous=false}={}) {return `
 window.__item=${JSON.stringify(initial)};window.__requests=[];window.__stage='idle';window.__attempt=0;
 const realInterval=window.setInterval;window.setInterval=(fn,ms)=>realInterval(fn,ms===8000?100:ms);
 window.fetch=async(path,init={})=>{
   window.__requests.push({path,method:init.method??'GET',body:init.body?JSON.parse(init.body):null});
   const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
   if(path==='/api/social-drafts/${ID}/generation'){
     if(init.method==='POST'){
       window.__attempt++;
       if(${ambiguous}&&window.__attempt===1)throw new Error('Synthetic network interruption');
       window.__stage='running';return json({generation:{status:'generating'},message:'Generating. Nothing was approved or queued.'});
     }
     window.__stage='done';return json({generation:{status:'completed'}});
   }
   if(path==='/api/plan')return json({snapshot:{items:[{...window.__item,
     mediaStatus:window.__stage==='done'?'completed':window.__stage==='running'?'generating':null,
     status:window.__stage==='done'?'ready_for_review':window.__stage==='running'?'generating_media':'planned',
     statusLabel:window.__stage==='done'?'Ready for review':'MARA is generating',
     hasMedia:window.__stage==='done',mediaPreviewUrl:window.__stage==='done'?'data:video/mp4;base64,AAAAAGZ0eXBpc29t':null}]}});
   throw new Error('Unexpected request blocked in synthetic browser test: '+path);
 };
 `;}
const run=async(initial,evaluate,width=320,options={})=>(await measureRenderedPages([{name:`native-video-${initial.channel}-${width}`,html:await html(initial),width,height:width===320?640:900,
  onDocumentStart:setup(initial,options),screenshot:`/private/tmp/voom-native-video-${initial.channel}-${width}.png`,evaluate}]))[0];
function healthy(result){assert.equal(result.evaluateError,null,JSON.stringify(result));assert.ok(result.documentScrollWidth<=result.innerWidth+1,JSON.stringify(result.overflowing));
  assert.deepEqual(result.consoleMessages.filter(m=>m.level==='error'||m.level==='exception'),[]);}
for(const [channel,format,width] of [['tiktok','video',320],['youtube','short',1440]])test(`${channel}: real Generate control sends exact UUID; pending disables; completion shows private preview and review`,async()=>{
  const result=await run(item(channel,format),`(async()=>{
    await new Promise(r=>setTimeout(r,150));
    const generate=()=>[...document.querySelectorAll('button')].find(b=>/Generate|generating|Starting/.test(b.innerText));
    const label=generate().innerText;generate().click();generate().click();
    await new Promise(r=>setTimeout(r,60));const pending=generate().disabled;
    await new Promise(r=>setTimeout(r,350));
    const video=document.querySelector('video');
    return {label,pending,requests:window.__requests,preview:!!video,controls:video?.controls,inline:video?.playsInline,text:document.body.innerText};
  })()`,width);
  healthy(result);const value=result.evaluate;assert.match(value.label,/Generate with MARA.*40 credits/);assert.equal(value.pending,true);
  const writes=value.requests.filter(r=>r.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].path,`/api/social-drafts/${ID}/generation`);
  assert.match(writes[0].body.token,/^[0-9a-f-]{36}$/);assert.equal(value.preview,true);assert.equal(value.controls,true);assert.equal(value.inline,true);
  assert.match(value.text,/Ready for review/);assert.ok(value.requests.every(r=>r.path==='/api/plan'||r.path.endsWith('/generation')));
});
test('network-ambiguous retry retains the click token, never invents a second operation',async()=>{
  const result=await run(item(),`(async()=>{
    await new Promise(r=>setTimeout(r,150));const button=()=>[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Generate with'));
    button().click();await new Promise(r=>setTimeout(r,80));const error=document.querySelector('[role=alert]')?.innerText;
    button().click();await new Promise(r=>setTimeout(r,80));return {error,tokens:window.__requests.filter(r=>r.method==='POST').map(r=>r.body.token)};
  })()`,320,{ambiguous:true});healthy(result);assert.match(result.evaluate.error,/Synthetic network/);assert.equal(result.evaluate.tokens.length,2);assert.equal(result.evaluate.tokens[0],result.evaluate.tokens[1]);
});
test('Free and provider-owned drafts explain disabled generation; long-form and LinkedIn have no new generation control',async()=>{
  for(const initial of [item('tiktok','video',{canGenerateNativeVideo:false}),item('youtube','short',{queueStatus:'uploading'}),item('youtube','video'),item('linkedin','text')]){
    const result=await run(initial,`(async()=>{await new Promise(r=>setTimeout(r,150));const b=[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Generate'));return {exists:!!b,disabled:b?.disabled,text:document.body.innerText,requests:window.__requests};})()`);
    healthy(result);assert.deepEqual(result.evaluate.requests,[]);
    if(initial.format==='text'||initial.format==='video'&&initial.channel==='youtube')assert.equal(result.evaluate.exists,false);
    else {assert.equal(result.evaluate.disabled,true);assert.match(result.evaluate.text,initial.canGenerateNativeVideo===false?/Upgrade to Pro or Max/:/already with the platform/);}
  }
});
