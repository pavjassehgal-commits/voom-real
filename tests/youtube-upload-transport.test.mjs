import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Upload} from 'tus-js-client';
import {tusUploadOptions} from '../lib/youtube/upload-client.ts';

test('real TUS client resumes a dropped chunk from server offset, without another object or corrupted bytes',async()=>{
  const bytes=Buffer.alloc(13*1024*1024+11);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  let stored=Buffer.alloc(0),creates=0,heads=0,dropped=false,requests=0;
  const server=createServer(async(req,res)=>{
    try {
      requests++;assert.equal(req.headers['x-signature'],'synthetic-upload-only');assert.equal(req.headers.apikey,'sb_publishable_synthetic');assert.equal(req.headers['x-upsert'],undefined);
      res.setHeader('Tus-Resumable','1.0.0');
      if(req.method==='HEAD'){heads++;res.setHeader('Upload-Offset',String(stored.length));res.setHeader('Upload-Length',String(bytes.length));res.writeHead(200).end();return;}
      if(req.method==='POST'){creates++;assert.match(req.headers['upload-metadata'],/bucketName/);res.setHeader('Location',`http://127.0.0.1:${server.address().port}/storage/v1/upload/resumable/one`);}
      else {assert.equal(req.method,'PATCH');assert.equal(Number(req.headers['upload-offset']),stored.length);}
      const parts=[];for await(const chunk of req)parts.push(chunk);const chunk=Buffer.concat(parts);assert.ok(chunk.length<=6*1024*1024);
      stored=Buffer.concat([stored,chunk]);
      if(req.method==='PATCH' && !dropped){dropped=true;req.socket.destroy();return;}
      res.setHeader('Upload-Offset',String(stored.length));res.writeHead(req.method==='POST'?201:204).end();
    }catch(error){res.writeHead(500).end(error.message);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const endpoint=`http://127.0.0.1:${server.address().port}/storage/v1/upload/resumable/sign`;
    await new Promise((resolve,reject)=>{
      const upload=new Upload(bytes,{...tusUploadOptions({session:{id:'synthetic-only',fingerprint:'a'.repeat(64)},authorization:{endpoint,token:'synthetic-upload-only',bucket:'youtube-uploads',path:'synthetic/one.mp4'},publishableKey:'sb_publishable_synthetic',onProgress(){},onSuccess:resolve,onError:reject}),retryDelays:[0,10,20]});
      upload.start();
    });
    assert.equal(dropped,true);assert.equal(creates,1);assert.ok(heads>=1);assert.ok(requests>=4);assert.deepEqual(stored,bytes);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
