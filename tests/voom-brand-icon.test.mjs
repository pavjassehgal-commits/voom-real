import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {VOOM_APP_ICON} from '../lib/voom/brand-assets.ts';
const read = p => readFile(new URL('../'+p,import.meta.url));
const original = await read('public'+VOOM_APP_ICON);
test('canonical source is the unchanged solid-white 1024px TikTok icon',async()=>{
  assert.equal(createHash('sha256').update(original).digest('hex'),'e73c1c43f3eaf724e2b9016b35693874908dd7087f1fac99bf808188ac0c20be');
  const meta=await sharp(original).metadata();assert.equal(meta.width,1024);assert.equal(meta.height,1024);
  const {data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([...data.subarray(0,4)],[255,255,255,255]);
  for(let i=3;i<data.length;i+=info.channels)assert.equal(data[i],255);
});
test('modern and Apple icons are exact resizes, not different artwork',async()=>{
  for(const [path,size] of [['app/icon.png',64],['app/apple-icon.png',180]]){
    const actual=await read(path),meta=await sharp(actual).metadata();
    assert.equal(meta.width,size);assert.equal(meta.height,size);
    assert.deepEqual(actual,await sharp(original).resize(size,size).png().toBuffer());
  }
});
test('legacy favicon contains only matching, decodable official-icon frames',async()=>{
  const ico=await read('app/favicon.ico');assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),4);
  for(let i=0;i<4;i++){
    const pos=6+i*16,size=[16,32,48,64][i];assert.equal(ico[pos],size);
    const length=ico.readUInt32LE(pos+8),start=ico.readUInt32LE(pos+12),frame=ico.subarray(start,start+length);
    assert.deepEqual(frame,await sharp(original).resize(size,size).png().toBuffer());
  }
});
test('website, legal pages and social metadata share the canonical icon with no theme-specific replacement',async()=>{
  const logo=String(await read('components/voom/shell/VoomLogo.tsx'));
  assert.match(logo,/src=\{VOOM_APP_ICON\}/);assert.doesNotMatch(logo,/<svg|linearGradient|dark:|filter:/);
  assert.match(String(await read('app/components/Logo.tsx')),/VoomLogoMark/);
  const layout=String(await read('app/layout.tsx'));
  // Next 16's resolver suppresses file-based icons if metadata.icons exists.
  assert.doesNotMatch(layout,/\bicons:/);assert.match(layout,/openGraph:/);assert.match(layout,/twitter:/);
  assert.equal((layout.match(/url: VOOM_APP_ICON/g)??[]).length,2);
  assert.match(VOOM_APP_ICON,/e73c1c43/,'canonical filename busts older asset caches');
});
test('no stale PWA icon source; branding branch cannot create an inherited-credential Preview',async()=>{
  for(const p of ['app/manifest.json','app/manifest.ts','app/manifest.webmanifest','public/manifest.json','public/manifest.webmanifest'])await assert.rejects(access(new URL('../'+p,import.meta.url)));
  const config=JSON.parse(await read('vercel.json'));assert.equal(config.git.deploymentEnabled['codex/tiktok-icon-consistency'],false);
});
