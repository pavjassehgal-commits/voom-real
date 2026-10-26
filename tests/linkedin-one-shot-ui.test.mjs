import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClientBundle } from './helpers/client-bundle.mjs';
import { documentFrom, measureRenderedPages, withClientBundle } from './helpers/rendered-surface.mjs';

// Real component in an isolated Chromium context. Every request is a local
// fixture; no credentials, databases or external providers are available.
const bundle=buildClientBundle(`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {LinkedInWorkspace} from '@/components/voom/linkedin/LinkedInWorkspace';
const id='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const now=new Date(Date.now()-1000).toISOString();
const connection={configured:true,connected:true,id,memberSub:'synthetic_member',displayName:'Synthetic Test Profile',status:'connected',expiresAt:'2030-01-01T00:00:00Z'};
const drafts=[{id,content:'ONLY THIS PUBLIC TEST POST',status:'draft',content_version:1,proposed_publish_at:null},
 {id:other,content:'UNRELATED — MUST NOT PUBLISH',status:'approved',content_version:2,proposed_publish_at:now}];
const queue=[{id:other,draft_id:other,approved_content_version:2,status:'scheduled',scheduled_at:now,next_attempt_at:now,provider_ref:null,failure_code:null,attempts:0}];
window.__requests=[];window.__confirmations=[];window.__accept=false;
window.confirm=(message)=>{window.__confirmations.push(message);return window.__accept;};
window.fetch=async(url,init={})=>{
 const path=String(url);const method=init.method||'GET';const body=init.body?JSON.parse(init.body):null;
 if(!path.startsWith('/api/integrations/linkedin/'))throw new Error('External requests forbidden');
 window.__requests.push({path,method,body});
 if(path.endsWith('/status'))return Response.json({connection,oneShotPublishingAvailable:true});
 if(path.endsWith('/drafts')&&method==='GET')return Response.json({drafts,queue});
 if(path.endsWith('/'+id)&&method==='PATCH'&&body.action==='approve'){
  drafts[0].status='approved';drafts[0].content_version=2;drafts[0].proposed_publish_at=now;
  queue.push({id,draft_id:id,approved_content_version:2,status:'scheduled',scheduled_at:now,next_attempt_at:now,provider_ref:null,failure_code:null,attempts:0});
  return Response.json({message:'Approved. Nothing published.'});
 }
 if(path.endsWith('/'+id+'/publish')&&method==='POST'){
  const row=queue.find(q=>q.draft_id===id);row.status='published';row.provider_ref='urn:li:share:123';
  return Response.json({outcome:'published',message:'SYNTHETIC RESULT: only the selected post was processed.'});
 }
 throw new Error('Unexpected fixture request');
};
createRoot(document.getElementById('root')).render(createElement(LinkedInWorkspace));
`);

test('browser: approval alone never publishes; final cancellation is inert; confirmation targets only the selected post',async()=>{
  const html=withClientBundle(await documentFrom('<main class="voom-shell min-h-screen bg-bg p-4 text-text"><p>SYNTHETIC TEST — no real publishing</p><div id="root"></div></main>'),bundle);
  const evaluate=`(async()=>{
    const wait=()=>new Promise(r=>setTimeout(r,80));
    const button=(text)=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
    const submits=()=>window.__requests.filter(r=>r.path.endsWith('/publish'));
    await wait();
    const initialDisabled=button('Publish this one approved post').disabled;
    button('ONLY THIS PUBLIC TEST POST').click();await wait();
    const unapprovedDisabled=button('Publish this one approved post').disabled;
    document.querySelector('input[type=checkbox]').click();await wait();
    button('Approve for manual posting').click();await wait();await wait();
    const afterApproval={sends:submits().length,enabled:!button('Publish this one approved post').disabled};
    button('Publish this one approved post').click();await wait();
    const cancelled={sends:submits().length,confirmation:window.__confirmations.at(-1)};
    window.__accept=true;button('Publish this one approved post').click();await wait();await wait();
    return {title:document.title,initialDisabled,unapprovedDisabled,afterApproval,cancelled,
      requests:submits(),disabledAfter:button('Publish this one approved post').disabled,
      unrelatedStatus:document.querySelectorAll('li')[1].innerText,
      overflow:document.documentElement.scrollWidth>innerWidth,alert:document.querySelector('[role=alert]')?.textContent??null};
  })()`;
  const results=await measureRenderedPages([
    {name:'short-desktop',width:1366,height:600,html,evaluate,screenshot:process.env.VOOM_ONE_SHOT_SCREENSHOT_DIR?process.env.VOOM_ONE_SHOT_SCREENSHOT_DIR+'/linkedin-one-shot-desktop.png':undefined},
    {name:'mobile',width:320,height:640,html,evaluate,screenshot:process.env.VOOM_ONE_SHOT_SCREENSHOT_DIR?process.env.VOOM_ONE_SHOT_SCREENSHOT_DIR+'/linkedin-one-shot-mobile.png':undefined},
  ]);
  for(const row of results){
    assert.equal(row.evaluateError,null);const r=row.evaluate;
    assert.equal(r.initialDisabled,true);assert.equal(r.unapprovedDisabled,true);
    assert.deepEqual(r.afterApproval,{sends:0,enabled:true});assert.equal(r.cancelled.sends,0);
    assert.match(r.cancelled.confirmation,/ONE approved post PUBLICLY/);assert.match(r.cancelled.confirmation,/ONLY THIS PUBLIC TEST POST/);
    assert.equal(r.requests.length,1);assert.match(r.requests[0].path,/11111111-1111-4111-8111-111111111111\/publish$/);
    assert.deepEqual(r.requests[0].body,{queueId:'11111111-1111-4111-8111-111111111111',version:2,connectionId:'11111111-1111-4111-8111-111111111111',memberSub:'synthetic_member',confirmed:true,visibility:'PUBLIC'});
    assert.equal(r.disabledAfter,true);assert.match(r.unrelatedStatus,/Scheduled/);assert.equal(r.alert,null);
    assert.equal(r.overflow,false);assert.ok(row.documentScrollWidth<=row.innerWidth,'no horizontal overflow (vertical scrollbar may reduce client width)');
    assert.deepEqual(row.consoleMessages.filter(m=>['error','exception'].includes(m.level)),[]);
  }
});
