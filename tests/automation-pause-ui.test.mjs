import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFrom,measureRenderedPages,RenderedSurfaceUnavailable,withClientBundle,importApp,react,renderToStaticMarkup} from './helpers/rendered-surface.mjs';
import {buildClientBundle} from './helpers/client-bundle.mjs';
const ui=await importApp('components/voom/automations/AutomationPauseControl.tsx');
const h=react.createElement;
const render=snapshot=>renderToStaticMarkup(h(ui.AutomationPauseProvider,{initialState:snapshot},h(ui.AutomationPauseControl),h(ui.AutomationPauseBanner,{timeZone:'Asia/Dubai'}),h(ui.AutomationPauseModeCard,{value:'Autopilot',confirmed:true})));
test('real paused markup shares one snapshot across the Resume button, banner and mode label',()=>{
 const html=render({pausedAt:'2026-11-26T05:00:00Z'});
 assert.match(html,/Resume automation/);assert.match(html,/Automation is paused/);assert.match(html,/Saved mode · paused/);
 assert.doesNotMatch(html,/Pause all<|Automation resumed/);assert.equal((html.match(/role="status"/g)||[]).length,1);
});
test('real running markup shows Pause all and no stale paused banner or mode label',()=>{
 const html=render({pausedAt:null});assert.match(html,/Pause all/);assert.match(html,/Current mode/);
 assert.doesNotMatch(html,/Resume automation|Automation is paused|Saved mode · paused/);
});
test('real unknown markup offers neither mutation button nor an invented running state',()=>{
 const html=render(null);assert.match(html,/Pause state unavailable/);assert.doesNotMatch(html,/Pause all|Resume automation|Current mode|Automation resumed/);
});
const bundle=buildClientBundle(`
 import {createRoot} from 'react-dom/client';import {createElement as h,useState} from 'react';
 import {AutomationPauseProvider,AutomationPauseControl,AutomationPauseBanner,AutomationPauseModeCard} from './components/voom/automations/AutomationPauseControl.tsx';
 function Test(){const [snapshot,setSnapshot]=useState({pausedAt:null});window.__setServer=setSnapshot;
 return h(AutomationPauseProvider,{initialState:snapshot},h(AutomationPauseControl),h(AutomationPauseBanner,{timeZone:'Asia/Dubai'}),h(AutomationPauseModeCard,{value:'Autopilot',confirmed:true}));}
 createRoot(document.getElementById('root')).render(h(Test));
`);
const html=withClientBundle(await documentFrom('<div id="root"></div>'),bundle);
test('rendered controls, banner and mode label follow confirmed pause/resume state without router refresh',async t=>{
 let result;try{[result]=await measureRenderedPages([{name:'automation-pause-state',html,width:1200,height:850,
 onDocumentStart:`window.__requests=[];window.fetch=async(url,init)=>{window.__requests.push({url,body:JSON.parse(init.body)});if(!['/api/automation/pause','/api/automation/resume'].includes(url))throw Error('Unexpected external request');return new Response(JSON.stringify(url.endsWith('/pause')?{pauseState:{pausedAt:'2026-11-26T05:00:00Z'},socialJobsStopped:{instagram:1,tiktok:0,youtube:0},lifecycleFlowsPaused:0}:{pauseState:{pausedAt:null},message:'Automation resumed for new work.'}),{headers:{'Content-Type':'application/json'}})};`,
 evaluate:`(async()=>{const wait=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20))}throw Error('UI did not settle')};const button=s=>[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===s);const status=()=>[...document.querySelectorAll('[role=status]')].map(e=>e.innerText);
 await wait(()=>button('Pause all'));button('Pause all').click();await wait(()=>button('Pause all automation'));button('Pause all automation').click();await wait(()=>button('Resume automation'));
 const afterPause={status:status(),mode:document.body.innerText.includes('Saved mode · paused')};button('Resume automation').click();await wait(()=>button('Yes, resume automation'));const resumeCopy=document.querySelector('[role=dialog]').innerText;button('Yes, resume automation').click();await wait(()=>button('Pause all'));
 const afterResume={status:status(),mode:document.body.innerText.includes('Current mode')};window.__setServer({pausedAt:'2026-11-26T06:00:00Z'});await wait(()=>button('Resume automation'));const afterServerPause=status();
 return{afterPause,afterResume,afterServerPause,resumeCopy,requests:window.__requests};})()`}]);}
 catch(e){if(e instanceof RenderedSurfaceUnavailable||/listen EPERM/.test(String(e))){t.skip(String(e));return}throw e}
 assert.equal(result.evaluateError,null,JSON.stringify(result));const v=result.evaluate;
 assert.equal(v.afterPause.status.length,1);assert.match(v.afterPause.status[0],/Automation paused/);assert.equal(v.afterPause.mode,true);
 assert.equal(v.afterResume.status.length,1);assert.match(v.afterResume.status[0],/Automation resumed/);assert.doesNotMatch(v.afterResume.status[0],/Automation (?:is )?paused/);assert.equal(v.afterResume.mode,true);
 assert.equal(v.afterServerPause.length,1);assert.match(v.afterServerPause[0],/Automation is paused/);assert.doesNotMatch(v.afterServerPause[0],/Automation resumed/);
 assert.match(v.resumeCopy,/explicitly approve again/);assert.doesNotMatch(v.resumeCopy,/reschedule them yourself/);
 assert.equal(v.requests.length,2);assert.equal(v.requests[1].body.confirm,true);assert.notEqual(v.requests[0].body.idempotencyKey,v.requests[1].body.idempotencyKey);
});
