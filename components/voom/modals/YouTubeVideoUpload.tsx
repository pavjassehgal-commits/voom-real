"use client";
import { useEffect, useRef, useState } from "react";
import type { Upload } from "tus-js-client";
import { validYouTubeUploadFile, youtubeUploadLimitLabel } from "@/lib/youtube/upload-rules";
import { uploadFingerprint, uploadRequest, uploadStatus, tusUploadOptions, type BrowserUpload } from "@/lib/youtube/upload-client";

export function YouTubeVideoUpload({draftId,disabled,onAttached,onBusy}:{
  draftId:string;disabled:boolean;onAttached:(draft:unknown)=>void;onBusy:(busy:boolean)=>void;
}) {
  const [session,setSession]=useState<BrowserUpload|null>(null),[phase,setPhase]=useState("loading"),[progress,setProgress]=useState(0),[message,setMessage]=useState("");
  const [hasFile,setHasFile]=useState(false),[maxBytes,setMaxBytes]=useState<number|null>(null);
  const alive=useRef(true),uploader=useRef<Upload|null>(null),fileRef=useRef<File|null>(null),requestKey=useRef({fingerprint:"",key:""});
  const busy=["preparing","uploading","validating"].includes(phase);
  useEffect(()=>{onBusy(busy);},[busy,onBusy]);
  useEffect(()=>{
    alive.current=true;
    void uploadStatus(draftId).then(({upload:u,maxBytes:limit})=>{if(alive.current){setMaxBytes(limit);setSession(u);setPhase(u?"paused":"idle");if(u)setMessage("An unfinished upload is available. Choose the same original MP4 to resume.");}})
      .catch(()=>{if(alive.current){setPhase("error");setMessage("Upload status is unavailable. Reload before starting another upload.");}});
    return()=>{alive.current=false;void uploader.current?.abort(false);};
  },[draftId]);
  async function finish(u:BrowserUpload) {
    if(!alive.current)return;setPhase("validating");
    try {
      const result=await uploadRequest(draftId,{action:"complete",uploadId:u.id});
      if(!alive.current)return;
      onAttached(result.draft);setSession(null);fileRef.current=null;setHasFile(false);setPhase("idle");setProgress(100);
      setMessage("Video attached privately. Review and approve separately; nothing was scheduled or published.");
    } catch(e) {
      if(alive.current){setPhase("paused");setMessage(e instanceof Error?e.message:"Attachment could not be confirmed. Check the same upload before retrying.");}
    }
  }
  async function start(file:File) {
    if(disabled || busy)return;
    if(maxBytes===null)return;
    // Refuse before hashing or uploading anything Storage would not accept.
    if(!validYouTubeUploadFile(file.name,file.size,maxBytes)){setMessage(`Choose one MP4 up to ${youtubeUploadLimitLabel(maxBytes)}. Larger videos can't be uploaded yet.`);return;}
    fileRef.current=file;setHasFile(true);setPhase("preparing");setMessage("");
    try {
      const fingerprint=await uploadFingerprint(file);
      if(!alive.current)return;
      let u=session;
      if(u && (u.fingerprint!==fingerprint || u.size!==file.size))throw Error("Choose the same original file to resume, or cancel this upload first.");
      if(!u) {
        if(requestKey.current.fingerprint!==fingerprint)requestKey.current={fingerprint,key:crypto.randomUUID()};
        const result=await uploadRequest(draftId,{action:"start",key:requestKey.current.key,name:file.name,size:file.size,fingerprint});
        u=result.upload as BrowserUpload;
      }
      if(!alive.current)return;setSession(u);
      // Lost completion response / refreshed editor: validate the SAME stored
      // object before attempting more bytes. No second object/job is allocated.
      try {
        const recovered=await uploadRequest(draftId,{action:"complete",uploadId:u.id});
        if(alive.current){onAttached(recovered.draft);setSession(null);setPhase("idle");setMessage("Stored video recovered. Review and approve separately.");}return;
      } catch(e) {
        if(!(e instanceof Error) || !("code" in e) || e.code!=="upload_not_complete")throw e;
      }
      const grant=await uploadRequest(draftId,{action:"authorize",uploadId:u.id});
      const {Upload}=await import("tus-js-client");
      if(!alive.current)return;
      const selected=u;
      const upload=new Upload(file,tusUploadOptions({session:u,authorization:grant.authorization,publishableKey:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??"",
        onProgress:(sent,total)=>{if(alive.current)setProgress(Math.floor(sent/total*100));},
        onSuccess:()=>{void finish(selected);},
        onError:()=>{if(alive.current){setPhase("paused");setMessage("Upload interrupted. Resume the same file, or check whether the stored upload completed. Your existing draft is unchanged until attachment succeeds.");}},
      }));
      uploader.current=upload;
      const previous=await upload.findPreviousUploads();
      if(previous.length)upload.resumeFromPreviousUpload(previous[0]);
      if(!alive.current)return;setPhase("uploading");upload.start();
    } catch(e) {if(alive.current){setPhase("paused");setMessage(e instanceof Error?e.message:"Upload could not start. Check its status before retrying.");}}
  }
  async function pause() {await uploader.current?.abort(false);if(alive.current){setPhase("paused");setMessage("Upload paused. Resume here, or reselect the same original file after reopening the editor.");}}
  async function cancel() {
    if(!session)return;setPhase("preparing");await uploader.current?.abort(false);
    try {
      await uploadRequest(draftId,{action:"cancel",uploadId:session.id});
      if(alive.current){setSession(null);fileRef.current=null;setHasFile(false);requestKey.current={fingerprint:"",key:""};setPhase("idle");setProgress(0);setMessage("Upload cancelled. Temporary private bytes will be cleaned up later. Existing attached media was not removed.");}
    }catch(e){if(alive.current){setPhase("paused");setMessage(e instanceof Error?e.message:"Cancellation is unconfirmed. Check the attachment before retrying.");}}
  }
  return <div className="space-y-2" aria-busy={busy}>
    <input type="file" accept=".mp4,video/mp4" aria-label="Upload video" disabled={disabled || busy || phase==="loading" || phase==="error"}
      className="block w-full min-w-0 rounded-xl border border-line bg-surface p-2 text-sm"
      onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value="";if(file)void start(file);}} />
    {maxBytes!==null && <p className="text-xs text-text-2">MP4 up to {youtubeUploadLimitLabel(maxBytes)}.</p>}
    {session && <p className="break-all text-xs text-text-2">{session.name} · {(session.size/1024/1024).toFixed(1)} MiB</p>}
    {busy && <><progress aria-label="Video upload progress" max={100} value={progress} className="w-full"/><p role="status" className="text-sm text-text-2">{phase==="validating"?"Checking the stored MP4 and attaching it safely…":phase==="preparing"?"Preparing secure resumable upload…":`Uploading: ${progress}%`}</p></>}
    <div className="flex flex-wrap gap-3 text-sm">
      {phase==="uploading" && <button type="button" onClick={()=>void pause()} className="underline">Pause upload</button>}
      {session && phase==="paused" && hasFile && <button type="button" disabled={disabled} onClick={()=>void start(fileRef.current!)} className="underline">Resume upload</button>}
      {session && !busy && <button type="button" disabled={disabled} onClick={()=>void finish(session)} className="underline">Check attachment</button>}
      {session && phase!=="validating" && phase!=="preparing" && <button type="button" disabled={disabled} onClick={()=>void cancel()} className="underline">Cancel upload</button>}
    </div>
    {message && <p role="status" className="break-words text-sm text-text-2">{message}</p>}
  </div>;
}
