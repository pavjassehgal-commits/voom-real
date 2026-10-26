"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BTN, PageHeader, StatusChip } from "@/components/voom/redesign/ui";
import type { LinkedInConnectionView } from "@/lib/linkedin/data";

type Draft = {id:string;content:string;status:string;content_version:number;proposed_publish_at:string|null};
type Queue = {id:string;draft_id:string;approved_content_version:number;status:string;scheduled_at:string;next_attempt_at:string;provider_ref:string|null;failure_code:string|null;attempts:number};
export const LINKEDIN_STATUS_LABELS: Record<string,string> = {
  scheduled:"Scheduled",claimed:"Preparing submission",submitting:"Submitting to LinkedIn",published:"Published",
  failed:"Failed",permission_required:"Reconnect required",cancelled:"Cancelled",uncertain:"Check LinkedIn — result unknown",
};
// No secrets, internal errors or user-provided HTML are rendered by this UI.
export function LinkedInWorkspace() {
  const [connection,setConnection] = useState<LinkedInConnectionView|null>(null);
  const [drafts,setDrafts] = useState<Draft[]>([]);
  const [queue,setQueue] = useState<Queue[]>([]);
  const [selected,setSelected] = useState<Draft|null>(null);
  const [text,setText] = useState("");
  const [schedule,setSchedule] = useState("");
  const [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [oneShotAvailable,setOneShotAvailable] = useState(false);
  const [checkedAt,setCheckedAt] = useState(0);
  const creationId = useRef<string|null>(null);

  const load = useCallback(async () => {
    const status = await fetch("/api/integrations/linkedin/status",{cache:"no-store"});
    const body = await status.json();
    if (!status.ok) throw new Error(body.error || "LinkedIn status could not be loaded.");
    setConnection(body.connection);
    setOneShotAvailable(body.oneShotPublishingAvailable === true);
    setConfirmed(false);
    // Unconfigured installations remain safe and useful: show setup required,
    // rather than treating missing credentials/schema as a working connection.
    if (!body.connection.configured) { setDrafts([]); setQueue([]); return; }
    const response = await fetch("/api/integrations/linkedin/drafts",{cache:"no-store"});
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || "Drafts could not be loaded.");
    setDrafts(rows.drafts); setQueue(rows.queue); setCheckedAt(Date.now());
    return rows.drafts as Draft[];
  },[]);
  useEffect(()=>{
    let active=true;
    Promise.resolve().then(async()=>{
      if(!active)return;
      await load();
      if(!active)return;
      const callback = new URLSearchParams(window.location.search);
      if (callback.has("linkedin_error")) setError(callback.get("linkedin_error")==="linkedin_already_linked"
        ? "This LinkedIn profile belongs to another VOOM connection. Disconnect it from that account first."
        : "LinkedIn did not connect. Start Connect LinkedIn again; no account was transferred.");
      else if(callback.get("linkedin")==="connected") setNotice("LinkedIn connected successfully. Nothing was published.");
    }).catch(()=>{if(active)setError("LinkedIn could not be loaded. Refresh to retry.");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[load]);

  async function act(action:()=>Promise<void>) {
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try {await action();} catch(reason) {setError(reason instanceof Error ? reason.message : "The action did not complete.");}
    finally {setBusy(false);}
  }
  async function request(path:string,method:string,body?:unknown) {
    const response=await fetch(`/api/integrations/linkedin/${path}`,{method,headers:{"Content-Type":"application/json"},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error || "The action could not be confirmed. Refresh before retrying.");
    return result;
  }
  function choose(draft:Draft|null) {
    setSelected(draft);setText(draft?.content??"");setSchedule("");setConfirmed(false);creationId.current=null;
    setError("");setNotice("");
  }
  const job=queue.find(row=>row.draft_id===selected?.id);
  const locked=Boolean(job && ["claimed","submitting","published","uncertain"].includes(job.status));
  const saved=Boolean(selected && selected.content===text.trim());
  const unavailable=loading?"Loading LinkedIn…":!connection?.configured?"LinkedIn setup is required before connecting or publishing."
    :!connection.connected?"Connect or reconnect LinkedIn before approving a post.":locked?"This post is already claimed, submitted, published or awaiting verification. It cannot safely be resent."
    :!saved?"Save your text, then review and approve the saved version.":!confirmed?"Confirm the account, text and send time below.":"";
  const oneShotUnavailable=loading?"Loading the approved post…":!connection?.connected?"Connect LinkedIn first."
    :!selected||!saved||selected.status!=="approved"||Number(job?.approved_content_version)!==Number(selected.content_version)
      ?"Save and explicitly approve this version first."
    :schedule?"Approve any changed send time before publishing."
    :job?.status!=="scheduled"?"This post is not eligible for a new submission. Claimed, published and unknown results cannot be resent."
    :job.attempts>=5?"This post has reached its attempt limit."
    :!(Date.parse(job.scheduled_at)<=checkedAt)||!(Date.parse(job.next_attempt_at)<=checkedAt)
      ?"Its approved send time or retry wait has not arrived. Refresh after that time.":"";

  return <div className="min-w-0">
    <PageHeader title="LinkedIn" subtitle="Connect your personal profile, review your text, and explicitly approve each post. Company Pages and media posts are not available yet." />
    {error&&<p role="alert" className="mb-4 rounded-xl border border-red-400 bg-red-50 p-4 text-red-950">{error}</p>}
    {notice&&<p role="status" className="mb-4 rounded-xl border border-green-400 bg-green-50 p-4 text-green-950">{notice}</p>}
    <section className="voom-card mb-5 min-w-0 p-5" aria-label="LinkedIn connection">
      <h2 className="text-lg font-semibold">{connection?.displayName??"Your LinkedIn profile"}</h2>
      <p className="my-2 text-sm text-text-2">{connection?.connected?"Connected · text posts publish publicly on this personal profile."
        :connection?.status==="expired"?"Authorization expired. Reconnect to continue.":connection?.configured?"Not connected. Nothing will publish until you connect and approve a post.":"LinkedIn is not configured on this server yet."}</p>
      <div className="flex flex-wrap gap-2">
        <button className={BTN.primary} disabled={busy||loading||!connection?.configured} onClick={()=>act(async()=>{
          const result=await request("connect","POST");
          const url=new URL(result.authorizationUrl);
          if(url.origin!=="https://www.linkedin.com"||url.pathname!=="/oauth/v2/authorization")throw new Error("Authorization could not be started safely.");
          window.location.assign(url.toString());
        })}>{connection?.connected||connection?.status==="expired"?"Reconnect LinkedIn":"Connect LinkedIn"}</button>
        {connection?.id&&connection.status!=="disconnected"&&<button className={BTN.outline} disabled={busy} onClick={()=>act(async()=>{
          if(!window.confirm("Disconnect LinkedIn? Unsubmitted jobs will stop. Already submitted and published posts will not be changed."))return;
          const result=await request("disconnect","DELETE");setNotice(result.message);setConfirmed(false);await load();
        })}>Disconnect</button>}
        <button className={BTN.outline} disabled={busy} onClick={()=>act(async()=>{await load();setNotice("Status refreshed.");})}>Refresh status</button>
      </div>
    </section>
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      <section className="voom-card min-w-0 p-5" aria-label="LinkedIn text draft">
        <h2 className="mb-3 text-lg font-semibold">{selected?"Review text post":"New text post"}</h2>
        <label className="block text-sm font-medium" htmlFor="linkedin-text">Post text</label>
        <textarea id="linkedin-text" className="mt-2 w-full rounded-xl border border-line bg-surface p-3 text-text" rows={8} maxLength={3000}
          value={text} disabled={busy||locked} onChange={event=>{setText(event.target.value);setConfirmed(false);}} />
        <p className="my-2 text-sm text-text-2">{text.length}/3,000 characters · Text only · Public visibility</p>
        <div className="mb-4 flex flex-wrap gap-2">
          <button className={BTN.outline} disabled={busy||loading||locked||!connection?.configured||!text.trim()} onClick={()=>act(async()=>{
            let id=selected?.id;
            if(id&&selected)await request(`drafts/${id}`,"PATCH",{action:"save",version:Number(selected.content_version),text:text.trim(),scheduledAt:null});
            else {creationId.current??=crypto.randomUUID();const result=await request("drafts","POST",{id:creationId.current,text:text.trim()});id=result.id;}
            const updated=await load();const row=updated?.find(d=>d.id===id);if(row){setSelected(row);setText(row.content);}
            setConfirmed(false);setNotice("Draft saved. Nothing was approved or published.");
          })}>Save draft</button>
          <button className={BTN.outline} disabled={busy} onClick={()=>choose(null)}>New draft</button>
          {selected&&!locked&&<button className={BTN.outline} disabled={busy} onClick={()=>act(async()=>{
            const result=await request(`drafts/${selected.id}`,"PATCH",{action:"reject",version:Number(selected.content_version),text:text.trim(),scheduledAt:null});
            setNotice(result.message);setConfirmed(false);setSelected(null);setText("");await load();
          })}>Reject draft</button>}
        </div>
        <label htmlFor="linkedin-schedule" className="block text-sm font-medium">Send time (leave empty for Post now)</label>
        <input id="linkedin-schedule" type="datetime-local" className="my-2 w-full rounded-xl border border-line bg-surface p-3 text-text"
          value={schedule} disabled={busy||locked} onChange={event=>{setSchedule(event.target.value);setConfirmed(false);}} />
        <label className="my-3 flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={confirmed} disabled={busy||locked||!saved||!connection?.connected}
            onChange={event=>setConfirmed(event.target.checked)} />
          <span>I approve this exact saved text for public posting to {connection?.displayName??"my connected profile"},
            {schedule?" at the selected time":" now"}. Saving a draft alone does not publish it.</span>
        </label>
        <button className={BTN.primary} disabled={busy||Boolean(unavailable)||selected?.status==="rejected"} onClick={()=>act(async()=>{
          if(!selected||!connection?.id||!connection.memberSub)return;
          const result=await request(`drafts/${selected.id}`,"PATCH",{action:"approve",version:Number(selected.content_version),confirmed:true,
            connectionId:connection.id,memberSub:connection.memberSub,scheduledAt:schedule?new Date(schedule).toISOString():null});
          setNotice(result.message);setConfirmed(false);const updated=await load();setSelected(updated?.find(d=>d.id===selected.id)??null);
        })}>{busy?"Working…":schedule?"Approve and schedule":oneShotAvailable?"Approve for manual posting":"Approve and post now"}</button>
        {unavailable&&<p className="mt-2 text-sm text-text-2" role="status">{unavailable}</p>}
        {selected?.status==="rejected"&&<p className="mt-2 text-sm text-text-2">Save a revised draft before approving again.</p>}
        {oneShotAvailable&&<div className="mt-5 rounded-xl border border-line p-4" aria-label="One-post staging test">
          <h3 className="font-semibold">One-post staging test</h3>
          <p className="my-2 text-sm text-text-2">Automatic LinkedIn workers remain off. Approval only queues your post. This separate action publishes only the selected approved post, publicly on your personal profile, after a final confirmation.</p>
          <button className={BTN.primary} disabled={busy||Boolean(oneShotUnavailable)} onClick={()=>{
            if(!selected||!job||!connection?.id||!connection.memberSub||oneShotUnavailable)return;
            const target=selected;
            if(!window.confirm(`Publish this ONE approved post PUBLICLY on ${connection.displayName??"your connected LinkedIn profile"} now?\n\n${target.content}\n\nNo other drafts or jobs will be processed. Cancel if you are not ready for a real public post.`))return;
            void act(async()=>{
              try {
                const result=await request(`drafts/${target.id}/publish`,"POST",{queueId:job.id,version:Number(target.content_version),
                  connectionId:connection.id,memberSub:connection.memberSub,confirmed:true,visibility:"PUBLIC"});
                setNotice(result.message);
              } finally {
                const updated=await load();setSelected(updated?.find(d=>d.id===target.id)??null);
              }
            });
          }}>Publish this one approved post</button>
          {oneShotUnavailable&&<p className="mt-2 text-sm text-text-2" role="status">{oneShotUnavailable}</p>}
        </div>}
      </section>
      <section className="voom-card min-w-0 p-5" aria-label="LinkedIn drafts and publishing queue">
        <h2 className="mb-3 text-lg font-semibold">Your drafts and publishing queue</h2>
        <p className="mb-3 text-sm text-text-2">Published means LinkedIn returned a post reference. Unknown results are never automatically resent. Refresh to check progress.</p>
        {!loading&&drafts.length===0&&<p className="text-sm text-text-2">No LinkedIn text drafts yet.</p>}
        <ul className="space-y-3">{drafts.map(draft=>{
          const row=queue.find(item=>item.draft_id===draft.id);
          return <li key={draft.id} className="min-w-0 rounded-xl border border-line p-3">
            <button className="w-full break-words text-left font-medium" disabled={busy} onClick={()=>choose(draft)}>{draft.content.slice(0,160)}</button>
            <div className="mt-2"><StatusChip status={row?.status??draft.status} label={row?LINKEDIN_STATUS_LABELS[row.status]??"Status unavailable":draft.status==="approved"?"Approved — queue unconfirmed":draft.status==="rejected"?"Rejected":"Draft — approval required"} /></div>
            {row?.failure_code&&<p className="mt-2 break-words text-sm text-text-2">{row.status==="uncertain"?"Check your LinkedIn profile. VOOM will not resend automatically.":row.status==="permission_required"?"Reconnect LinkedIn and review this post before approving again.":row.status==="scheduled"?"Waiting for its send time or a bounded retry.":"Review this post and its connection before taking another action."}</p>}
            {row?.provider_ref&&<p className="mt-2 break-all text-xs text-text-2">LinkedIn confirmed: {row.provider_ref}</p>}
          </li>;
        })}</ul>
      </section>
    </div>
  </div>;
}
