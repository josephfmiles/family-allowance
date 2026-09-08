import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Check, ChevronLeft, ChevronRight, Clock3, Download, History,
  Home, LogOut, Plus, Settings2, ShieldCheck, ClipboardCheck, X,
  UserRound, SlidersHorizontal, UsersRound, UserPlus
} from 'lucide-react';
import { supabase } from './supabase';
import './styles.css';

const money = n => `$${Number(n || 0).toFixed(2)}`;
const today = () => new Date().toLocaleDateString('en-CA');
const fmtDate = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric'});
const fmtMonth = m => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined,{month:'long',year:'numeric'});
const monthStart = m => `${m}-01`;
const nextMonth = m => { const d=new Date(`${m}-01T12:00:00`); d.setMonth(d.getMonth()+1); return d.toLocaleDateString('en-CA').slice(0,7); };
const weekStart = d => { const x=new Date(`${d}T12:00:00`); const day=x.getDay(); x.setDate(x.getDate()-(day===0?6:day-1)); return x.toLocaleDateString('en-CA'); };
const csvEscape = v => `"${String(v??'').replaceAll('"','""')}"`;

function App(){
  const [session,setSession]=useState(null),[profile,setProfile]=useState(null),[loading,setLoading]=useState(true),[blocked,setBlocked]=useState(false);
  const [children,setChildren]=useState([]),[rules,setRules]=useState([]),[settings,setSettings]=useState(null),[transactions,setTransactions]=useState([]),[allowances,setAllowances]=useState([]);
  const [month,setMonth]=useState(today().slice(0,7)),[modal,setModal]=useState(null),[toast,setToast]=useState(''),[view,setView]=useState('home');

  const load = async () => {
    setLoading(true);
    await supabase.rpc('ensure_month_snapshot',{p_month:monthStart(month)});
    const results=await Promise.all([
      supabase.from('profiles').select('*').order('display_name'),
      supabase.from('children').select('*').eq('active',true).order('name'),
      supabase.from('allowance_rules').select('*').eq('active',true).order('sort_order'),
      supabase.from('settings').select('*').eq('id',true).single(),
      supabase.from('monthly_allowances').select('*').eq('month_start',monthStart(month)),
      supabase.from('transactions').select('id,child_id,rule_id,type,amount,reason,note,event_date,requested_by,status,decided_by,decision_note,decided_at,created_at,reversal_of,children(name)').order('event_date',{ascending:false}).order('created_at',{ascending:false})
    ]);
    const [p,c,r,s,a,t]=results;
    setProfile((p.data||[]).find(x=>x.id===session.user.id)||null); setChildren(c.data||[]); setRules(r.data||[]); setSettings(s.data||null); setAllowances(a.data||[]); setTransactions(t.data||[]);
    const errors=[p,c,r,s,a,t].map(x=>x.error?.message).filter(Boolean); if(errors.length)setToast(errors.join(' | '));
    setLoading(false);
  };

  useEffect(()=>{ supabase.auth.getSession().then(({data})=>{setSession(data.session);if(!data.session)setLoading(false)}); const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,s)=>setSession(s)); return()=>subscription.unsubscribe(); },[]);
  useEffect(()=>{if(session)load()},[session,month]);
  useEffect(()=>{if(profile && profile.role==='pending') setBlocked(true); else setBlocked(false)},[profile]);
  useEffect(()=>{if(toast){const x=setTimeout(()=>setToast(''),3500);return()=>clearTimeout(x)}},[toast]);

  if(!session) return <Auth/>;
  if(loading) return <div className="center splash"><div className="app-mark">$</div><b>Family Allowance</b><span>Loading your household…</span></div>;
  if(blocked) return <div className="center"><div className="blocked"><ShieldCheck size={34}/><h2>Parent access required</h2><p>This account is not enabled as a parent.</p><button className="primary" onClick={()=>supabase.auth.signOut()}>Sign out</button></div></div>;

  const isParent=profile?.role==='parent';
  const pending=transactions.filter(t=>t.status==='pending');
  const currentAllowance=c=>Number(allowances.find(a=>a.child_id===c.id)?.starting_allowance ?? 0);
  const monthTx=c=>transactions.filter(t=>t.child_id===c.id&&t.event_date>=monthStart(month)&&t.event_date<monthStart(nextMonth(month))&&t.status==='approved');
  const sums=arr=>({ding:arr.filter(t=>t.type==='ding').reduce((s,t)=>s+Number(t.amount),0),earn:arr.filter(t=>t.type==='earn').reduce((s,t)=>s+Number(t.amount),0)});
  const balance=c=>{const x=sums(monthTx(c)); return Math.max(0,currentAllowance(c)-x.ding+x.earn)};
  const totals=c=>{const a=monthTx(c),ts=today(),ws=weekStart(ts);return {month:sums(a),week:sums(a.filter(t=>t.event_date>=ws)),today:sums(a.filter(t=>t.event_date===ts))}};
  const decide=async(id,ok)=>{const note=prompt(ok?'Optional approval note:':'Reason for declining:')??'';const {error}=await supabase.rpc('decide_transaction',{p_id:id,p_approve:ok,p_note:note}); if(error)setToast(error.message);else{setToast(ok?'Approved':'Declined');load()}};
  const submit=async f=>{const {error}=await supabase.rpc('submit_transaction',{p_child:f.child_id,p_rule:f.rule_id||null,p_event_date:f.event_date,p_note:f.note||null,p_custom_reason:f.custom_reason||null});if(error)setToast(error.message);else{setToast(f.type==='earn'?'Earn-back added':'Ding submitted for approval');setModal(null);load()}};
  const saveSettings=async v=>{const {error}=await supabase.from('settings').update(v).eq('id',true);if(error)setToast(error.message);else{setToast('Rules saved');setModal(null);load()}};
  const exportMonth=()=>{const rows=transactions.filter(t=>t.event_date.startsWith(month));const header=['Date','Child','Type','Amount','Rule/Reason','Note','Status','Decision Note'];const data=[header,...rows.map(t=>[t.event_date,t.children?.name,t.type,t.amount,t.reason,t.note||'',t.status,t.decision_note||''])];const blob=new Blob([data.map(r=>r.map(csvEscape).join(',')).join('\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`allowance-${month}.csv`;a.click();URL.revokeObjectURL(a.href)};
  const shift=d=>{const x=new Date(`${month}-01T12:00:00`);x.setMonth(x.getMonth()+d);setMonth(x.toLocaleDateString('en-CA').slice(0,7))};

  const monthRows=transactions.filter(t=>t.event_date.startsWith(month));
  const openAdd=child=>setModal({type:'transaction',child:child||children[0]});

  return <div className="app-shell">
    <header className="app-header">
      <div className="header-brand"><div className="app-mark small">$</div><div><b>Family Allowance</b><span>{profile?.display_name||session.user.email}</span></div></div>
      <button className="avatar" onClick={()=>setView('more')} aria-label="Profile"><UserRound size={19}/></button>
    </header>

    <main className="phone-content">
      {view==='home' && <>
        <section className="hero">
          <div className="eyebrow">{fmtMonth(month)}</div>
          <div className="month-switch"><button onClick={()=>shift(-1)}><ChevronLeft/></button><strong>Allowance dashboard</strong><button onClick={()=>shift(1)}><ChevronRight/></button></div>
          <button className="current-month" onClick={()=>setMonth(today().slice(0,7))}>Jump to current month</button>
        </section>

        <section className="child-stack">
          {children.map((c,i)=>{const b=balance(c),t=totals(c); const used=Math.min(100,Math.round((b/currentAllowance(c))*100)||0); return <article className={`child-card child-${i}`} key={c.id}>
            <div className="child-top"><div><span className="child-label">{c.name.toUpperCase()}</span><h2>{money(b)}</h2><p>Available allowance</p></div><div className="allowance-pill">of {money(currentAllowance(c))}</div></div>
            <div className="progress"><span style={{width:`${used}%`}}/></div>
            <div className="quick-stats"><div><span>Today</span><b className="negative">-{money(t.today.ding)}</b><b className="positive">+{money(t.today.earn)}</b></div><div><span>This week</span><b className="negative">-{money(t.week.ding)}</b><b className="positive">+{money(t.week.earn)}</b></div><div><span>This month</span><b className="negative">-{money(t.month.ding)}</b><b className="positive">+{money(t.month.earn)}</b></div></div>
            {isParent&&<button className="card-action" onClick={()=>openAdd(c)}><Plus size={18}/> Add ding or credit</button>}
          </article>})}
        </section>

        {isParent&&<section className="summary-strip">
          <div><ClipboardCheck size={20}/><span><b>{pending.length}</b> awaiting approval</span></div>
          <button onClick={()=>setView('pending')}>Review</button>
        </section>}
      </>}

      {view==='pending' && isParent && <section className="screen-section"><div className="screen-title"><div><h1>Approvals</h1><p>{pending.length} items waiting</p></div><ShieldCheck size={26}/></div>{pending.length===0?<Empty text="You're all caught up. Nothing is waiting for approval."/>:pending.map(t=><div className="approval-card" key={t.id}><div className="entry-icon"><span className={t.type==='ding'?'negative':'positive'}>{t.type==='ding'?'−':'+'}</span></div><div className="entry-copy"><b>{t.children?.name}</b><strong>{t.reason}</strong><small>{fmtDate(t.event_date)} · {t.requested_by===session.user.id?'Submitted by you':'Submitted by the other parent'}</small>{t.note&&<small className="note">“{t.note}”</small>}</div><div className={t.type==='ding'?'entry-money negative':'entry-money positive'}>{t.type==='ding'?'−':'+'}{money(t.amount)}</div>{t.requested_by!==session.user.id?<div className="approval-actions"><button className="approve" onClick={()=>decide(t.id,true)}><Check size={16}/> Approve</button><button className="decline" onClick={()=>decide(t.id,false)}><X size={16}/> Decline</button></div>:<div className="self-wait"><Clock3 size={15}/> Waiting for the other parent</div>}</div>)}</section>}

      {view==='activity' && <section className="screen-section"><div className="screen-title"><div><h1>Activity</h1><p>{fmtMonth(month)} · {monthRows.length} entries</p></div><button className="round-tool" onClick={exportMonth} title="Export month"><Download size={19}/></button></div><div className="month-inline"><button onClick={()=>shift(-1)}><ChevronLeft size={18}/></button><b>{fmtMonth(month)}</b><button onClick={()=>shift(1)}><ChevronRight size={18}/></button></div>{monthRows.length===0?<Empty text="No allowance activity this month."/>:monthRows.slice(0,100).map(t=><ActivityCard key={t.id} t={t} canCorrect={isParent} onCorrect={()=>setModal({type:'correction',tx:t})}/>)}</section>}

      {view==='users' && isParent && <UserApprovals onBack={()=>setView('more')} onToast={setToast} />}

      {view==='more' && <section className="screen-section"><div className="screen-title"><div><h1>More</h1><p>Household tools and settings</p></div><SlidersHorizontal size={26}/></div><div className="menu-list">{isParent&&<button onClick={()=>setView('users')}><UsersRound size={20}/><span><b>Viewer approvals</b><small>Approve or remove read-only users</small></span></button>}{isParent&&<button onClick={()=>setModal({type:'rules'})}><Settings2 size={20}/><span><b>Allowance rules</b><small>Limits, backdating and safeguards</small></span></button>}<button onClick={exportMonth}><Download size={20}/><span><b>Export this month</b><small>Download a CSV record</small></span></button><button onClick={()=>supabase.auth.signOut()} className="danger-menu"><LogOut size={20}/><span><b>Sign out</b><small>Leave this account on this device</small></span></button></div></section>}
    </main>

    {isParent&&<button className="fab" onClick={()=>openAdd()} aria-label="Add entry"><Plus size={28}/></button>}
    <nav className="bottom-nav">
      <NavButton active={view==='home'} onClick={()=>setView('home')} icon={<Home size={21}/>} label="Home"/>
      {isParent&&<NavButton active={view==='pending'} onClick={()=>setView('pending')} icon={<ClipboardCheck size={21}/>} label="Approvals" badge={pending.length}/>}
      <NavButton active={view==='activity'} onClick={()=>setView('activity')} icon={<History size={21}/>} label="Activity"/>
      <NavButton active={view==='more'} onClick={()=>setView('more')} icon={<Settings2 size={21}/>} label="More"/>
    </nav>

    {modal?.type==='transaction'&&<TransactionModal child={modal.child} childrenList={children} rules={rules} settings={settings} onClose={()=>setModal(null)} onSubmit={submit}/>}
    {modal?.type==='rules'&&<RulesModal settings={settings} onClose={()=>setModal(null)} onSave={saveSettings}/>}
    {modal?.type==='correction'&&<CorrectionModal tx={modal.tx} onClose={()=>setModal(null)} onSubmit={async note=>{const {error}=await supabase.rpc('submit_reversal',{p_original:modal.tx.id,p_note:note});if(error)setToast(error.message);else{setToast('Correction submitted');setModal(null);load()}}}/>} 
    {toast&&<div className="toast">{toast}</div>}
  </div>
}

function NavButton({active,onClick,icon,label,badge}){return <button className={active?'nav-active':''} onClick={onClick}>{icon}<span>{label}</span>{badge>0&&<i>{badge}</i>}</button>}
function ActivityCard({t,onCorrect,canCorrect}){return <div className="activity-card"><div className={`entry-icon ${t.type}`}><span>{t.type==='ding'?'−':'+'}</span></div><div className="entry-copy"><b>{t.children?.name}</b><strong>{t.reason}</strong><small>{fmtDate(t.event_date)} · {t.status}</small>{t.note&&<small className="note">“{t.note}”</small>}</div><div className="activity-right"><b className={t.type==='ding'?'negative':'positive'}>{t.type==='ding'?'−':'+'}{money(t.amount)}</b>{canCorrect&&t.status==='approved'&&<button onClick={onCorrect}>Correct</button>}</div></div>}
function Auth(){
  const [mode,setMode]=useState('welcome');
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[username,setUsername]=useState(''),[pin,setPin]=useState(''),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
  const viewerEmail=u=>`${u.trim().toLowerCase().replace(/[^a-z0-9._-]/g,'')}@family-viewer.example.com`;
  const parentSubmit=async e=>{e.preventDefault();setBusy(true);setMsg('');const r=await supabase.auth.signInWithPassword({email,password});if(r.error)setMsg(r.error.message);setBusy(false)};
  const viewerLogin=async e=>{e.preventDefault();setBusy(true);setMsg('');const u=username.trim();if(!u||pin.length<6){setMsg('Enter your approved User ID and at least a 6-digit PIN.');setBusy(false);return;}const r=await supabase.auth.signInWithPassword({email:viewerEmail(u),password:pin});if(r.error)setMsg('Login failed. Check your User ID/PIN or ask a parent to approve your access.');setBusy(false)};
  const requestAccess=async e=>{e.preventDefault();setBusy(true);setMsg('');const u=username.trim();if(u.length<3){setMsg('Enter a User ID of at least 3 characters.');setBusy(false);return;}const {data,error}=await supabase.functions.invoke('request-viewer-access',{body:{username:u}});if(error)setMsg(error.message);else if(data?.error)setMsg(data.error);else{setMsg('Access request sent. A parent will approve you and give you a PIN.');setUsername('');}setBusy(false)};
  return <div className="auth"><div className="auth-card"><div className="app-mark">$</div><h1>Family Allowance</h1>
    {mode==='welcome'&&<><p>Track allowances, Dings and Ding Backs.</p><button className="primary wide" onClick={()=>setMode('viewer')}>👀 Family Viewer</button><button className="secondary wide" onClick={()=>setMode('parent')}>🔐 Parent Login</button></>}
    {mode==='parent'&&<><p>Parents can add and approve allowance activity.</p><form onSubmit={parentSubmit}><label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary wide" disabled={busy}>{busy?'Signing in…':'Sign in as Parent'}</button></form><button className="link-button" onClick={()=>setMode('welcome')}>Back</button></>}
    {mode==='viewer'&&<><p>Approved family members can view the allowances.</p><form onSubmit={viewerLogin}><label>User ID<input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Your approved User ID" required/></label><label>PIN<input type="password" inputMode="numeric" value={pin} onChange={e=>setPin(e.target.value)} required/></label><button className="primary wide" disabled={busy}>{busy?'Signing in…':'View Allowances'}</button></form><button className="secondary wide" disabled={busy} onClick={()=>{setMsg('');setMode('request')}}>Request Viewer Access</button><button className="link-button" onClick={()=>setMode('welcome')}>Back</button></>}
    {mode==='request'&&<><p>Request a User ID. A parent must approve it and will set your PIN.</p><form onSubmit={requestAccess}><label>Requested User ID<input value={username} onChange={e=>setUsername(e.target.value)} placeholder="For example: Nathan" required/></label><button className="primary wide" disabled={busy}>{busy?'Sending…':'Send Access Request'}</button></form><button className="link-button" onClick={()=>setMode('viewer')}>Back</button></>}
    {msg&&<div className="message">{msg}</div>}<div className="auth-note">Viewer accounts are read-only and require parent approval.</div></div></div>
}

function UserApprovals({onBack,onToast}){
 const [requests,setRequests]=useState([]),[users,setUsers]=useState([]),[loading,setLoading]=useState(true);
 const loadUsers=async()=>{setLoading(true);const [r,u]=await Promise.all([supabase.from('viewer_requests').select('*').eq('status','pending').order('created_at',{ascending:false}),supabase.from('profiles').select('id,display_name,email,role,created_at').eq('role','viewer').order('created_at',{ascending:false})]);if(r.error)onToast(r.error.message);if(u.error)onToast(u.error.message);setRequests(r.data||[]);setUsers(u.data||[]);setLoading(false)};
 useEffect(()=>{loadUsers()},[]);
 const approve=async req=>{const pin=prompt(`Set a 6+ digit PIN for ${req.username}:`);if(pin===null)return;if(!/^\d{6,}$/.test(pin)){onToast('PIN must be at least 6 digits.');return;}const {data,error}=await supabase.functions.invoke('approve-viewer',{body:{request_id:req.id,pin}});if(error||data?.error)onToast(error?.message||data.error);else{onToast(`Approved ${req.username}`);loadUsers()}};
 const decline=async id=>{const {error}=await supabase.from('viewer_requests').update({status:'declined'}).eq('id',id);if(error)onToast(error.message);else loadUsers()};
 const revoke=async id=>{const {error}=await supabase.from('profiles').update({role:'pending'}).eq('id',id);if(error)onToast(error.message);else{onToast('Viewer access removed');loadUsers()}};
 return <section className="screen-section"><div className="screen-title"><div><h1>Viewer approvals</h1><p>Approve family members for read-only access</p></div><UserPlus size={26}/></div><button className="secondary" onClick={onBack}>← Back</button>{loading?<p>Loading users…</p>:<><h3>Pending requests</h3>{requests.length===0?<Empty text="No viewer access requests."/>:<div className="approval-users">{requests.map(r=><div className="approval-card" key={r.id}><div className="entry-copy"><b>{r.username}</b><small>Requested {fmtDate(r.created_at.slice(0,10))}</small></div><div className="approval-actions"><button className="approve" onClick={()=>approve(r)}>Approve</button><button className="decline" onClick={()=>decline(r.id)}>Decline</button></div></div>)}</div>}<h3>Approved viewers</h3>{users.length===0?<Empty text="No approved viewers yet."/>:<div className="approval-users">{users.map(u=><div className="approval-card" key={u.id}><div className="entry-copy"><b>{u.display_name||u.email}</b><small>Approved viewer</small></div><button className="decline" onClick={()=>revoke(u.id)}>Remove access</button></div>)}</div>}</>}</section>
}

function TransactionModal({child,childrenList,rules,settings,onClose,onSubmit}){
  const [c,setC]=useState(child.id);
  const [type,setType]=useState('ding');
  const [rule,setRule]=useState('');
  const [date,setDate]=useState(today());
  const [note,setNote]=useState('');
  const [customReason,setCustomReason]=useState('');
  const [busy,setBusy]=useState(false);

  const available=rules.filter(r=>r.child_id===c&&r.type===type);
  const isOther=rule==='__other__';
  const selected=rules.find(r=>r.id===rule);
  const amount=isOther ? available[0]?.amount : selected?.amount;

  useEffect(()=>{
    setRule(available[0]?.id||'');
    setCustomReason('');
  },[c,type]);

  const submit=async e=>{
    e.preventDefault();
    if(isOther&&!customReason.trim()) return;
    setBusy(true);
    await onSubmit({
      child_id:c,
      rule_id:isOther?null:rule,
      event_date:date,
      note,
      custom_reason:isOther?customReason.trim():null,
      type
    });
    setBusy(false);
  };

  return <Modal title="Add entry" onClose={onClose}>
    <form onSubmit={submit}>
      <label>Child
        <select value={c} onChange={e=>setC(e.target.value)}>
          {childrenList.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>

      <div className="seg">
        <button type="button" className={type==='ding'?'selected ding':''} onClick={()=>setType('ding')}>− Ding</button>
        <button type="button" className={type==='earn'?'selected earn':''} onClick={()=>setType('earn')}>+ Earn back</button>
      </div>

      <label>{type==='ding'?'What happened?':'What did they earn back?'}
        <select value={rule} onChange={e=>setRule(e.target.value)} required>
          {available.map(r=><option key={r.id} value={r.id}>{r.name} — {type==='ding'?'-':'+'}{money(r.amount)}</option>)}
          {type==='ding'&&<option value="__other__">Other — enter a custom Ding</option>}
        </select>
      </label>

      {isOther&&<label>What was the Ding for?
        <textarea
          value={customReason}
          onChange={e=>setCustomReason(e.target.value)}
          maxLength={240}
          required
          placeholder="Describe what happened…"
        />
      </label>}

      {amount!=null&&<div className={type==='ding'?'amount-preview ding-preview':'amount-preview earn-preview'}>
        {type==='ding'?'Ding amount':'Earn-back amount'}: {type==='ding'?'-':'+'}{money(amount)}
      </div>}

      <label>Date
        <input type="date" value={date} max={today()} min={new Date(Date.now()-(settings?.backdate_days??7)*86400000).toLocaleDateString('en-CA')} onChange={e=>setDate(e.target.value)} required/>
      </label>

      <label>Optional note
        <textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={240} placeholder="Add context if helpful…"/>
      </label>

      <div className="notice">
        {type==='ding'
          ? 'Dings can be entered more than once per day. They require approval by the other parent before the allowance changes.'
          : 'Earn-backs are added immediately and do not require a second approval.'}
      </div>

      <button className="primary wide" disabled={busy||(!isOther&&!selected)||(isOther&&!customReason.trim())}>
        {busy?'Saving…':type==='ding'?'Submit Ding for approval':'Add Earn-back'}
      </button>
    </form>
  </Modal>
}
function CorrectionModal({tx,onClose,onSubmit}){const [note,setNote]=useState(''),[busy,setBusy]=useState(false);return <Modal title="Correct approved entry" onClose={onClose}><p className="modal-copy">This creates a reversal. The original stays in history and cannot be edited.</p><label>Correction reason<textarea value={note} onChange={e=>setNote(e.target.value)} required placeholder="Why is this being corrected?"/></label><button className="primary wide" disabled={busy||!note.trim()} onClick={async()=>{setBusy(true);await onSubmit(note);setBusy(false)}}>{busy?'Submitting…':'Submit correction'}</button></Modal>}
function RulesModal({settings,onClose,onSave}){
  const [daily,setDaily]=useState(settings?.max_daily_dings??5);
  const [weekly,setWeekly]=useState(settings?.max_weekly_dings??10);
  const [negative,setNegative]=useState(settings?.prevent_negative_balance??true);
  const [back,setBack]=useState(settings?.backdate_days??7);
  return <Modal title="Allowance rules" onClose={onClose}>
    <div className="rules">
      <div className="rule"><b>Maximum Ding deduction per day</b><input type="number" min="0" step="0.50" value={daily} onChange={e=>setDaily(e.target.value)}/></div>
      <div className="rule"><b>Maximum Ding deduction per week</b><input type="number" min="0" step="0.50" value={weekly} onChange={e=>setWeekly(e.target.value)}/></div>
      <div className="rule"><b>Backdate entries (days)</b><input type="number" min="0" max="31" value={back} onChange={e=>setBack(e.target.value)}/></div>
      <div className="check"><input type="checkbox" checked={negative} onChange={e=>setNegative(e.target.checked)}/><span>Prevent negative allowance</span></div>
      <div className="notice">Multiple Dings of the same type can be entered on the same day. The paper chart specifies a $5/day and $10/week maximum for total Ding deductions. Earn-backs apply immediately and cannot exceed the monthly starting allowance.</div>
      <button className="primary wide" onClick={()=>onSave({max_daily_dings:Number(daily),max_weekly_dings:Number(weekly),prevent_negative_balance:negative,backdate_days:Number(back),prevent_duplicate_rule_same_day:false})}>Save rules</button>
    </div>
  </Modal>
}
function Modal({title,onClose,children}){return <div className="overlay" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className="modal"><div className="modal-head"><h3>{title}</h3><button className="close-btn" onClick={onClose}><X/></button></div>{children}</div></div>}
function Empty({text}){return <div className="empty"><div className="empty-icon">✓</div>{text}</div>}
createRoot(document.getElementById('root')).render(<App/>);
