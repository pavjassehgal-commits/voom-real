import test from 'node:test';
import assert from 'node:assert/strict';
import {automationPauseUiReducer as reduce} from '../lib/voom/automation-pause-ui.ts';
const running={pausedAt:null},paused={pausedAt:'2026-11-26T05:00:00Z'};
const initial=snapshot=>({snapshot,notice:null});
test('successful Pause and Resume snapshots change button/banner state without waiting for a route refresh',()=>{
 let state=reduce(initial(running),{type:'confirmed',snapshot:paused,paused:true,text:'Automation paused.'});
 assert.equal(state.snapshot.pausedAt,paused.pausedAt);assert.equal(state.notice.paused,true);
 state=reduce(state,{type:'confirmed',snapshot:running,paused:false,text:'Automation resumed.'});
 assert.equal(state.snapshot.pausedAt,null);assert.deepEqual(state.notice,{paused:false,text:'Automation resumed.'});
});
test('a newer server pause clears a resumed notice and a server resume clears a paused notice',()=>{
 let state=reduce(initial(running),{type:'confirmed',snapshot:running,paused:false,text:'Automation resumed.'});
 state=reduce(state,{type:'server',snapshot:paused});assert.equal(state.notice,null);assert.deepEqual(state.snapshot,paused);
 state=reduce(state,{type:'confirmed',snapshot:paused,paused:true,text:'Automation paused.'});
 state=reduce(state,{type:'server',snapshot:running});assert.equal(state.notice,null);assert.deepEqual(state.snapshot,running);
});
test('the actual server state wins when a concurrent change contradicts the operation acknowledgement',()=>{
 for(const action of [{type:'confirmed',snapshot:paused,paused:false,text:'Automation resumed.'},{type:'confirmed',snapshot:running,paused:true,text:'Automation paused.'}]){
  const state=reduce(initial(running),action);assert.equal(state.notice,null);assert.deepEqual(state.snapshot,action.snapshot);
 }
});
test('unavailable state clears stale success instead of guessing running, and a later server snapshot recovers',()=>{
 const state=reduce({snapshot:paused,notice:{paused:true,text:'Automation paused.'}},{type:'server',snapshot:null});
 assert.deepEqual(state,initial(null));assert.deepEqual(reduce(state,{type:'server',snapshot:running}),initial(running));
});
