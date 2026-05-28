import { useState, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";

// -= API Client --------------------------------------------------------------
const API = (window.PLAKSHABUDGET_API && window.PLAKSHABUDGET_API !== "%VITE_API_URL%")
  ? window.PLAKSHABUDGET_API
  : (import.meta.env.VITE_API_URL || "http://localhost:4000");

function getToken(){ return localStorage.getItem("bf_token")||""; }

async function apiFetch(path, options={}){
  let resp;
  try {
    resp = await fetch(API+path, {
      ...options,
      headers:{
        "Content-Type":"application/json",
        "Authorization":"Bearer "+getToken(),
        ...(options.headers||{})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (e) {
    const err = new Error("Network connection error");
    err.status = 503;
    throw err;
  }
  if(!resp.ok){
    const err = await resp.json().catch(()=>({error:resp.statusText}));
    const error = new Error(err.error||resp.statusText);
    error.status = resp.status;
    throw error;
  }
  return resp.json();
}

const API_CALL = {
  login:         (id,pw)          => apiFetch("/api/auth/login",{method:"POST",body:{id,password:pw}}),
  getMe:         ()               => apiFetch("/api/auth/me"),
  updateProfile: (data)           => apiFetch("/api/users/me",{method:"PUT",body:data}),
  getUsers:      ()               => apiFetch("/api/users"),
  getPublicUsers:()               => apiFetch("/api/users/public"),
  createUser:    (u)              => apiFetch("/api/users",{method:"POST",body:u}),
  updateUser:    (id,u)           => apiFetch("/api/users/"+id,{method:"PUT",body:u}),
  deleteUser:    (id)             => apiFetch("/api/users/"+id,{method:"DELETE"}),
  getDepts:      ()               => apiFetch("/api/depts"),
  saveDeptBulk:  (depts)          => apiFetch("/api/depts/bulk",{method:"POST",body:depts}),
  saveDept:      (d)              => apiFetch("/api/depts",{method:"POST",body:d}),
  updateDept:    (id,d)           => apiFetch("/api/depts/"+id,{method:"PUT",body:d}),
  deleteDept:    (id)             => apiFetch("/api/depts/"+id,{method:"DELETE"}),
  getIndents:    ()               => apiFetch("/api/indents"),
  createIndent:  (e)              => apiFetch("/api/indents",{method:"POST",body:e}),
  updateIndent:  (id,e)           => apiFetch("/api/indents/"+id,{method:"PUT",body:e}),
  sendRFQ:       (id,emails)      => apiFetch("/api/indents/"+id+"/rfq",{method:"POST",body:{emails}}),
  getConfig:     (key)            => apiFetch("/api/config/"+key),
  setConfig:     (key,val)        => apiFetch("/api/config/"+key,{method:"PUT",body:val}),
  getPublicDepts: ()              => fetch(API+"/api/depts/public").then(r=>r.json()),
  registerSSO:   (temp_token,deptId) => apiFetch("/api/auth/register-sso",{method:"POST",body:{temp_token,deptId}}),
};

const PAL=["#007878","#0891b2","#059669","#d97706","#dc2626","#7c3aed","#db2777","#0d9488","#0369a1","#15803d"];
const fmt=n=>"Rs."+Number(n||0).toLocaleString("en-IN",{maximumFractionDigits:0});
const pct=(a,b)=>b?Math.min(100,Math.round(a/b*100)):0;
const tstr=iso=>iso?new Date(iso).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"--";
const slug=s=>(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"")||"dept";
const dcol=(depts,id)=>PAL[Math.max(0,depts.findIndex(d=>d.id===id))%PAL.length];

const STS={
  reserved:{label:"Pending",color:"#d97706",bg:"#fef9c3"},
  approved:{label:"Approved",color:"#059669",bg:"#dcfce7"},
  rejected:{label:"Rejected",color:"#dc2626",bg:"#fee2e2"},
  partial: {label:"Partial",color:"#0891b2",bg:"#e0f2fe"},
  revision:{label:"Revision",color:"#7c3aed",bg:"#ede9fe"},
};

function getDeptApprovers(users,deptId){
  const out=[];
  (users||[]).forEach(u=>{
    if(u.role!=="approver")return;
    const asgn=u.approverAssignments||(u.deptId?[{deptId:u.deptId,approverLevel:u.approverLevel||0}]:[]);
    asgn.forEach(a=>{if(a.deptId===deptId)out.push({userId:u.id,name:u.name,approverLevel:a.approverLevel});});
  });
  return out.sort((a,b)=>a.approverLevel-b.approverLevel);
}
function getUserDepts(user,depts){
  if(!user||!depts)return[];
  if(user.role==="admin")return depts;
  if(user.role==="requester"){
    const ids=user.deptIds||(user.deptId?[user.deptId]:[]);
    if(ids.length===0)return depts;
    return depts.filter(d=>ids.includes(d.id));
  }
  if(user.role==="approver"){const ids=(user.approverAssignments||(user.deptId?[{deptId:user.deptId}]:[])).map(a=>a.deptId);return depts.filter(d=>ids.includes(d.id));}
  return[];
}
function getApprLvl(user,deptId){
  if(!user||user.role!=="approver")return -1;
  const asgn=user.approverAssignments||(user.deptId?[{deptId:user.deptId,approverLevel:user.approverLevel||0}]:[]);
  const a=asgn.find(x=>x.deptId===deptId);
  return a?a.approverLevel:-1;
}

// Item-level budget helpers
const totalAmt=e=>(e.items||[]).reduce((s,it)=>s+Number(it.amount||0),0);
const approvedAmt=e=>(e.items||[]).filter(it=>it.itemStatus==="approved").reduce((s,it)=>s+Number(it.amount||0),0);
const reservedAmt=e=>(e.items||[]).filter(it=>!it.itemStatus||it.itemStatus==="pending").reduce((s,it)=>s+Number(it.amount||0),0);

function codeStats(indents,deptId,code){
  let spent=0,reserved=0;
  (indents||[]).filter(e=>e.deptId===deptId).forEach(e=>{
    (e.items||[]).forEach(it=>{
      if(it.code!==code)return;
      if(it.itemStatus==="approved")spent+=Number(it.amount||0);
      else if(!it.itemStatus||it.itemStatus==="pending")reserved+=Number(it.amount||0);
    });
  });
  return{spent,reserved};
}

function exportXLS(indents,depts){
  const rows=[];
  (indents||[]).forEach(e=>{
    const dname=(depts||[]).find(d=>d.id===e.deptId)?.name||e.deptId;
    (e.items||[]).forEach((it,idx)=>{
      rows.push({"Indent ID":e.id,"Department":dname,"Title":e.title||"","Submitted By":e.submittedBy,"Date":e.submittedAt?new Date(e.submittedAt).toLocaleDateString("en-IN"):"","Indent Status":STS[e.status]?.label||e.status,"Item #":idx+1,"Budget Code":it.code,"Description":it.desc,"Qty":it.qty||1,"Unit":it.unit||"","Amount":Number(it.amount||0),"Vendor":it.vendor||"","Item Status":it.itemStatus==="approved"?"Approved":it.itemStatus==="rejected"?"Rejected":"Pending"});
    });
    if(!(e.items||[]).length)rows.push({"Indent ID":e.id,"Department":dname,"Title":e.title||"","Submitted By":e.submittedBy,"Date":e.submittedAt?new Date(e.submittedAt).toLocaleDateString("en-IN"):"","Indent Status":STS[e.status]?.label||e.status,"Item #":"","Budget Code":"","Description":"","Qty":"","Unit":"","Amount":0,"Vendor":"","Item Status":""});
  });
  const ws=XLSX.utils.json_to_sheet(rows);
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"Indents");
  XLSX.writeFile(wb,"PlakshaBudget_"+new Date().toISOString().slice(0,10)+".xlsx");
}

// UI primitives
function Card({children,style}){return <div style={{background:"#fff",borderRadius:12,border:"1px solid #e2e8f0",boxShadow:"0 1px 4px rgba(0,0,0,.06)",padding:18,...style}}>{children}</div>;}
function Btn({children,onClick,v="blue",sz="md",disabled,style}){
  const p={sm:"4px 11px",md:"8px 16px",lg:"10px 22px"}[sz]||"8px 16px";
  const C={blue:{background:"#007878",color:"#fff"},green:{background:"#059669",color:"#fff"},red:{background:"#dc2626",color:"#fff"},amber:{background:"#d97706",color:"#fff"},gray:{background:"#f1f5f9",color:"#374151"},purple:{background:"#7c3aed",color:"#fff"},teal:{background:"#0891b2",color:"#fff"}};
  return <button onClick={disabled?undefined:onClick} style={{cursor:disabled?"not-allowed":"pointer",border:"none",borderRadius:8,fontWeight:600,fontFamily:"inherit",fontSize:sz==="sm"?12:14,padding:p,opacity:disabled?.5:1,...(C[v]||C.blue),...style}}>{children}</button>;
}
function Sel({label,value,onChange,children,req}){
  return <div style={{marginBottom:12}}>{label&&<label style={{display:"block",fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:3,textTransform:"uppercase"}}>{label}{req&&<span style={{color:"#dc2626"}}> *</span>}</label>}<select value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",padding:"7px 10px",border:"1.5px solid #e2e8f0",borderRadius:8,fontSize:13,fontFamily:"inherit",background:"#fafafa"}}>{children}</select></div>;
}
function Inp({label,value,onChange,type="text",ph,req,disabled,style}){
  return <div style={{marginBottom:12}}>{label&&<label style={{display:"block",fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:3,textTransform:"uppercase"}}>{label}{req&&<span style={{color:"#dc2626"}}> *</span>}</label>}<input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={ph} disabled={disabled} style={{width:"100%",boxSizing:"border-box",padding:"7px 10px",border:"1.5px solid #e2e8f0",borderRadius:8,fontSize:13,fontFamily:"inherit",background:disabled?"#e2e8f0":"#fafafa",cursor:disabled?"not-allowed":"text",...style}}/></div>;
}
function Txt({label,value,onChange,ph}){
  return <div style={{marginBottom:12}}>{label&&<label style={{display:"block",fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:3,textTransform:"uppercase"}}>{label}</label>}<textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={ph} rows={2} style={{width:"100%",boxSizing:"border-box",padding:"7px 10px",border:"1.5px solid #e2e8f0",borderRadius:8,fontSize:13,fontFamily:"inherit",background:"#fafafa",resize:"vertical"}}/></div>;
}
function Badge({label,color,bg}){return <span style={{display:"inline-block",padding:"2px 9px",borderRadius:20,background:bg||"#f1f5f9",color:color||"#374151",fontSize:11,fontWeight:700}}>{label}</span>;}
function Toast({msg,type}){return <div style={{position:"fixed",top:60,right:16,zIndex:9999,background:type==="error"?"#fee2e2":"#dcfce7",color:type==="error"?"#991b1b":"#166534",border:"1px solid "+(type==="error"?"#fca5a5":"#86efac"),padding:"9px 16px",borderRadius:10,fontWeight:600,fontSize:13,boxShadow:"0 4px 14px rgba(0,0,0,.12)",maxWidth:340}}>{type==="error"?"[!] ":"[ok] "}{msg}</div>;}

// Attachment uploader (file -> base64)
function AttachUploader({atts,onChange}){
  const handle=e=>{
    const files=Array.from(e.target.files||[]);
    if(!files.length)return;
    Promise.all(files.map(f=>new Promise(res=>{if(f.size>2097152){res(null);return;}const r=new FileReader();r.onload=ev=>res({name:f.name,size:f.size,type:f.type,data:ev.target.result});r.onerror=()=>res(null);r.readAsDataURL(f);}))).then(rs=>{onChange([...(atts||[]),...rs.filter(Boolean)].slice(0,5));});
    e.target.value="";
  };
  return(
    <div style={{marginBottom:12}}>
      <label style={{display:"block",fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:4,textTransform:"uppercase"}}>Attachments <span style={{fontWeight:400,textTransform:"none",color:"#94a3b8"}}>(max 5, 2MB each)</span></label>
      {(atts||[]).map((a,i)=>(
        <div key={i} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 9px",background:"#f0f7f7",border:"1px solid #b2dfdb",borderRadius:6,marginRight:6,marginBottom:4}}>
          <span style={{fontSize:11,color:"#007878",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.name}</span>
          <button onClick={()=>onChange((atts||[]).filter((_,j)=>j!==i))} style={{border:"none",background:"none",cursor:"pointer",color:"#dc2626",fontSize:12,padding:0}}>x</button>
        </div>
      ))}
      {(atts||[]).length<5&&(
        <label style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 12px",background:"#f0f7f7",border:"1.5px dashed #80cbc4",borderRadius:7,cursor:"pointer",fontSize:12,color:"#007878",fontWeight:600}}>
          + Attach
          <input type="file" multiple accept="image/*,.pdf,.doc,.docx,.xlsx,.csv" onChange={handle} style={{display:"none"}}/>
        </label>
      )}
    </div>
  );
}
function AttachViewer({atts}){
  if(!atts||!atts.length)return null;
  const openAttachment = (a) => {
    try {
      const base64Data = a.data;
      const base64Parts = base64Data.split('base64,');
      const actualData = base64Parts[1] || base64Parts[0];
      const mimeType = a.type || (base64Parts[0] ? base64Parts[0].split(':')[1].split(';')[0] : 'application/octet-stream');

      const byteCharacters = atob(actualData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType });
      const fileURL = URL.createObjectURL(blob);
      
      const isImg = (a.type || "").startsWith("image/");
      if (isImg || mimeType === "application/pdf") {
        window.open(fileURL, '_blank');
      } else {
        const link = document.createElement('a');
        link.href = fileURL;
        link.download = a.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (err) {
      console.error("Failed to open attachment:", err);
      const newWindow = window.open();
      if (newWindow) {
        newWindow.document.write(`<img src="${a.data}" alt="${a.name}" style="max-width:100%; height:auto;" />`);
        newWindow.document.title = a.name;
        newWindow.document.close();
      }
    }
  };

  return(
    <div style={{marginTop:8,padding:10,background:"#f0f7f7",borderRadius:8,border:"1px solid #b2dfdb"}}>
      <div style={{fontSize:11,fontWeight:700,color:"#004d4d",marginBottom:6}}>Attachments ({atts.length})</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {atts.map((a,i)=>{
          const isImg=(a.type||"").startsWith("image/");
          return isImg?(
            <button key={i} onClick={() => openAttachment(a)} style={{background:"none",border:"none",padding:0,cursor:"pointer",textAlign:"left",display:"block"}}>
              <img src={a.data} alt={a.name} style={{width:56,height:56,objectFit:"cover",borderRadius:6,border:"2px solid #b2dfdb"}}/>
            </button>
          ):(
            <button key={i} onClick={() => openAttachment(a)} style={{background:"none",border:"none",padding:0,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,textDecoration:"none",textAlign:"center"}}>
              <div style={{width:44,height:44,background:"#fff",border:"2px solid #b2dfdb",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#007878"}}>f</div>
              <span style={{fontSize:9,color:"#007878",maxWidth:52,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Timeline
function Timeline({indent,approvers}){
  const steps=[{label:"Submitted",key:"s"},...(approvers||[]).map((a,i)=>({label:"L"+(i+1)+" Approval",key:"l"+i,approver:a})),{label:"Done",key:"done"}];
  const getState=si=>{
    if(si===0)return{s:"done",ts:indent.submittedAt};
    const al=(approvers||[]).length;
    const st=indent.status;
    if(st==="approved"||st==="partial"){
      if(si<=al){const h=(indent.history||[]).find(x=>x.action==="approve"&&x.level===si-1);return{s:"done",ts:h?.at,note:h?.note};}
      return{s:"done",ts:(indent.history||[]).slice(-1)[0]?.at};
    }
    if(st==="rejected"){
      const rh=[...(indent.history||[])].reverse().find(x=>x.action==="reject");
      const rl=rh?.level??al;
      if(si-1<rl){const h=(indent.history||[]).find(x=>x.action==="approve"&&x.level===si-1);return{s:"done",ts:h?.at};}
      if(si-1===rl)return{s:"rejected",ts:rh?.at,note:rh?.note};
      return{s:"pending"};
    }
    if(st==="revision")return{s:"revision",ts:(indent.history||[]).slice(-1)[0]?.at};
    const cur=indent.level||0;
    if(si-1<cur){const h=(indent.history||[]).find(x=>x.action==="approve"&&x.level===si-1);return{s:"done",ts:h?.at,note:h?.note};}
    if(si-1===cur&&si<=al)return{s:"active"};
    return{s:"pending"};
  };
  const C={done:{bg:"#059669",txt:"#059669",icon:"V"},active:{bg:"#007878",txt:"#007878",icon:"...",ring:true},pending:{bg:"#e2e8f0",txt:"#94a3b8",icon:"-"},rejected:{bg:"#dc2626",txt:"#dc2626",icon:"X"},revision:{bg:"#7c3aed",txt:"#7c3aed",icon:"<"}};
  return(
    <div style={{overflowX:"auto",paddingBottom:4}}>
      <div style={{display:"flex",alignItems:"flex-start",minWidth:"max-content"}}>
        {steps.map((step,i)=>{
          const info=getState(i);const c=C[info.s]||C.pending;const isLast=i===steps.length-1;
          return(
            <div key={step.key} style={{display:"flex",alignItems:"flex-start",flexShrink:0}}>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:84}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:info.s==="pending"?"#f8fafc":c.bg,border:"2px solid "+(info.s==="pending"?"#e2e8f0":c.bg),display:"flex",alignItems:"center",justifyContent:"center",color:info.s==="pending"?"#cbd5e1":"#fff",fontSize:11,fontWeight:700,boxShadow:c.ring?"0 0 0 3px #c7d2fe":"none"}}>{c.icon}</div>
                <div style={{fontSize:9,fontWeight:700,color:c.txt,marginTop:4,textAlign:"center",lineHeight:1.3}}>{step.label}</div>
                {step.approver&&<div style={{fontSize:8,color:"#94a3b8",textAlign:"center",marginTop:1}}>{step.approver.name}</div>}
                {info.ts&&<div style={{fontSize:8,color:"#94a3b8",textAlign:"center",marginTop:1}}>{tstr(info.ts)}</div>}
                {info.note&&<div style={{fontSize:8,color:"#7c3aed",fontStyle:"italic",textAlign:"center",marginTop:1,maxWidth:80,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>"{info.note}"</div>}
                {info.s==="active"&&<div style={{fontSize:8,background:"#ede9fe",color:"#5b21b6",borderRadius:20,padding:"1px 5px",marginTop:2,fontWeight:700}}>WAITING</div>}
              </div>
              {!isLast&&<div style={{height:2,width:22,background:info.s==="done"?"#059669":"#e2e8f0",marginTop:13,flexShrink:0}}/>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== MAIN APP ====================
export default function App(){
  const [user,setUser]=useState(null);
  const [page,setPageState]=useState("dashboard");
  const setPage = useCallback((p)=>{
    setPageState(p);
    localStorage.setItem("plakshabudget_page", p);
  },[]);
  const [depts,setDepts]=useState([]);
  const [users,setUsers]=useState([]);
  const [indents,setIndents]=useState([]);
  const [loading,setLoading]=useState(true);
  const [toast,setToast]=useState(null);
  const [approvalLimits,setApprovalLimits]=useState({l1Limit:200000,l2Limit:500000});
  const [ssoTempToken,setSsoTempToken]=useState(null);
  const [ssoError,setSsoError]=useState(null);

  // Load data from API on mount (only if token exists)
  useEffect(()=>{
    let cancelled=false;
    // Check if token in query string (from Microsoft SSO redirect)
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get("token");
    const tempToken = params.get("temp_token");
    const ssoErr = params.get("error");

    if(ssoToken){
      localStorage.setItem("bf_token",ssoToken);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    if(tempToken){
      setSsoTempToken(tempToken);
      window.history.replaceState({}, document.title, window.location.pathname);
      setLoading(false);
      return;
    }
    if(ssoErr){
      setSsoError(decodeURIComponent(ssoErr));
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const token=getToken();
    if(!token){setLoading(false);return;}
    (async()=>{
      try{
        const [currentUser,d,u,e,cfg]=await Promise.all([
          API_CALL.getMe(),
          API_CALL.getDepts(),
          API_CALL.getUsers(),
          API_CALL.getIndents(),
          API_CALL.getConfig("approval_limits").catch(()=>({})),
        ]);
        if(cancelled)return;
        setUser(currentUser);
        if(cfg && (cfg.l1Limit||cfg.l2Limit)) setApprovalLimits({l1Limit:Number(cfg.l1Limit||200000),l2Limit:Number(cfg.l2Limit||500000)});
        const savedPage = localStorage.getItem("plakshabudget_page");
        if(savedPage){
          setPageState(savedPage);
        } else {
          setPageState(currentUser.role === "procurement" ? "proc-dash" : "dashboard");
        }
        if(Array.isArray(d))setDepts(d);
        if(Array.isArray(u))setUsers(u);
        if(Array.isArray(e))setIndents(e);
      }catch(err){
        if(err.status === 401){
          localStorage.removeItem("bf_token");
          setUser(null);
        } else {
          console.error("Session restore failed temporarily:", err);
        }
      }
      if(!cancelled)setLoading(false);
    })();
    const fb=setTimeout(()=>{if(!cancelled)setLoading(false);},8000);
    return()=>{cancelled=true;clearTimeout(fb);};
  },[]);

  // Reload all data (called after mutations)
  const reload=useCallback(async()=>{
    try{
      const [d,u,e,cfg]=await Promise.all([
        API_CALL.getDepts(),
        API_CALL.getUsers(),
        API_CALL.getIndents(),
        API_CALL.getConfig("approval_limits").catch(()=>({})),
      ]);
      if(Array.isArray(d))setDepts(d);
      if(Array.isArray(u))setUsers(u);
      if(Array.isArray(e))setIndents(e);
      if(cfg&&(cfg.l1Limit||cfg.l2Limit))setApprovalLimits({l1Limit:Number(cfg.l1Limit||200000),l2Limit:Number(cfg.l2Limit||500000)});
    }catch(err){console.error("reload failed:",err);}
  },[]);

  // saveDepts: update local depts state
  const saveDepts=useCallback(async d=>{setDepts(d);},[]);

  // saveUsers: re-fetch after any user mutation (mutations done inline in components)
  const saveUsers=useCallback(async u=>{setUsers(u);},[]);

  // saveIndents: re-fetch after any indent mutation (mutations done inline)
  const saveIndents=useCallback(async e=>{setIndents(e);},[]);

  // saveDepts single dept update
  const updateDept=useCallback(async d=>{
    try{const updated=await API_CALL.updateDept(d.id,d);setDepts(ds=>ds.map(x=>x.id===d.id?updated:x));}catch(err){console.error(err);}
  },[]);

  const notify=(msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast(null),3200);};

  const isAdmin=user?.role==="admin";
  const isReq  =user?.role==="requester";
  const isAppr =user?.role==="approver";
  const isProc =user?.role==="procurement";
  const apprDepts=isAppr?getUserDepts(user,depts):[];
  const reqDepts =isReq ?getUserDepts(user,depts):[];
  const apprLvl  =did=>getApprLvl(user,did);

  if(loading)return(
    <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#1e1b4b",fontFamily:"sans-serif"}}>
      <div style={{color:"#fff",textAlign:"center"}}><div style={{fontSize:24,fontWeight:800,marginBottom:8}}>PlakshaBudget</div><div style={{color:"#cbd5e1",fontSize:13}}>Loading...</div></div>
    </div>
  );

  // SSO JIT department selection overlay
  if(ssoTempToken) return <SSODepartmentSelector tempToken={ssoTempToken} onDone={async(userData,loginToken)=>{
    localStorage.setItem("bf_token",loginToken);
    setSsoTempToken(null);
    setLoading(true);
    try{
      const [currentUser,d,u,e]=await Promise.all([API_CALL.getMe(),API_CALL.getDepts(),API_CALL.getUsers(),API_CALL.getIndents()]);
      setUser(currentUser);
      setPageState("dashboard");
      if(Array.isArray(d))setDepts(d);
      if(Array.isArray(u))setUsers(u);
      if(Array.isArray(e))setIndents(e);
    }catch(err){console.error(err);}
    setLoading(false);
  }}/>

  if(!user)return <Login ssoError={ssoError} onLogin={async u=>{
    setUser(u);
    localStorage.removeItem("plakshabudget_page");
    setPageState(u.role==="procurement"?"proc-dash":"dashboard");
    await reload();
  }}/>

  const NAV=[
    {id:"dashboard",    label:"Dashboard",        show:!isProc},
    {id:"import",       label:"Import Budget",     show:isAdmin},
    {id:"depts",        label:"Departments",       show:isAdmin},
    {id:"users",        label:"Users",             show:isAdmin},
    {id:"all",          label:"All Indents",       show:isAdmin},
    {id:"settings",     label:"Settings",          show:isAdmin},
    {id:"raise",        label:"Raise Indent",      show:isReq&&reqDepts.length>0},
    {id:"mine",         label:"My Indents",        show:isReq},
    {id:"approvals",    label:"Approvals",         show:isAppr&&apprDepts.length>0},
    {id:"proc-dash",    label:"Dashboard",         show:isProc},
    {id:"proc-indents", label:"Indents",           show:isProc},
    {id:"profile",      label:"Profile",           show:true},
  ].filter(n=>n.show);

  return(
    <div style={{minHeight:"100vh",background:"#f1f5f9",fontFamily:"'Segoe UI',Arial,sans-serif"}}>
      <style>{`*{box-sizing:border-box} button:hover{opacity:.88} select,input,textarea{outline:none}`}</style>
      {/* Top nav */}
      <div style={{background:"#1e1b4b",padding:"0 16px",display:"flex",alignItems:"center",height:50,position:"sticky",top:0,zIndex:100,overflowX:"auto",gap:2}}>
        <div style={{fontSize:16,fontWeight:800,color:"#fff",marginRight:18,whiteSpace:"nowrap",letterSpacing:-.3}}>PlakshaBudget</div>
        {NAV.map(n=>(
          <button key={n.id} onClick={()=>setPage(n.id)} style={{border:"none",background:page===n.id?"#007878":"transparent",color:page===n.id?"#fff":"#a5b4fc",fontWeight:page===n.id?700:400,padding:"5px 12px",borderRadius:7,cursor:"pointer",fontSize:12,fontFamily:"inherit",whiteSpace:"nowrap"}}>
            {n.label}
          </button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <span style={{fontSize:12,color:"#a5b4fc"}}>{user.name} ({user.role})</span>
          <Btn v="gray" sz="sm" onClick={()=>{localStorage.removeItem("bf_token");localStorage.removeItem("plakshabudget_page");setUser(null);setPageState("dashboard");}}>Sign out</Btn>
        </div>
      </div>
      {toast&&<Toast msg={toast.msg} type={toast.type}/>}
      <div style={{padding:"20px 16px",maxWidth:1200,margin:"0 auto"}}>
        {page==="dashboard"&&<Dashboard depts={depts} indents={indents} isAdmin={isAdmin} user={user} reload={reload} notify={notify}/>}
        {page==="import"   &&isAdmin&&<ImportPage depts={depts} saveDepts={saveDepts} notify={notify}/>}
        {page==="depts"    &&isAdmin&&<DeptsPage depts={depts} saveDepts={saveDepts} indents={indents} users={users} notify={notify}/>}
        {page==="users"    &&isAdmin&&<UsersPage depts={depts} users={users} saveUsers={saveUsers} notify={notify}/>}
        {page==="all"      &&isAdmin&&<AllIndents indents={indents} depts={depts} users={users} notify={notify}/>}
        {page==="settings" &&isAdmin&&<SettingsPage approvalLimits={approvalLimits} setApprovalLimits={setApprovalLimits} notify={notify}/>}
        {page==="raise"    &&isReq&&<RaiseIndent depts={depts} indents={indents} saveIndents={saveIndents} saveDepts={saveDepts} users={users} user={user} notify={notify} setPage={setPage} myDepts={reqDepts}/>}
        {page==="mine"     &&isReq&&<MyIndents indents={indents} depts={depts} users={users} user={user} setPage={setPage}/>}
        {page==="approvals"&&isAppr&&<Approvals indents={indents} saveIndents={saveIndents} depts={depts} saveDepts={saveDepts} users={users} user={user} apprLvl={apprLvl} apprDepts={apprDepts} notify={notify} approvalLimits={approvalLimits}/>}
        {page==="proc-dash"   &&isProc&&<ProcDashboard indents={indents} depts={depts}/>}
        {page==="proc-indents"&&isProc&&<ProcIndents indents={indents} depts={depts} saveIndents={saveIndents} user={user} notify={notify}/>}
        {page==="profile"  &&<ProfilePage user={user} setUser={setUser} notify={notify} depts={depts}/>}
      </div>
    </div>
  );
}

// ==================== SSO DEPARTMENT SELECTOR ====================
function SSODepartmentSelector({tempToken,onDone}){
  const [depts,setDepts]=useState([]);
  const [selDept,setSelDept]=useState("");
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");

  useEffect(()=>{
    API_CALL.getPublicDepts().then(d=>{
      if(Array.isArray(d)){setDepts(d);if(d.length)setSelDept(d[0].id);}
    }).catch(()=>setErr("Failed to load departments. Please refresh."));
  },[]);

  const submit=async()=>{
    if(!selDept){setErr("Please select a department.");return;}
    setBusy(true);setErr("");
    try{
      const {token,user}=await API_CALL.registerSSO(tempToken,selDept);
      onDone(user,token);
    }catch(e){
      setErr(e.message||"Registration failed. Please try again.");
      setBusy(false);
    }
  };

  return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#1e1b4b 0%,#004d4d 100%)",fontFamily:"'Segoe UI',Arial,sans-serif",padding:20}}>
      <div style={{width:"100%",maxWidth:420}}>
        <div style={{textAlign:"center",marginBottom:28,color:"#fff"}}>
          <div style={{fontSize:28,fontWeight:800,marginBottom:4}}>PlakshaBudget</div>
          <div style={{fontSize:13,color:"#86efac",fontWeight:600}}>Almost there! 🎉</div>
        </div>
        <Card>
          <div style={{textAlign:"center",marginBottom:20}}>
            <div style={{width:56,height:56,borderRadius:"50%",background:"#007878",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px",fontSize:26}}>🏢</div>
            <div style={{fontWeight:700,color:"#1e293b",fontSize:17,marginBottom:4}}>Select Your Department</div>
            <div style={{fontSize:12,color:"#64748b"}}>You're signing in for the first time. Please choose your department to complete your account setup.</div>
          </div>
          {err&&<div style={{color:"#dc2626",fontSize:12,marginBottom:10,padding:"8px 12px",background:"#fee2e2",borderRadius:8}}>⚠ {err}</div>}
          <Sel label="Department *" value={selDept} onChange={setSelDept} req>
            {depts.length===0&&<option value="">Loading departments...</option>}
            {depts.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </Sel>
          <Btn v="blue" sz="lg" onClick={submit} disabled={busy||!selDept} style={{width:"100%",marginTop:8}}>
            {busy?"Creating Account...":"Complete Sign Up"}
          </Btn>
          <div style={{marginTop:12,fontSize:11,color:"#94a3b8",textAlign:"center"}}>Only @plaksha.edu.in accounts are allowed to sign up.</div>
        </Card>
      </div>
    </div>
  );
}

// ==================== PROFILE ====================
function ProfilePage({user,setUser,notify,depts}){
  const [name,setName]=useState(user?.name||"");
  const [email,setEmail]=useState(user?.email||"");
  const [pw,setPw]=useState("");
  const [confirmPw,setConfirmPw]=useState("");
  const [busy,setBusy]=useState(false);
  const isReq=user?.role==="requester";
  const currentDeptId=(user?.deptIds||[])[0]||"";
  const [selDept,setSelDept]=useState(currentDeptId);

  const save=async()=>{
    if(!name.trim()){notify("Name is required","error");return;}
    if(!email.trim()){notify("Email is required","error");return;}
    if(pw && pw !== confirmPw){notify("Passwords do not match","error");return;}
    
    setBusy(true);
    try {
      const payload={name:name.trim(),email:email.trim(),...(pw?{password:pw}:{})};
      if(isReq&&selDept)payload.deptIds=[selDept];
      else if(isReq&&!selDept)payload.deptIds=[];
      const updated = await API_CALL.updateProfile(payload);
      setUser(updated);
      notify("Profile updated successfully!");
      setPw("");
      setConfirmPw("");
    } catch(err) {
      notify(err.message||"Failed to update profile","error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{maxWidth:500,margin:"0 auto"}}>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>My Profile</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:18,marginTop:0}}>Update your profile information and account password.</p>
      <Card>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:4,textTransform:"uppercase"}}>User ID (Username)</div>
          <input value={user?.id||""} disabled style={{width:"100%",padding:"8px 12px",border:"1.5px solid #e2e8f0",borderRadius:8,background:"#f1f5f9",color:"#64748b",fontFamily:"inherit",fontSize:13,cursor:"not-allowed"}}/>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:4,textTransform:"uppercase"}}>Role</div>
          <input value={user?.role||""} disabled style={{width:"100%",padding:"8px 12px",border:"1.5px solid #e2e8f0",borderRadius:8,background:"#f1f5f9",color:"#64748b",fontFamily:"inherit",fontSize:13,cursor:"not-allowed",textTransform:"capitalize"}}/>
        </div>
        {isReq&&(
          <Sel label="Department" value={selDept} onChange={setSelDept}>
            <option value="">-- No Department --</option>
            {(depts||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </Sel>
        )}
        <Inp label="Name *" value={name} onChange={setName} ph="Enter your full name"/>
        <Inp label="Email Address *" value={email} onChange={setEmail} type="email" ph="Enter your email address"/>
        
        <div style={{borderTop:"1px solid #e2e8f0",margin:"20px 0 14px",paddingTop:14}}>
          <h3 style={{margin:"0 0 6px",fontSize:14,color:"#1e293b",fontWeight:700}}>Change Password</h3>
          <p style={{color:"#64748b",fontSize:11,margin:"0 0 12px"}}>Leave blank if you do not want to change your password.</p>
          <Inp label="New Password" value={pw} onChange={setPw} type="password" ph="New password"/>
          <Inp label="Confirm New Password" value={confirmPw} onChange={setConfirmPw} type="password" ph="Confirm new password"/>
        </div>
        
        <Btn v="blue" sz="lg" onClick={save} disabled={busy} style={{width:"100%",marginTop:8}}>{busy?"Saving...":"Save Profile"}</Btn>
      </Card>
    </div>
  );
}

// ==================== SETTINGS PAGE ====================
function SettingsPage({approvalLimits,setApprovalLimits,notify}){
  const [l1,setL1]=useState(String(approvalLimits.l1Limit||200000));
  const [l2,setL2]=useState(String(approvalLimits.l2Limit||500000));
  const [busy,setBusy]=useState(false);

  const save=async()=>{
    const n1=Number(l1),n2=Number(l2);
    if(!n1||!n2||isNaN(n1)||isNaN(n2)){notify("Enter valid numeric values","error");return;}
    if(n1<=0||n2<=0){notify("Limits must be greater than 0","error");return;}
    if(n2<=n1){notify("Limit 2 must be greater than Limit 1","error");return;}
    setBusy(true);
    try{
      await API_CALL.setConfig("approval_limits",{l1Limit:n1,l2Limit:n2});
      setApprovalLimits({l1Limit:n1,l2Limit:n2});
      notify("Approval limits saved successfully!");
    }catch(err){
      notify(err.message||"Failed to save settings","error");
    }finally{setBusy(false);}
  };

  const fmt2=n=>"Rs. "+Number(n||0).toLocaleString("en-IN",{maximumFractionDigits:0});

  return(
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>System Settings</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:18,marginTop:0}}>Configure approval level thresholds for indent amounts.</p>
      <Card>
        <div style={{marginBottom:18,padding:"14px 16px",background:"#f0f7f7",borderRadius:10,border:"1px solid #b2dfdb"}}>
          <div style={{fontWeight:700,color:"#004d4d",fontSize:13,marginBottom:8}}>📋 How Approval Levels Work</div>
          <div style={{fontSize:12,color:"#374151",lineHeight:1.7}}>
            <div>• Amount &lt; <strong>Limit 1</strong> → Only <strong>L1</strong> approval needed</div>
            <div>• Amount ≥ <strong>Limit 1</strong> and &lt; <strong>Limit 2</strong> → <strong>L1 + L2</strong> approval needed</div>
            <div>• Amount ≥ <strong>Limit 2</strong> → <strong>L1 + L2 + L3</strong> approval needed, then goes to Procurement</div>
          </div>
        </div>
        <Inp label="Limit 1 (L1 only below this amount)" value={l1} onChange={setL1} type="number" ph="e.g. 200000"/>
        <div style={{fontSize:11,color:"#64748b",marginTop:-8,marginBottom:12}}>Current: {fmt2(l1)} — Indents below this require only L1 approval</div>
        <Inp label="Limit 2 (L1+L2 below, L1+L2+L3 above)" value={l2} onChange={setL2} type="number" ph="e.g. 500000"/>
        <div style={{fontSize:11,color:"#64748b",marginTop:-8,marginBottom:16}}>Current: {fmt2(l2)} — Indents above this require all three approvals</div>
        <div style={{background:"#f8fafc",borderRadius:8,padding:"12px 14px",marginBottom:16,border:"1px solid #e2e8f0"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#007878",marginBottom:6}}>PREVIEW WITH CURRENT VALUES</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",alignItems:"center",gap:10,fontSize:12}}>
              <span style={{minWidth:140,color:"#374151"}}>Below {fmt2(l1)}:</span>
              <span style={{background:"#dcfce7",color:"#166534",padding:"2px 10px",borderRadius:20,fontWeight:700}}>L1 only</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,fontSize:12}}>
              <span style={{minWidth:140,color:"#374151"}}>{fmt2(l1)} – {fmt2(l2)}:</span>
              <span style={{background:"#fef9c3",color:"#854d0e",padding:"2px 10px",borderRadius:20,fontWeight:700}}>L1 + L2</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,fontSize:12}}>
              <span style={{minWidth:140,color:"#374151"}}>Above {fmt2(l2)}:</span>
              <span style={{background:"#fee2e2",color:"#991b1b",padding:"2px 10px",borderRadius:20,fontWeight:700}}>L1 + L2 + L3</span>
            </div>
          </div>
        </div>
        <Btn v="blue" sz="lg" onClick={save} disabled={busy} style={{width:"100%"}}>{busy?"Saving...":"Save Settings"}</Btn>
      </Card>
    </div>
  );
}

// ==================== LOGIN ====================
function Login({onLogin,ssoError}){
  const [uid,setUid]=useState("");
  const [pw,setPw]=useState("");
  const [err,setErr]=useState(ssoError||"");
  const [busy,setBusy]=useState(false);
  const [publicUsers,setPublicUsers]=useState([]);

  useEffect(()=>{
    API_CALL.getPublicUsers().then(u=>setPublicUsers(u||[])).catch(()=>{});
  },[]);

  const go=async()=>{
    if(!uid.trim()||!pw){setErr("Enter username/email and password");return;}
    setErr("");setBusy(true);
    try{
      const {token,user}=await API_CALL.login(uid.trim(),pw);
      localStorage.setItem("bf_token",token);
      onLogin(user);
    }catch(e){
      setErr(e.message||"Login failed. Check server connection.");
    }finally{setBusy(false);}
  };

  const onKey=e=>{if(e.key==="Enter")go();};
  const quick=[{id:"admin",label:"Admin"},...publicUsers.slice(0,10).map(u=>({id:u.id,label:u.name.split(" ")[0]+" ("+u.role+")"}))];

  return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#1e1b4b",fontFamily:"'Segoe UI',Arial,sans-serif",padding:20}}>
      <div style={{width:"100%",maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:24,color:"#fff"}}>
          <div style={{fontSize:28,fontWeight:800,marginBottom:4}}>PlakshaBudget</div>
          <div style={{fontSize:12,color:"#a5b4fc"}}>Department Budget Management</div>
        </div>
        <Card>
          <Inp label="Username or Email" value={uid} onChange={setUid} ph="e.g. admin or admin@example.com"/>
          <Inp label="Password" value={pw} onChange={setPw} type="password" ph="password"/>
          {err&&<div style={{color:"#dc2626",fontSize:12,marginBottom:8}}>Error: {err}</div>}
          <Btn v="blue" sz="lg" onClick={go} disabled={busy} style={{width:"100%"}}>{busy?"Signing in...":"Sign In"}</Btn>

          <div style={{display:"flex",alignItems:"center",gap:8,margin:"12px 0"}}>
            <div style={{flex:1,height:1,background:"#e2e8f0"}}/>
            <span style={{fontSize:10,color:"#94a3b8",fontWeight:600}}>OR</span>
            <div style={{flex:1,height:1,background:"#e2e8f0"}}/>
          </div>

          <button onClick={() => window.location.href = API + "/api/auth/microsoft"} style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            width: "100%",
            padding: "9px 16px",
            background: "#2f2f2f",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: "inherit",
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            transition: "background 0.2s"
          }}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:2,width:16,height:16,flexShrink:0}}>
              <div style={{width:7,height:7,background:"#f25022"}}></div>
              <div style={{width:7,height:7,background:"#7fba00"}}></div>
              <div style={{width:7,height:7,background:"#00a4ef"}}></div>
              <div style={{width:7,height:7,background:"#ffb900"}}></div>
            </div>
            Sign in with Microsoft
          </button>

          {quick.length>1&&(
            <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid #f1f5f9"}}>
              <div style={{fontSize:10,color:"#9ca3af",fontWeight:700,marginBottom:6,textTransform:"uppercase"}}>Quick Login</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                {quick.map(q=><button key={q.id} onClick={()=>setUid(q.id)} style={{fontSize:11,padding:"2px 9px",borderRadius:5,background:"#f1f5f9",border:"1px solid #e2e8f0",cursor:"pointer",fontFamily:"inherit"}}>{q.label}</button>)}
              </div>
            </div>
          )}
        </Card>
        <div style={{textAlign:"center",marginTop:8,fontSize:11,color:"#818cf8"}}>Default: admin / admin123</div>
      </div>
    </div>
  );
}

// ==================== DASHBOARD ====================
function Dashboard({depts,indents,isAdmin,user,reload,notify}){
  const [expanded,setExpanded]=useState(null);
  const [pg,setPg]=useState(1);
  const PER=5;
  const vis=isAdmin?depts:getUserDepts(user,depts);
  const paged=vis.slice((pg-1)*PER,pg*PER);
  useEffect(()=>{setPg(1);},[vis.length]);

  const [showForm,setShowForm]=useState(false);
  const [editCode,setEditCode]=useState(null);
  const [newCode,setNewCode]=useState("");
  const [newDesc,setNewDesc]=useState("");
  const [newAmount,setNewAmount]=useState("");

  const toggleExpand = (deptId) => {
    setExpanded(expanded === deptId ? null : deptId);
    setShowForm(false);
    setEditCode(null);
    setNewCode("");
    setNewDesc("");
    setNewAmount("");
  };

  const saveBudgetCode = async (dept) => {
    if (!newCode) { notify("Code is required", "error"); return; }
    if (newAmount === "" || isNaN(Number(newAmount)) || Number(newAmount) < 0) {
      notify("Allocated Amount must be a valid number >= 0", "error");
      return;
    }

    const currentCodes = dept.codes || [];
    let updatedCodes;
    if (editCode) {
      updatedCodes = currentCodes.map(c => c.code === editCode ? { ...c, desc: newDesc, amount: Number(newAmount) } : c);
    } else {
      if (currentCodes.some(c => c.code === newCode)) {
        notify("Budget code already exists in this department", "error");
        return;
      }
      updatedCodes = [...currentCodes, { code: newCode, desc: newDesc, amount: Number(newAmount) }];
    }

    const newBudget = updatedCodes.reduce((sum, c) => sum + (c.amount || 0), 0);
    const updatedDept = { ...dept, codes: updatedCodes, budget: newBudget };

    try {
      await API_CALL.updateDept(dept.id, updatedDept);
      notify(editCode ? "Budget code updated successfully" : "Budget code added successfully");
      setShowForm(false);
      setEditCode(null);
      setNewCode("");
      setNewDesc("");
      setNewAmount("");
      if (reload) await reload();
    } catch (e) {
      notify(e.message || "Failed to save budget code", "error");
    }
  };

  const deleteBudgetCode = async (dept, code) => {
    const { spent, reserved } = codeStats(indents, dept.id, code);
    if (spent + reserved > 0) {
      notify("Cannot delete budget code: it has spent or reserved funds", "error");
      return;
    }
    if (!window.confirm(`Are you sure you want to delete budget code ${code}?`)) return;

    const currentCodes = dept.codes || [];
    const updatedCodes = currentCodes.filter(c => c.code !== code);
    const newBudget = updatedCodes.reduce((sum, c) => sum + (c.amount || 0), 0);
    const updatedDept = { ...dept, codes: updatedCodes, budget: newBudget };

    try {
      await API_CALL.updateDept(dept.id, updatedDept);
      notify("Budget code deleted successfully");
      if (reload) await reload();
    } catch (e) {
      notify(e.message || "Failed to delete budget code", "error");
    }
  };

  const totB=vis.reduce((s,d)=>s+(d.budget||0),0);
  const totS=(indents||[]).filter(e=>vis.some(d=>d.id===e.deptId)).reduce((s,e)=>s+approvedAmt(e),0);
  const totR=(indents||[]).filter(e=>vis.some(d=>d.id===e.deptId)).reduce((s,e)=>s+reservedAmt(e),0);
  const stats=[["Total Budget",fmt(totB),"#007878"],["Spent",fmt(totS),"#dc2626"],["Reserved",fmt(totR),"#d97706"],["Available",fmt(totB-totS-totR),"#059669"]];
  return(
    <div>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>{isAdmin?"Finance Dashboard":"My Dashboard"}</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:20,marginTop:0}}>{vis.length} dept(s) loaded -- {(indents||[]).filter(e=>e.status==="reserved"&&vis.some(d=>d.id===e.deptId)).length} pending -- click dept to expand codes {vis.length>4?"(scroll down to see all)":""}</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10,marginBottom:20}}>
        {stats.map(([l,v,c])=>(
          <Card key={l} style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:38,height:38,borderRadius:10,background:c+"22",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{width:14,height:14,borderRadius:3,background:c}}/>
            </div>
            <div><div style={{fontSize:17,fontWeight:800,color:"#1e293b"}}>{v}</div><div style={{fontSize:11,color:"#94a3b8"}}>{l}</div></div>
          </Card>
        ))}
      </div>
      {vis.length===0
        ?<Card style={{textAlign:"center",padding:36}}><div style={{fontSize:32,marginBottom:8}}>-</div><div style={{color:"#64748b"}}>No departments yet. Import an Excel file or add via Departments.</div></Card>
        :<div style={{display:"flex",flexDirection:"column",gap:12}}>
          {paged.map(d=>{
            const c=dcol(depts,d.id);
            const de=(indents||[]).filter(e=>e.deptId===d.id);
            const ds=de.reduce((s,e)=>s+approvedAmt(e),0);
            const dr=de.reduce((s,e)=>s+reservedAmt(e),0);
            const da=(d.budget||0)-ds-dr;
            const pn=de.filter(e=>e.status==="reserved").length;
            const isExp=expanded===d.id;
            return(
              <Card key={d.id} style={{padding:0,overflow:"hidden",borderTop:"3px solid "+c}}>
                <div onClick={()=>toggleExpand(d.id)} style={{padding:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:34,height:34,borderRadius:9,background:c+"22",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:c,fontSize:14,flexShrink:0}}>{d.name[0]}</div>
                    <div><div style={{fontWeight:700,color:"#1e293b",fontSize:14}}>{d.name}</div><div style={{fontSize:11,color:"#94a3b8"}}>{d.id} -- {(d.codes||[]).length} codes</div></div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    {[["Budget",fmt(d.budget),"#374151"],["Spent",fmt(ds),"#dc2626"],["Reserved",fmt(dr),"#d97706"],["Available",fmt(da),da<0?"#dc2626":"#059669"]].map(([l,v,cl])=>(
                      <div key={l} style={{textAlign:"center"}}><div style={{fontSize:13,fontWeight:700,color:cl}}>{v}</div><div style={{fontSize:9,color:"#94a3b8"}}>{l}</div></div>
                    ))}
                    {pn>0&&<Badge label={pn+" pending"} color="#854d0e" bg="#fef9c3"/>}
                    <span style={{color:"#94a3b8",fontSize:12}}>{isExp?"^":"v"}</span>
                  </div>
                </div>
                {/* progress bar */}
                <div style={{padding:"0 14px 10px"}}>
                  <div style={{background:"#f1f5f9",borderRadius:99,height:6,overflow:"hidden",display:"flex"}}>
                    <div style={{height:"100%",width:pct(ds,d.budget||1)+"%",background:pct(ds,d.budget||1)>85?"#dc2626":c}}/>
                    <div style={{height:"100%",width:pct(dr,d.budget||1)+"%",background:c+"55"}}/>
                  </div>
                  <div style={{display:"flex",gap:10,marginTop:3,fontSize:9,color:"#94a3b8"}}>
                    <span>Spent {pct(ds,d.budget||1)}%</span>
                    <span>Reserved {pct(dr,d.budget||1)}%</span>
                  </div>
                </div>
                {isExp&&(
                  <div style={{borderTop:"1px solid #f1f5f9"}}>
                    {isAdmin && (
                      <div style={{padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", background:"#f8fafc", borderBottom:"1px solid #e2e8f0"}}>
                        <span style={{fontSize:12, fontWeight:700, color:"#007878"}}>Budget Codes Administration</span>
                        {!showForm && (
                          <Btn sz="sm" onClick={() => {
                            setShowForm(true);
                            setEditCode(null);
                            setNewCode("");
                            setNewDesc("");
                            setNewAmount("");
                          }}>+ Add Budget Code</Btn>
                        )}
                      </div>
                    )}
                    {isAdmin && showForm && (
                      <div style={{padding:"14px", background:"#f0f7f7", borderBottom:"1px solid #e2e8f0", display:"flex", flexDirection:"column", gap:10}}>
                        <div style={{fontSize:12, fontWeight:700, color:"#004d4d"}}>{editCode ? `Edit Budget Code: ${editCode}` : "Add Budget Code"}</div>
                        <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
                          <div style={{flex:1, minWidth:120}}>
                            <label style={{fontSize:10, fontWeight:700, color:"#64748b", display:"block", marginBottom:4}}>Code</label>
                            <input
                              type="text"
                              value={newCode}
                              onChange={e => setNewCode(e.target.value.trim().toUpperCase())}
                              disabled={!!editCode}
                              placeholder="e.g. IT002"
                              style={{width:"100%", padding:"6px 10px", fontSize:12, border:"1px solid #cbd5e1", borderRadius:6, background:editCode ? "#e2e8f0" : "#fff"}}
                            />
                          </div>
                          <div style={{flex:2, minWidth:200}}>
                            <label style={{fontSize:10, fontWeight:700, color:"#64748b", display:"block", marginBottom:4}}>Description</label>
                            <input
                              type="text"
                              value={newDesc}
                              onChange={e => setNewDesc(e.target.value)}
                              placeholder="e.g. Software Licenses"
                              style={{width:"100%", padding:"6px 10px", fontSize:12, border:"1px solid #cbd5e1", borderRadius:6}}
                            />
                          </div>
                          <div style={{flex:1, minWidth:120}}>
                            <label style={{fontSize:10, fontWeight:700, color:"#64748b", display:"block", marginBottom:4}}>Allocated Amount</label>
                            <input
                              type="number"
                              value={newAmount}
                              onChange={e => setNewAmount(e.target.value)}
                              placeholder="e.g. 50000"
                              style={{width:"100%", padding:"6px 10px", fontSize:12, border:"1px solid #cbd5e1", borderRadius:6}}
                            />
                          </div>
                        </div>
                        <div style={{display:"flex", gap:8, justifyContent:"flex-end", marginTop:4}}>
                          <Btn v="gray" sz="sm" onClick={() => { setShowForm(false); setEditCode(null); }}>Cancel</Btn>
                          <Btn sz="sm" onClick={() => saveBudgetCode(d)}>Save</Btn>
                        </div>
                      </div>
                    )}

                    {!(d.codes||[]).length
                      ?<div style={{padding:"10px 14px",color:"#94a3b8",fontSize:13}}>No budget codes defined.</div>
                      :<div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                          <thead><tr style={{background:"#f8fafc"}}>
                            {["Code","Description","Allocated","Spent","Reserved","Available","Usage"].map(h=>(
                              <th key={h} style={{padding:"6px 10px",textAlign:["Code","Description"].includes(h)?"left":"right",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>
                            ))}
                            {isAdmin && <th style={{padding:"6px 10px",textAlign:"center",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>Actions</th>}
                          </tr></thead>
                          <tbody>
                            {(d.codes||[]).map((cd,ci)=>{
                              const{spent:cs,reserved:cr}=codeStats(indents,d.id,cd.code);
                              const ca=(cd.amount||0)-cs-cr;
                              const cp=pct(cs+cr,cd.amount||1);
                              return(
                                <tr key={cd.code} style={{borderBottom:"1px solid #f8fafc",background:ci%2?"#fafbfc":"#fff"}}>
                                  <td style={{padding:"7px 10px"}}><span style={{background:c+"18",color:c,fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20}}>{cd.code}</span></td>
                                  <td style={{padding:"7px 10px",color:"#374151",fontSize:11}}>{cd.desc||"--"}</td>
                                  <td style={{padding:"7px 10px",textAlign:"right",fontWeight:600}}>{fmt(cd.amount)}</td>
                                  <td style={{padding:"7px 10px",textAlign:"right",color:"#dc2626",fontWeight:600}}>{fmt(cs)}</td>
                                  <td style={{padding:"7px 10px",textAlign:"right",color:"#d97706",fontWeight:600}}>{fmt(cr)}</td>
                                  <td style={{padding:"7px 10px",textAlign:"right",fontWeight:700,color:ca<0?"#dc2626":"#059669"}}>{fmt(ca)}</td>
                                  <td style={{padding:"7px 10px",textAlign:"right",minWidth:80}}>
                                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                                      <div style={{flex:1,background:"#f1f5f9",borderRadius:99,height:5,overflow:"hidden"}}><div style={{height:"100%",width:cp+"%",background:cp>85?"#dc2626":c}}/></div>
                                      <span style={{fontSize:9,color:"#64748b",minWidth:24}}>{cp}%</span>
                                    </div>
                                  </td>
                                  {isAdmin && (
                                    <td style={{padding:"7px 10px",textAlign:"center",whiteSpace:"nowrap"}}>
                                      <button
                                        onClick={() => {
                                          setShowForm(true);
                                          setEditCode(cd.code);
                                          setNewCode(cd.code);
                                          setNewDesc(cd.desc || "");
                                          setNewAmount(String(cd.amount || 0));
                                        }}
                                        style={{border:"none", background:"transparent", color:"#007878", cursor:"pointer", fontSize:11, fontWeight:600, padding:"2px 6px", marginRight:4}}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        onClick={() => deleteBudgetCode(d, cd.code)}
                                        style={{border:"none", background:"transparent", color:"#dc2626", cursor:"pointer", fontSize:11, fontWeight:600, padding:"2px 6px"}}
                                      >
                                        Delete
                                      </button>
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot><tr style={{background:"#f5f3ff",borderTop:"2px solid #e2e8f0"}}>
                            <td colSpan={2} style={{padding:"6px 10px",fontWeight:700,color:"#5b21b6",fontSize:11}}>TOTAL</td>
                            <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700}}>{fmt(d.budget)}</td>
                            <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#dc2626"}}>{fmt(ds)}</td>
                            <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:"#d97706"}}>{fmt(dr)}</td>
                            <td style={{padding:"6px 10px",textAlign:"right",fontWeight:700,color:da<0?"#dc2626":"#059669"}}>{fmt(da)}</td>
                            <td style={{padding:"6px 10px",textAlign:"right",fontSize:9,color:"#94a3b8"}}>{pct(ds+dr,d.budget||1)}% used</td>
                            {isAdmin && <td></td>}
                          </tr></tfoot>
                        </table>
                      </div>
                    }
                  </div>
                )}
              </Card>
            );
          })}
          <Paginator total={vis.length} page={pg} perPage={PER} onChange={p=>{setPg(p);setExpanded(null);}}/>
        </div>
      }
    </div>
  );
}

// ==================== RAISE INDENT ====================
const newItem=()=>({id:"i"+Date.now()+Math.floor(Math.random()*9999),code:"",desc:"",qty:"1",unit:"",amount:"",vendor:""});

function RaiseIndent({depts,indents,saveIndents,saveDepts,users,user,notify,setPage,myDepts}){
  const [deptId,setDeptId]=useState(myDepts[0]?.id||"");
  const [title,setTitle]=useState("");
  const [notes,setNotes]=useState("");
  const [atts,setAtts]=useState([]);
  const [items,setItems]=useState([newItem()]);
  const [busy,setBusy]=useState(false);

  const dept=depts.find(d=>d.id===deptId)||null;
  const approvers=dept?getDeptApprovers(users,dept.id):[];

  const upd=(idx,f,v)=>setItems(its=>its.map((it,i)=>i===idx?{...it,[f]:v}:it));
  const addRow=()=>setItems(its=>[...its,newItem()]);
  const delRow=idx=>setItems(its=>its.length>1?its.filter((_,i)=>i!==idx):its);

  // Returns available balance for a code, optionally excluding a specific item index
  // so that when editing item[idx], we don't double-count its own current value
  const getAvail=(code,excludeIdx=-1)=>{
    if(!dept||!code)return Infinity;
    const cd=(dept.codes||[]).find(c=>c.code===code);
    if(!cd)return Infinity;
    const{spent,reserved}=codeStats(indents,dept.id,code);
    // Also subtract amounts already entered in OTHER items of this form for the same code
    const siblingTotal=items.reduce((s,it,i)=>{
      if(i===excludeIdx)return s;
      if(it.code===code&&Number(it.amount||0)>0)return s+Number(it.amount||0);
      return s;
    },0);
    return(cd.amount||0)-spent-reserved-siblingTotal;
  };

  const runTotal=items.reduce((s,it)=>s+Number(it.amount||0),0);

  const submit=async()=>{
    if(!deptId){notify("Select a department","error");return;}
    if(!title.trim()){notify("Enter an indent title","error");return;}
    if(approvers.length===0){notify("No approvers configured for this department","error");return;}
    for(let i=0;i<items.length;i++){
      const it=items[i];
      const cd=(dept?.codes||[]).find(c=>c.code===it.code);
      const hasDesc=Boolean(it.desc.trim()||cd?.desc||it.code);
      if(!it.code||!hasDesc||!it.amount){notify("Item "+(i+1)+": fill Code, Description and Amount","error");return;}
      const a=Number(it.amount);
      if(a<=0){notify("Item "+(i+1)+": amount must be > 0","error");return;}
      const av=getAvail(it.code,i);
      if(av!==Infinity&&a>av){notify("Item "+(i+1)+" ("+it.code+"): exceeds available balance "+fmt(av),"error");return;}
    }
    setBusy(true);
    const finalItems=items.map(it=>{
      const cd=(dept?.codes||[]).find(c=>c.code===it.code);
      return {
        ...it,
        desc: it.desc.trim()||cd?.desc||it.code,
        amount:Number(it.amount)||0,
        qty:Number(it.qty)||1,
        itemStatus:"pending"
      };
    });
    const indent={
      id:"IND"+Date.now(),
      deptId:dept.id,title:title.trim(),notes,atts,
      items:finalItems,
      status:"reserved",level:0,
      submittedBy:user.id,
      submittedAt:new Date().toISOString(),
      history:[{action:"submitted",by:user.id,at:new Date().toISOString(),note:"",level:-1}],
    };
    try{
      await API_CALL.createIndent(indent);
      // Reload indents and depts from server (server recomputes financials)
      const [freshIndents,freshDepts]=await Promise.all([API_CALL.getIndents(),API_CALL.getDepts()]);
      await saveIndents(freshIndents);
      await saveDepts(freshDepts);
    }catch(e){setBusy(false);notify(e.message||"Submit failed","error");return;}
    notify("Indent raised successfully");
    setBusy(false);
    setTitle("");setNotes("");setAtts([]);setItems([newItem()]);
    setPage("mine");
  };

  if(!myDepts.length)return <Card style={{textAlign:"center",padding:36}}><div style={{color:"#64748b"}}>Not assigned to any department. Contact admin.</div></Card>;

  return(
    <div>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>Raise Indent</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:18,marginTop:0}}>Add multiple line items. Each item validated against its budget code balance.</p>
      <Card>
        {/* Dept selector */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:6,textTransform:"uppercase"}}>Department *</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {myDepts.map(d=>{
              const c=dcol(depts,d.id);
              return <button key={d.id} onClick={()=>{setDeptId(d.id);setItems([newItem()]);}} style={{padding:"5px 14px",borderRadius:20,border:"2px solid "+(deptId===d.id?c:"#e2e8f0"),background:deptId===d.id?c+"18":"#f8fafc",color:deptId===d.id?c:"#374151",fontWeight:deptId===d.id?700:400,cursor:"pointer",fontSize:13,fontFamily:"inherit"}}>{d.name}</button>;
            })}
          </div>
        </div>

        <Inp label="Indent Title *" value={title} onChange={setTitle} ph="e.g. IT Equipment Purchase Q2 2025"/>

        {/* Line items table */}
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase"}}>Line Items *</div>
            <div style={{fontSize:12,color:"#64748b"}}>Total: <strong style={{color:"#1e293b"}}>{fmt(runTotal)}</strong></div>
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
              <thead>
                <tr style={{background:"#f8fafc"}}>
                  {["#","Budget Code","Description","Qty","Unit","Amount (Rs.)","Vendor",""].map((h,i)=>(
                    <th key={i} style={{padding:"6px 7px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((it,idx)=>{
                  const av=getAvail(it.code,idx);
                  const over=it.code&&av!==Infinity&&Number(it.amount||0)>av;
                  return(
                    <tr key={it.id} style={{borderBottom:"1px solid #f1f5f9",background:over?"#fff5f5":"transparent"}}>
                      <td style={{padding:"5px 7px",color:"#94a3b8",fontWeight:700,fontSize:12,width:26}}>{idx+1}</td>
                      <td style={{padding:"3px 5px",minWidth:110}}>
                        <select value={it.code} onChange={e=>{
                          const val=e.target.value;
                          const cd=(dept?.codes||[]).find(c=>c.code===val);
                          setItems(its=>its.map((item,i)=>i===idx?{
                            ...item,
                            code:val,
                            desc:item.desc.trim()?item.desc:(cd?.desc||val)
                          }:item));
                        }} style={{width:"100%",padding:"5px 7px",border:"1.5px solid "+(over?"#fca5a5":"#e2e8f0"),borderRadius:7,fontFamily:"inherit",fontSize:12,background:"#fafafa"}}>
                          <option value="">-- code --</option>
                          {(dept?.codes||[]).map(c=>{const av2=getAvail(c.code,idx);return <option key={c.code} value={c.code}>{c.code} ({fmt(av2)})</option>;})}
                        </select>
                        {over&&<div style={{fontSize:9,color:"#dc2626",marginTop:1}}>Over: avail {fmt(av)}</div>}
                      </td>
                      <td style={{padding:"3px 5px",minWidth:160}}><input value={it.desc} onChange={e=>upd(idx,"desc",e.target.value)} placeholder="Description" style={{width:"100%",padding:"5px 7px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,background:"#fafafa"}}/></td>
                      <td style={{padding:"3px 5px",width:55}}><input type="number" value={it.qty} onChange={e=>upd(idx,"qty",e.target.value)} min="1" style={{width:"100%",padding:"5px 7px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,background:"#fafafa",textAlign:"right"}}/></td>
                      <td style={{padding:"3px 5px",width:65}}><input value={it.unit} onChange={e=>upd(idx,"unit",e.target.value)} placeholder="Nos" style={{width:"100%",padding:"5px 7px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,background:"#fafafa"}}/></td>
                      <td style={{padding:"3px 5px",width:100}}><input type="number" value={it.amount} onChange={e=>upd(idx,"amount",e.target.value)} placeholder="0" style={{width:"100%",padding:"5px 7px",border:"1.5px solid "+(over?"#fca5a5":"#e2e8f0"),borderRadius:7,fontFamily:"inherit",fontSize:12,background:"#fafafa",textAlign:"right"}}/></td>
                      <td style={{padding:"3px 5px",minWidth:110}}><input value={it.vendor} onChange={e=>upd(idx,"vendor",e.target.value)} placeholder="Vendor" style={{width:"100%",padding:"5px 7px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,background:"#fafafa"}}/></td>
                      <td style={{padding:"3px 5px",width:32,textAlign:"center"}}>
                        {items.length>1&&<button onClick={()=>delRow(idx)} style={{border:"none",background:"#fee2e2",color:"#dc2626",borderRadius:5,cursor:"pointer",width:26,height:26,fontSize:13,fontWeight:700}}>x</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><td colSpan={8} style={{padding:"7px 5px"}}>
                  <button onClick={addRow} style={{display:"flex",alignItems:"center",gap:6,border:"1.5px dashed #007878",background:"#f0f7f7",color:"#007878",borderRadius:7,cursor:"pointer",padding:"5px 13px",fontSize:12,fontWeight:600,fontFamily:"inherit"}}>
                    + Add Line Item
                  </button>
                </td></tr>
                <tr style={{background:"#f5f3ff",borderTop:"2px solid #e2e8f0"}}>
                  <td colSpan={5} style={{padding:"7px 10px",fontWeight:700,color:"#5b21b6",fontSize:13}}>TOTAL ({items.length} item{items.length!==1?"s":""})</td>
                  <td style={{padding:"7px 7px",fontWeight:800,color:"#1e293b",fontSize:14}}>{fmt(runTotal)}</td>
                  <td colSpan={2}/>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <Txt label="Notes" value={notes} onChange={setNotes} ph="Supporting details..."/>
        <AttachUploader atts={atts} onChange={setAtts}/>

        {/* Approval chain */}
        <div style={{marginBottom:14,padding:11,background:"#ede9fe",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:700,color:"#5b21b6",marginBottom:6}}>APPROVAL CHAIN</div>
          {!dept?<div style={{fontSize:12,color:"#94a3b8"}}>Select a department above.</div>
           :approvers.length===0?<div style={{fontSize:12,color:"#dc2626"}}>No approvers configured -- contact admin.</div>
           :<div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
             {approvers.map((a,i)=>(
               <div key={a.userId} style={{display:"flex",alignItems:"center",gap:5}}>
                 <span style={{background:"#fff",border:"1px solid #c4b5fd",color:"#5b21b6",fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20}}>L{a.approverLevel+1}: {a.name}</span>
                 {i<approvers.length-1&&<span style={{color:"#a78bfa"}}>-&gt;</span>}
               </div>
             ))}
           </div>}
        </div>
        <Btn v="blue" sz="lg" onClick={submit} disabled={busy||!dept||approvers.length===0} style={{width:"100%"}}>{busy?"Submitting...":"Raise Indent"}</Btn>
      </Card>
    </div>
  );
}

// ==================== PAGINATOR ====================
function Paginator({total,page,perPage,onChange}){
  const totalPages=Math.max(1,Math.ceil(total/perPage));
  if(totalPages<=1)return null;
  const pages=[];
  // Always show: first, last, current, and up to 2 neighbours
  const show=new Set([1,totalPages,page,page-1,page+1,page-2,page+2].filter(p=>p>=1&&p<=totalPages));
  const sorted=[...show].sort((a,b)=>a-b);
  // Insert ellipsis markers
  const items=[];
  sorted.forEach((p,i)=>{
    if(i>0&&p-sorted[i-1]>1)items.push("...");
    items.push(p);
  });
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:14,padding:"10px 0",borderTop:"1px solid #f1f5f9",flexWrap:"wrap",gap:8}}>
      <div style={{fontSize:12,color:"#64748b"}}>
        Showing <strong>{Math.min((page-1)*perPage+1,total)}-{Math.min(page*perPage,total)}</strong> of <strong>{total}</strong>
      </div>
      <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
        <button onClick={()=>onChange(page-1)} disabled={page===1} style={{border:"1px solid #e2e8f0",background:page===1?"#f8fafc":"#fff",color:page===1?"#cbd5e1":"#374151",borderRadius:7,padding:"4px 10px",cursor:page===1?"not-allowed":"pointer",fontFamily:"inherit",fontSize:12,fontWeight:600}}>Prev</button>
        {items.map((item,i)=>
          item==="..."
            ?<span key={"e"+i} style={{color:"#94a3b8",fontSize:13,padding:"0 2px"}}>...</span>
            :<button key={item} onClick={()=>onChange(item)} style={{border:"1px solid "+(page===item?"#007878":"#e2e8f0"),background:page===item?"#007878":"#fff",color:page===item?"#fff":"#374151",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:page===item?700:400,minWidth:32}}>{item}</button>
        )}
        <button onClick={()=>onChange(page+1)} disabled={page===totalPages} style={{border:"1px solid #e2e8f0",background:page===totalPages?"#f8fafc":"#fff",color:page===totalPages?"#cbd5e1":"#374151",borderRadius:7,padding:"4px 10px",cursor:page===totalPages?"not-allowed":"pointer",fontFamily:"inherit",fontSize:12,fontWeight:600}}>Next</button>
      </div>
    </div>
  );
}

// ==================== MY INDENTS ====================
function MyIndents({indents,depts,users,user,setPage}){
  const mine=(indents||[]).filter(e=>e.submittedBy===user.id).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  const [open,setOpen]=useState(null);
  const [pg,setPg]=useState(1);
  const PER=10;
  const paged=mine.slice((pg-1)*PER,pg*PER);
  if(!mine.length)return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h2 style={{fontWeight:800,color:"#1e1b4b",margin:0,fontSize:22}}>My Indents</h2>
        <Btn v="blue" onClick={()=>setPage("raise")}>Raise New Indent</Btn>
      </div>
      <Card style={{textAlign:"center",padding:36}}>
        <div style={{color:"#64748b"}}>No indents raised yet.</div>
      </Card>
    </div>
  );
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div>
          <h2 style={{fontWeight:800,color:"#1e1b4b",margin:0,fontSize:22}}>My Indents</h2>
          <p style={{color:"#64748b",fontSize:13,margin:0}}>{mine.length} total -- click to see timeline</p>
        </div>
        <Btn v="blue" onClick={()=>setPage("raise")}>Raise New Indent</Btn>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {paged.map(e=>{
          const dept=depts.find(d=>d.id===e.deptId);
          const aprs=getDeptApprovers(users,e.deptId);
          const sm=STS[e.status]||{label:e.status,color:"#64748b",bg:"#f1f5f9"};
          const isOpen=open===e.id;
          const pApr=e.status==="reserved"?aprs[e.level]:null;
          return(
            <Card key={e.id} style={{borderLeft:"4px solid "+sm.color}}>
              <div onClick={()=>setOpen(isOpen?null:e.id)} style={{cursor:"pointer"}}>
                <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                      <span style={{fontWeight:700,color:"#1e293b",fontSize:14}}>{e.title||e.id}</span>
                      <Badge label={sm.label} color={sm.color} bg={sm.bg}/>
                    </div>
                    <div style={{fontSize:11,color:"#94a3b8"}}>{e.id} -- {dept?.name} -- {(e.items||[]).length} item(s) -- {new Date(e.submittedAt).toLocaleDateString("en-IN")}</div>
                    {pApr&&<div style={{fontSize:11,color:"#d97706",marginTop:3,fontWeight:600}}>Waiting for L{e.level+1}: {pApr.name}</div>}
                    {e.status==="revision"&&<div style={{fontSize:11,color:"#7c3aed",marginTop:3,fontWeight:600}}>Sent back for revision</div>}
                    {e.status==="rejected"&&<div style={{fontSize:11,color:"#dc2626",marginTop:3,fontWeight:600}}>Rejected</div>}
                    {(e.status==="approved"||e.status==="partial")&&<div style={{fontSize:11,color:"#059669",marginTop:3,fontWeight:600}}>Approved: {fmt(approvedAmt(e))} of {fmt(totalAmt(e))}</div>}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{textAlign:"right"}}><div style={{fontSize:17,fontWeight:800,color:"#1e293b"}}>{fmt(totalAmt(e))}</div><div style={{fontSize:9,color:"#94a3b8"}}>requested</div></div>
                    <span style={{color:"#94a3b8",fontSize:11}}>{isOpen?"^":"v"}</span>
                  </div>
                </div>
              </div>
              {isOpen&&(
                <div style={{marginTop:10,borderTop:"1px solid #f1f5f9",paddingTop:10}}>
                  {/* Items table */}
                  <div style={{overflowX:"auto",marginBottom:10}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead><tr style={{background:"#f8fafc"}}>
                        {["#","Code","Description","Qty","Amount","Vendor","Status"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0"}}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {(e.items||[]).map((it,i)=>{
                          const iSt=it.itemStatus==="approved"?{c:"#059669",bg:"#dcfce7",l:"Approved"}:it.itemStatus==="rejected"?{c:"#dc2626",bg:"#fee2e2",l:"Rejected"}:{c:"#d97706",bg:"#fef9c3",l:"Pending"};
                          return(
                            <tr key={i} style={{borderBottom:"1px solid #f8fafc"}}>
                              <td style={{padding:"5px 8px",color:"#94a3b8"}}>{i+1}</td>
                              <td style={{padding:"5px 8px"}}><span style={{background:"#00787818",color:"#007878",fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20}}>{it.code}</span></td>
                              <td style={{padding:"5px 8px",fontWeight:500}}>{it.desc}</td>
                              <td style={{padding:"5px 8px",color:"#64748b"}}>{it.qty} {it.unit}</td>
                              <td style={{padding:"5px 8px",fontWeight:700}}>{fmt(it.amount)}</td>
                              <td style={{padding:"5px 8px",color:"#64748b",fontSize:11}}>{it.vendor||"--"}</td>
                              <td style={{padding:"5px 8px"}}><Badge label={iSt.l} color={iSt.c} bg={iSt.bg}/></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",marginBottom:5,textTransform:"uppercase"}}>Approval Timeline</div>
                  <Timeline indent={e} approvers={aprs}/>
                  {e.notes&&<div style={{fontSize:11,color:"#64748b",fontStyle:"italic",marginTop:6}}>Notes: "{e.notes}"</div>}
                  <AttachViewer atts={e.atts || e.attachments}/>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <Paginator total={mine.length} page={pg} perPage={PER} onChange={p=>{setPg(p);setOpen(null);}}/>
    </div>
  );
}

// ==================== ALL INDENTS (admin) ====================
function AllIndents({indents,depts,users,notify}){
  const [filter,setFilter]=useState("all");
  const [deptF,setDeptF]=useState("all");
  const [open,setOpen]=useState(null);
  const [pg,setPg]=useState(1);
  const PER=10;
  let list=filter==="all"?(indents||[]):(indents||[]).filter(e=>e.status===filter);
  if(deptF!=="all")list=list.filter(e=>e.deptId===deptF);
  const sorted=[...list].sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  const paged=sorted.slice((pg-1)*PER,pg*PER);
  const counts={};
  ["all","reserved","approved","partial","rejected","revision"].forEach(s=>{counts[s]=s==="all"?(indents||[]).length:(indents||[]).filter(e=>e.status===s).length;});
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div>
          <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>All Indents</h2>
          <p style={{color:"#64748b",fontSize:13,margin:0}}>Full view across all departments</p>
        </div>
        <Btn v="green" onClick={()=>exportXLS(indents,depts)}>Export to Excel</Btn>
      </div>
      <div style={{display:"flex",gap:7,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
        {Object.entries(counts).map(([s,n])=>(
          <button key={s} onClick={()=>{setFilter(s);setPg(1);}} style={{border:"none",padding:"4px 12px",borderRadius:20,cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600,background:filter===s?"#007878":"#f1f5f9",color:filter===s?"#fff":"#64748b"}}>
            {s.charAt(0).toUpperCase()+s.slice(1)} ({n})
          </button>
        ))}
        <select value={deptF} onChange={e=>{setDeptF(e.target.value);setPg(1);}} style={{marginLeft:"auto",padding:"4px 10px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}>
          <option value="all">All Depts</option>
          {(depts||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      {!sorted.length
        ?<Card style={{textAlign:"center",padding:36}}><div style={{color:"#64748b"}}>No indents found.</div></Card>
        :<div style={{display:"flex",flexDirection:"column",gap:9}}>
          {paged.map(e=>{
            const dept=(depts||[]).find(d=>d.id===e.deptId);
            const aprs=getDeptApprovers(users,e.deptId);
            const sm=STS[e.status]||{label:e.status,color:"#64748b",bg:"#f1f5f9"};
            const isOpen=open===e.id;
            return(
              <Card key={e.id} style={{borderLeft:"4px solid "+sm.color}}>
                <div onClick={()=>setOpen(isOpen?null:e.id)} style={{cursor:"pointer"}}>
                  <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                        <span style={{fontWeight:700,color:"#1e293b"}}>{e.title||e.id}</span>
                        <Badge label={sm.label} color={sm.color} bg={sm.bg}/>
                      </div>
                      <div style={{fontSize:11,color:"#94a3b8"}}>{e.id} -- {dept?.name} -- {(e.items||[]).length} items -- By: {e.submittedBy} -- {new Date(e.submittedAt).toLocaleDateString("en-IN")}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:15,fontWeight:800,color:"#1e293b"}}>{fmt(totalAmt(e))}</div>
                        {approvedAmt(e)>0&&approvedAmt(e)<totalAmt(e)&&<div style={{fontSize:9,color:"#059669"}}>{fmt(approvedAmt(e))} approved</div>}
                      </div>
                      <span style={{color:"#94a3b8",fontSize:11}}>{isOpen?"^":"v"}</span>
                    </div>
                  </div>
                </div>
                {isOpen&&(
                  <div style={{marginTop:10,borderTop:"1px solid #f1f5f9",paddingTop:10}}>
                    <div style={{overflowX:"auto",marginBottom:8}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                        <thead><tr style={{background:"#f8fafc"}}>{["#","Code","Description","Qty","Amount","Vendor","Status"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0"}}>{h}</th>)}</tr></thead>
                        <tbody>{(e.items||[]).map((it,i)=>{const st=it.itemStatus==="approved"?{c:"#059669",bg:"#dcfce7",l:"Approved"}:it.itemStatus==="rejected"?{c:"#dc2626",bg:"#fee2e2",l:"Rejected"}:{c:"#d97706",bg:"#fef9c3",l:"Pending"};return(<tr key={i} style={{borderBottom:"1px solid #f8fafc"}}><td style={{padding:"5px 8px",color:"#94a3b8"}}>{i+1}</td><td style={{padding:"5px 8px"}}><span style={{background:"#00787818",color:"#007878",fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20}}>{it.code}</span></td><td style={{padding:"5px 8px"}}>{it.desc}</td><td style={{padding:"5px 8px",color:"#64748b"}}>{it.qty} {it.unit}</td><td style={{padding:"5px 8px",fontWeight:700}}>{fmt(it.amount)}</td><td style={{padding:"5px 8px",color:"#64748b",fontSize:11}}>{it.vendor||"--"}</td><td style={{padding:"5px 8px"}}><Badge label={st.l} color={st.c} bg={st.bg}/></td></tr>);})}</tbody>
                      </table>
                    </div>
                    <Timeline indent={e} approvers={aprs}/>
                    <AttachViewer atts={e.atts || e.attachments}/>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      }
    </div>
  );
}

// ==================== PROCUREMENT DASHBOARD ====================
function ProcDashboard({indents,depts}){
  const now=new Date();
  const [monthF,setMonthF]=useState(now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0"));
  const [deptF,setDeptF]=useState("all");

  // Generate last 24 months for filter
  const monthOptions=[];
  for(let i=0;i<24;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const val=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
    const label=d.toLocaleString("en-IN",{month:"long",year:"numeric"});
    monthOptions.push({val,label});
  }

  // Filter indents by month (based on submittedAt) and dept
  const filtered=(indents||[]).filter(e=>{
    if(deptF!=="all"&&e.deptId!==deptF)return false;
    if(monthF!=="all"){
      const m=e.submittedAt?e.submittedAt.slice(0,7):"";
      if(m!==monthF)return false;
    }
    return true;
  });

  const total=filtered.length;
  const procClosed=filtered.filter(e=>e.procClosed).length;
  const l3Approved=filtered.filter(e=>e.status==="approved"||e.status==="partial").length;
  const pending=filtered.filter(e=>e.status==="reserved").length;
  const open=total-procClosed;

  // Per-dept stats for filtered set
  const deptStats=(deptF==="all"?depts:depts.filter(d=>d.id===deptF)).map((d,i)=>{
    const di=filtered.filter(e=>e.deptId===d.id);
    return{d,i,total:di.length,procClosed:di.filter(e=>e.procClosed).length,l3:di.filter(e=>e.status==="approved"||e.status==="partial").length,pending:di.filter(e=>e.status==="reserved").length};
  });

  return(
    <div>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>Procurement Dashboard</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:16,marginTop:0}}>Track indents raised and procurement closures by month and department.</p>

      {/* Filters */}
      <div style={{display:"flex",gap:10,marginBottom:18,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:12,fontWeight:600,color:"#64748b"}}>Month:</span>
          <select value={monthF} onChange={e=>setMonthF(e.target.value)} style={{padding:"6px 10px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,minWidth:150}}>
            <option value="all">All Time</option>
            {monthOptions.map(m=><option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:12,fontWeight:600,color:"#64748b"}}>Department:</span>
          <select value={deptF} onChange={e=>setDeptF(e.target.value)} style={{padding:"6px 10px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,minWidth:150}}>
            <option value="all">All Departments</option>
            {(depts||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        {(monthF!==now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")||deptF!=="all")&&(
          <button onClick={()=>{setMonthF(now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0"));setDeptF("all");}} style={{fontSize:11,padding:"4px 10px",borderRadius:20,border:"1px solid #e2e8f0",background:"#f1f5f9",cursor:"pointer",color:"#64748b",fontFamily:"inherit"}}>Reset</button>
        )}
      </div>

      {/* KPI cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:22}}>
        {[
          ["Indents Raised",total,"#007878"],
          ["Proc. Closed",procClosed,"#059669"],
          ["Open (not closed)",open,"#d97706"],
          ["L3 Approved",l3Approved,"#0891b2"],
          ["Pending Approval",pending,"#dc2626"],
        ].map(([l,v,c])=>(
          <Card key={l} style={{display:"flex",alignItems:"center",gap:10,padding:14}}>
            <div style={{width:34,height:34,borderRadius:9,background:c+"22",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{width:12,height:12,borderRadius:2,background:c}}/>
            </div>
            <div><div style={{fontSize:20,fontWeight:800,color:"#1e293b"}}>{v}</div><div style={{fontSize:10,color:"#94a3b8",lineHeight:1.3}}>{l}</div></div>
          </Card>
        ))}
      </div>

      {/* Closure progress */}
      {total>0&&(
        <Card style={{marginBottom:18,padding:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:13,fontWeight:700,color:"#374151"}}>Procurement Closure Progress</span>
            <span style={{fontSize:13,fontWeight:800,color:procClosed===total?"#059669":"#d97706"}}>{total?Math.round(procClosed/total*100):0}%</span>
          </div>
          <div style={{background:"#f1f5f9",borderRadius:99,height:10,overflow:"hidden"}}>
            <div style={{height:"100%",width:(total?Math.round(procClosed/total*100):0)+"%",background:procClosed===total?"#059669":"#007878",transition:"width .4s",borderRadius:99}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:11,color:"#94a3b8"}}>
            <span>{procClosed} closed</span>
            <span>{open} remaining</span>
          </div>
        </Card>
      )}

      {/* Per-department breakdown */}
      {!deptStats.length||!deptStats.some(s=>s.total>0)
        ?<Card style={{textAlign:"center",padding:28}}><div style={{color:"#64748b"}}>No indents in this period.</div></Card>
        :<Card style={{padding:0,overflow:"hidden"}}>
          <div style={{padding:"12px 14px 10px",fontWeight:700,color:"#374151",fontSize:13,borderBottom:"1px solid #e2e8f0"}}>Breakdown by Department</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr style={{background:"#f8fafc"}}>
                {["Department","Raised","Proc. Closed","Open","L3 Approved","Pending","Closure %"].map(h=>(
                  <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deptStats.filter(s=>s.total>0).map(({d,i,total:dt,procClosed:dc,l3,pending:dp})=>{
                const c=PAL[i%PAL.length];
                const closePct=dt?Math.round(dc/dt*100):0;
                return(
                  <tr key={d.id} style={{borderBottom:"1px solid #f8fafc",background:i%2?"#fafbfc":"#fff"}}>
                    <td style={{padding:"9px 12px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:26,height:26,borderRadius:6,background:c+"22",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,color:c,fontSize:11,flexShrink:0}}>{d.name[0]}</div>
                        <div style={{fontWeight:600,color:"#1e293b",fontSize:12}}>{d.name}</div>
                      </div>
                    </td>
                    <td style={{padding:"9px 12px",fontWeight:700,color:"#1e293b"}}>{dt}</td>
                    <td style={{padding:"9px 12px",fontWeight:700,color:"#059669"}}>{dc}</td>
                    <td style={{padding:"9px 12px",fontWeight:700,color:dt-dc>0?"#d97706":"#94a3b8"}}>{dt-dc}</td>
                    <td style={{padding:"9px 12px",color:"#0891b2",fontWeight:600}}>{l3}</td>
                    <td style={{padding:"9px 12px",color:dp>0?"#dc2626":"#94a3b8",fontWeight:600}}>{dp}</td>
                    <td style={{padding:"9px 12px",minWidth:120}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{flex:1,background:"#f1f5f9",borderRadius:99,height:6,overflow:"hidden"}}>
                          <div style={{height:"100%",width:closePct+"%",background:closePct===100?"#059669":c}}/>
                        </div>
                        <span style={{fontSize:10,fontWeight:600,color:closePct===100?"#059669":"#64748b",minWidth:28}}>{closePct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{background:"#f5f3ff",borderTop:"2px solid #e2e8f0"}}>
                <td style={{padding:"8px 12px",fontWeight:700,color:"#5b21b6",fontSize:11}}>TOTAL</td>
                <td style={{padding:"8px 12px",fontWeight:800,color:"#1e293b"}}>{total}</td>
                <td style={{padding:"8px 12px",fontWeight:800,color:"#059669"}}>{procClosed}</td>
                <td style={{padding:"8px 12px",fontWeight:800,color:open>0?"#d97706":"#94a3b8"}}>{open}</td>
                <td style={{padding:"8px 12px",fontWeight:700,color:"#0891b2"}}>{l3Approved}</td>
                <td style={{padding:"8px 12px",fontWeight:700,color:pending>0?"#dc2626":"#94a3b8"}}>{pending}</td>
                <td style={{padding:"8px 12px",fontSize:10,color:"#64748b"}}>{total?Math.round(procClosed/total*100):0}% overall</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      }
    </div>
  );
}

// ==================== PROCUREMENT INDENTS ====================
function ProcIndents({indents,depts,saveIndents,user,notify}){
  const [deptF,setDeptF]=useState("all");
  const [statusF,setStatusF]=useState("all");
  const [checked,setChecked]=useState({});
  const [saving,setSaving]=useState(false);
  const [openId,setOpenId]=useState(null);
  const [pg,setPg]=useState(1);
  const PER=10;

  // RFQ state per indent
  const [rfq,setRfq]=useState({});
  const updRfq=(id,patch)=>setRfq(r=>({...r,[id]:{...(r[id]||{}), ...patch}}));

  // Send RFQ via Backend SMTP
  const sendRFQ=async(e,dept)=>{
    const r=rfq[e.id]||{};
    const rawEmails=(r.emails||"").trim();
    if(!rawEmails){notify("Enter at least one vendor email","error");return;}
    const emails=rawEmails.split(",").map(s=>s.trim()).filter(Boolean);
    const badEmail=emails.find(em=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em));
    if(badEmail){notify("Invalid email: "+badEmail,"error");return;}

    updRfq(e.id,{sending:true,error:""});

    try {
      await API_CALL.sendRFQ(e.id, emails);
      const fresh=await API_CALL.getIndents();
      await saveIndents(fresh);
      updRfq(e.id,{sending:false,sent:true,sentEmails:emails,error:""});
      notify("RFQ sent successfully to "+emails.length+" vendor(s)");
    } catch (err) {
      updRfq(e.id,{sending:false,sent:false,error:err.message});
      notify("Failed to send RFQ: "+err.message,"error");
    }
  };

  // "l3done" = L3 final approved by approval chain
  const l3Done=e=>e.status==="approved"||e.status==="partial";

  // Get the L3 approval timestamp
  const l3Date=e=>{
    if(!l3Done(e))return null;
    const acts=(e.history||[]).filter(h=>h.action==="approve");
    if(!acts.length)return null;
    return acts.sort((a,b)=>new Date(a.at)-new Date(b.at)).slice(-1)[0]?.at||null;
  };

  // Filtering
  let list=(indents||[]).filter(e=>{
    if(deptF!=="all"&&e.deptId!==deptF)return false;
    if(statusF==="proc-closed"&&!e.procClosed)return false;
    if(statusF==="proc-open"&&(e.procClosed||e.status==="rejected"))return false;
    if(statusF==="l3approved"&&!l3Done(e))return false;
    if(statusF==="pending"&&e.status!=="reserved")return false;
    if(statusF==="rejected"&&e.status!=="rejected")return false;
    return true;
  });

  // Sort by L3 approval date ASC (oldest first), non-approved by submitted date
  list=[...list].sort((a,b)=>{
    const da=l3Date(a)||a.submittedAt||"";
    const db=l3Date(b)||b.submittedAt||"";
    return new Date(da)-new Date(db);
  });
  const paged=list.slice((pg-1)*PER,pg*PER);

  const checkedCount=Object.values(checked).filter(Boolean).length;
  const toggleAll=()=>{
    const allChecked=list.every(e=>checked[e.id]);
    const upd={};
    list.forEach(e=>{upd[e.id]=!allChecked;});
    setChecked(upd);
  };

  const markClosed=async()=>{
    const toClose=list.filter(e=>checked[e.id]&&!e.procClosed);
    if(!toClose.length){notify("No unclosed indents selected","error");return;}
    setSaving(true);
    const now=new Date().toISOString();
    try{
      await Promise.all(toClose.map(e=>API_CALL.updateIndent(e.id,{...e,procClosed:true,procClosedAt:now,procClosedBy:user.id})));
      const fresh=await API_CALL.getIndents();
      await saveIndents(fresh);
      notify(toClose.length+" indent(s) marked as procurement closed");
    }catch(e){notify(e.message||"Save failed","error");setSaving(false);return;}
    setSaving(false);
    setChecked({});
  };

  const exportProcXLS=()=>{
    const rows=list.flatMap(e=>{
      const dname=(depts||[]).find(d=>d.id===e.deptId)?.name||e.deptId;
      const finDate=l3Date(e);
      return(e.items||[]).map((it,idx)=>({
        "Indent ID":e.id,
        "Department":dname,
        "Title":e.title||"",
        "Submitted By":e.submittedBy,
        "Submitted Date":e.submittedAt?new Date(e.submittedAt).toLocaleDateString("en-IN"):"",
        "L3 Approved Date":finDate?new Date(finDate).toLocaleDateString("en-IN"):"Not yet",
        "Indent Status":STS[e.status]?.label||e.status,
        "Proc. Closed":e.procClosed?"Yes":"No",
        "Proc. Closed Date":e.procClosedAt?new Date(e.procClosedAt).toLocaleDateString("en-IN"):"",
        "Proc. Closed By":e.procClosedBy||"",
        "Item #":idx+1,
        "Budget Code":it.code,
        "Description":it.desc,
        "Qty":it.qty||1,
        "Unit":it.unit||"",
        "Amount":Number(it.amount||0),
        "Vendor":it.vendor||"",
        "Item Status":it.itemStatus==="approved"?"Approved":it.itemStatus==="rejected"?"Rejected":"Pending",
      }));
    });
    if(!rows.length){rows.push({"Note":"No indents match the current filter"});}
    const ws=XLSX.utils.json_to_sheet(rows);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"Procurement Indents");
    XLSX.writeFile(wb,"Procurement_Indents_"+new Date().toISOString().slice(0,10)+".xlsx");
  };

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div>
          <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>Indents</h2>
          <p style={{color:"#64748b",fontSize:13,margin:0}}>Sorted by L3 approval date (oldest first). {list.length} indent(s) shown.</p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {checkedCount>0&&(
            <Btn v="teal" onClick={markClosed} disabled={saving}>
              {saving?"Saving...":"Mark "+checkedCount+" as Proc. Closed"}
            </Btn>
          )}
          <span style={{fontSize:11,color:"#059669",fontWeight:700,background:"#dcfce7",border:"1px solid #bbf7d0",padding:"6px 12px",borderRadius:8,display:"inline-flex",alignItems:"center"}}>
            SMTP Active (Backend)
          </span>
          <Btn v="green" onClick={exportProcXLS}>Export to Excel</Btn>
        </div>
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:12,fontWeight:600,color:"#64748b"}}>Department:</span>
          <select value={deptF} onChange={e=>{setDeptF(e.target.value);setPg(1);}} style={{padding:"5px 10px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,minWidth:140}}>
            <option value="all">All Departments</option>
            {(depts||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:12,fontWeight:600,color:"#64748b"}}>Status:</span>
          <select value={statusF} onChange={e=>{setStatusF(e.target.value);setPg(1);}} style={{padding:"5px 10px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,minWidth:160}}>
            <option value="all">All</option>
            <option value="proc-open">Proc. Open (action needed)</option>
            <option value="proc-closed">Proc. Closed</option>
            <option value="l3approved">L3 Approved (not yet closed)</option>
            <option value="pending">Pending Approval</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        {(deptF!=="all"||statusF!=="all")&&(
          <button onClick={()=>{setDeptF("all");setStatusF("all");}} style={{fontSize:11,padding:"4px 10px",borderRadius:20,border:"1px solid #e2e8f0",background:"#f1f5f9",cursor:"pointer",color:"#64748b",fontFamily:"inherit"}}>
            Clear filters
          </button>
        )}
      </div>

      {/* Select all / action bar */}
      {list.length>0&&(
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10,padding:"8px 12px",background:"#f8fafc",borderRadius:8,border:"1px solid #e2e8f0"}}>
          <label style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer",fontSize:12,fontWeight:600,color:"#374151"}}>
            <input type="checkbox"
              checked={list.length>0&&list.every(e=>checked[e.id])}
              onChange={toggleAll}
              style={{width:15,height:15,cursor:"pointer",accentColor:"#059669"}}
            />
            Select All ({list.length})
          </label>
          {checkedCount>0&&(
            <span style={{fontSize:12,color:"#059669",fontWeight:600}}>{checkedCount} selected</span>
          )}
          <span style={{fontSize:11,color:"#94a3b8",marginLeft:"auto"}}>
            Check indents you have completed, then click "Mark as Proc. Closed"
          </span>
        </div>
      )}

      {!list.length
        ?<Card style={{textAlign:"center",padding:36}}><div style={{color:"#64748b"}}>No indents match the current filter.</div></Card>
        :<div style={{display:"flex",flexDirection:"column",gap:9}}>
          {paged.map(e=>{
            const dept=(depts||[]).find(d=>d.id===e.deptId);
            const sm=STS[e.status]||{label:e.status,color:"#64748b",bg:"#f1f5f9"};
            const isL3Done=l3Done(e);
            const isProcClosed=e.procClosed||false;
            const finDate=l3Date(e);
            const isOpen=openId===e.id;
            const isChecked=checked[e.id]||false;
            const approvedItems=(e.items||[]).filter(it=>it.itemStatus==="approved");
            const approvedTotal=approvedItems.reduce((s,it)=>s+Number(it.amount||0),0);
            const borderColor=isProcClosed?"#059669":sm.color;

            return(
              <Card key={e.id} style={{borderLeft:"4px solid "+borderColor,background:isProcClosed?"#f0fdf4":"#fff"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                  {/* Checkbox */}
                  <div style={{paddingTop:2,flexShrink:0}}>
                    <input type="checkbox"
                      checked={isChecked}
                      onChange={ev=>{ev.stopPropagation();setChecked(c=>({...c,[e.id]:ev.target.checked}));}}
                      disabled={isProcClosed}
                      style={{width:16,height:16,cursor:isProcClosed?"not-allowed":"pointer",accentColor:"#059669",marginTop:2}}
                    />
                  </div>

                  {/* Main content */}
                  <div style={{flex:1,minWidth:0}}>
                    <div onClick={()=>setOpenId(isOpen?null:e.id)} style={{cursor:"pointer"}}>
                      <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                            <span style={{fontWeight:700,color:"#1e293b",fontSize:14}}>{e.title||e.id}</span>
                            <Badge label={sm.label} color={sm.color} bg={sm.bg}/>
                            {isProcClosed&&<Badge label="Proc. Closed" color="#166534" bg="#dcfce7"/>}
                            {isL3Done&&!isProcClosed&&<Badge label="Awaiting Proc. Closure" color="#d97706" bg="#fef9c3"/>}
                          </div>
                          <div style={{fontSize:11,color:"#94a3b8",display:"flex",flexWrap:"wrap",gap:8}}>
                            <span>{e.id}</span>
                            <span>Dept: <strong style={{color:"#374151"}}>{dept?.name||e.deptId}</strong></span>
                            <span>By: {e.submittedBy}</span>
                            <span>Raised: {e.submittedAt?new Date(e.submittedAt).toLocaleDateString("en-IN"):""}</span>
                            {finDate&&<span style={{color:"#059669",fontWeight:600}}>L3 Approved: {new Date(finDate).toLocaleDateString("en-IN")}</span>}
                            {isProcClosed&&<span style={{color:"#059669",fontWeight:600}}>Closed: {e.procClosedAt?new Date(e.procClosedAt).toLocaleDateString("en-IN"):""} by {e.procClosedBy}</span>}
                          </div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:800,color:"#1e293b"}}>Rs.{Number(totalAmt(e)||0).toLocaleString("en-IN",{maximumFractionDigits:0})}</div>
                            {isL3Done&&approvedTotal<totalAmt(e)&&<div style={{fontSize:9,color:"#059669"}}>Approved: Rs.{Number(approvedTotal).toLocaleString("en-IN",{maximumFractionDigits:0})}</div>}
                            <div style={{fontSize:9,color:"#94a3b8"}}>{(e.items||[]).length} item(s)</div>
                          </div>
                          <span style={{color:"#94a3b8",fontSize:11}}>{isOpen?"^":"v"}</span>
                        </div>
                      </div>
                    </div>

                    {isOpen&&(
                      <div style={{marginTop:10,borderTop:"1px solid #f1f5f9",paddingTop:10}}>
                        <div style={{overflowX:"auto"}}>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                            <thead>
                              <tr style={{background:"#f8fafc"}}>
                                {["#","Code","Description","Qty","Unit","Amount","Vendor","Status"].map(h=>(
                                  <th key={h} style={{padding:"6px 10px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(e.items||[]).map((it,i)=>{
                                const ist=it.itemStatus==="approved"?{c:"#059669",bg:"#dcfce7",l:"Approved"}:it.itemStatus==="rejected"?{c:"#dc2626",bg:"#fee2e2",l:"Rejected"}:{c:"#d97706",bg:"#fef9c3",l:"Pending"};
                                return(
                                  <tr key={i} style={{borderBottom:"1px solid #f8fafc",background:it.itemStatus==="approved"?"#f0fdf4":it.itemStatus==="rejected"?"#fff5f5":"#fff"}}>
                                    <td style={{padding:"6px 10px",color:"#94a3b8"}}>{i+1}</td>
                                    <td style={{padding:"6px 10px"}}><span style={{background:"#00787818",color:"#007878",fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20}}>{it.code}</span></td>
                                    <td style={{padding:"6px 10px",fontWeight:500}}>{it.desc}</td>
                                    <td style={{padding:"6px 10px",color:"#64748b"}}>{it.qty}</td>
                                    <td style={{padding:"6px 10px",color:"#64748b"}}>{it.unit}</td>
                                    <td style={{padding:"6px 10px",fontWeight:700}}>Rs.{Number(it.amount||0).toLocaleString("en-IN",{maximumFractionDigits:0})}</td>
                                    <td style={{padding:"6px 10px",color:"#64748b",fontSize:11}}>{it.vendor||"--"}</td>
                                    <td style={{padding:"6px 10px"}}><Badge label={ist.l} color={ist.c} bg={ist.bg}/></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            {isL3Done&&(
                              <tfoot>
                                <tr style={{background:"#f0fdf4",borderTop:"2px solid #bbf7d0"}}>
                                  <td colSpan={5} style={{padding:"7px 10px",fontWeight:700,color:"#166534",fontSize:11}}>APPROVED TOTAL</td>
                                  <td style={{padding:"7px 10px",fontWeight:800,color:"#059669"}}>Rs.{Number(approvedTotal).toLocaleString("en-IN",{maximumFractionDigits:0})}</td>
                                  <td colSpan={2}/>
                                </tr>
                              </tfoot>
                            )}
                          </table>
                        </div>
                        {e.notes&&<div style={{fontSize:11,color:"#64748b",fontStyle:"italic",marginTop:8}}>Notes: "{e.notes}"</div>}
                        <AttachViewer atts={e.atts || e.attachments}/>

                        {/* == RFQ PANEL == */}
                        <div style={{marginTop:14,padding:14,background:"#f0f9ff",borderRadius:10,border:"1px solid #bae6fd"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                            <div style={{fontWeight:700,color:"#0369a1",fontSize:13}}>Send Request for Quotation (RFQ)</div>
                            <span style={{fontSize:10,color:"#059669",fontWeight:600,background:"#dcfce7",padding:"2px 8px",borderRadius:20}}>
                              SMTP backend active
                            </span>
                          </div>
                          {e.rfqSentAt&&(
                            <div style={{marginBottom:10,padding:"7px 12px",background:"#dcfce7",borderRadius:7,fontSize:12,color:"#166534",fontWeight:600}}>
                              Last RFQ sent: {new Date(e.rfqSentAt).toLocaleDateString("en-IN")} to: {(e.rfqVendors||[]).join(", ")}
                            </div>
                          )}
                          {rfq[e.id]?.sent&&(
                            <div style={{marginBottom:10,padding:"7px 12px",background:"#dcfce7",borderRadius:7,fontSize:12,color:"#166534",fontWeight:600}}>
                              Sent successfully to: {(rfq[e.id]?.sentEmails||[]).join(", ")}
                            </div>
                          )}
                          {rfq[e.id]?.error&&(
                            <div style={{marginBottom:10,padding:"7px 12px",background:"#fee2e2",borderRadius:7,fontSize:12,color:"#991b1b"}}>
                              Error: {rfq[e.id].error}
                            </div>
                          )}
                          <div style={{fontSize:11,color:"#0891b2",marginBottom:8}}>
                            RFQ will be emailed to each vendor individually listing all {(e.items||[]).filter(it=>it.itemStatus==="approved").length} approved item(s).
                          </div>
                          <div style={{display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                            <div style={{flex:1,minWidth:220}}>
                              <label style={{display:"block",fontSize:10,fontWeight:700,color:"#0369a1",marginBottom:4,textTransform:"uppercase"}}>
                                Vendor Email IDs * (comma-separated)
                              </label>
                              <textarea
                                value={rfq[e.id]?.emails||""}
                                onChange={ev=>updRfq(e.id,{emails:ev.target.value,sent:false,error:""})}
                                placeholder="vendor1@company.com, vendor2@firm.in, vendor3@org.com"
                                rows={2}
                                style={{width:"100%",padding:"7px 10px",border:"1.5px solid #7dd3fc",borderRadius:7,fontFamily:"inherit",fontSize:12,resize:"vertical",background:"#fff",boxSizing:"border-box"}}
                              />
                            </div>
                            <div style={{paddingTop:20}}>
                              <Btn
                                v="blue"
                                onClick={()=>sendRFQ(e,dept)}
                                disabled={rfq[e.id]?.sending||!(e.items||[]).some(it=>it.itemStatus==="approved")}
                              >
                                {rfq[e.id]?.sending?"Sending...":"Send RFQ"}
                              </Btn>
                            </div>
                          </div>
                          {!(e.items||[]).some(it=>it.itemStatus==="approved")&&(
                            <div style={{fontSize:11,color:"#64748b",marginTop:6}}>
                              Note: RFQ requires at least one approved line item.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      }
      <Paginator total={list.length} page={pg} perPage={PER} onChange={p=>{setPg(p);setOpenId(null);}}/>
    </div>
  );
}

// ==================== APPROVALS ====================
function Approvals({indents,saveIndents,depts,saveDepts,users,user,apprLvl,apprDepts,notify,approvalLimits}){
  // approvalLimits: {l1Limit, l2Limit} — determines how many levels needed per indent
  const getMaxLevel=(amt)=>{
    const l1=approvalLimits?.l1Limit||200000;
    const l2=approvalLimits?.l2Limit||500000;
    if(amt<l1)return 1;
    if(amt<l2)return 2;
    return 3;
  };
  const [notes,setNotes]=useState({});
  const [sel,setSel]=useState({}); // sel[indentId][itemIdx] = "approve"|"reject"
  const [pgPend,setPgPend]=useState(1);
  const [pgDone,setPgDone]=useState(1);
  const PER=10;

  const pending=(indents||[]).filter(e=>{
    if(e.status!=="reserved")return false;
    const lv=apprLvl(e.deptId);
    return lv>=0&&lv===e.level;
  }).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  const pagedPend=pending.slice((pgPend-1)*PER,pgPend*PER);

  // Get or init selection for an indent
  const getSel=e=>{
    if(sel[e.id])return sel[e.id];
    const s={};
    (e.items||[]).forEach((it,i)=>{if(!it.itemStatus||it.itemStatus==="pending")s[i]="approve";});
    return s;
  };

  const toggle=(eid,idx,val)=>setSel(s=>({...s,[eid]:{...getSel({id:eid,items:(indents||[]).find(x=>x.id===eid)?.items||[]}),[idx]:val}}));

  const act=async(e,action,isFinal=false)=>{
    const note=notes[e.id]||"";
    const dept=(depts||[]).find(d=>d.id===e.deptId);
    const aprs=getDeptApprovers(users,e.deptId);
    const indentTotal=totalAmt(e);
    const maxLevel=getMaxLevel(indentTotal);
    const maxLv=Math.min(aprs.length,maxLevel)-1;
    const lv=apprLvl(e.deptId);
    const hist={action,by:user.id,name:user.name,at:new Date().toISOString(),note,level:lv};

    let newItems=[...(e.items||[])];
    const isel=getSel(e);

    if(action==="revision"){
      // Send back: reset all pending items, keep already-rejected ones
      newItems=newItems.map(it=>it.itemStatus==="rejected"?it:{...it,itemStatus:"pending"});
    } else if(action==="reject"){
      // Reject ALL remaining pending items
      newItems=newItems.map(it=>(!it.itemStatus||it.itemStatus==="pending")?{...it,itemStatus:"rejected"}:it);
    } else {
      // approve / partial / forward
      if(isFinal){
        // L3 FINAL: checked=truly approved (deduct budget), unchecked=rejected (release)
        newItems=newItems.map((it,i)=>{
          if(it.itemStatus&&it.itemStatus!=="pending")return it;
          return{...it,itemStatus:isel[i]==="reject"?"rejected":"approved"};
        });
      } else {
        // INTERMEDIATE (L1/L2): unchecked items get rejected NOW (release reservation)
        // checked items stay "pending" and move to next level
        newItems=newItems.map((it,i)=>{
          if(it.itemStatus&&it.itemStatus!=="pending")return it;
          if(isel[i]==="reject")return{...it,itemStatus:"rejected"};
          return it; // stays pending, forwarded to next approver
        });
      }
    }

    const allAppr=newItems.every(it=>it.itemStatus==="approved");
    const allRej =newItems.every(it=>it.itemStatus==="rejected");
    const someAppr=newItems.some(it=>it.itemStatus==="approved");
    const allDone =newItems.every(it=>it.itemStatus==="approved"||it.itemStatus==="rejected");
    // Still has pending items to forward?
    const hasPending=newItems.some(it=>!it.itemStatus||it.itemStatus==="pending");

    let newStatus=e.status;
    let newLevel=e.level;
    if(action==="revision"){newStatus="revision";newLevel=0;}
    else if(action==="reject"){newStatus="rejected";}
    else if(!isFinal&&hasPending){newStatus="reserved";newLevel=lv+1;}
    else if(!isFinal&&!hasPending){
      // All items rejected at intermediate level
      newStatus="rejected";
    }
    else{
      // Final level decision
      newStatus=allRej?"rejected":someAppr&&!allAppr?"partial":"approved";
    }

    const upd={...e,items:newItems,status:newStatus,level:newLevel,history:[...(e.history||[]),hist]};

    // Recalc dept financials:
    // spent = only truly approved items (set at final L3 only)
    // reserved = only pending items
    // rejected items release their reservation immediately
    const oldApp=approvedAmt(e),oldRes=reservedAmt(e);
    const newApp=approvedAmt(upd),newRes=reservedAmt(upd);
    const dUpd=dept?{...dept,spent:Math.max(0,(dept.spent||0)-oldApp+newApp),reserved:Math.max(0,(dept.reserved||0)-oldRes+newRes)}:dept;

    try{
      await API_CALL.updateIndent(upd.id, upd);
      const [freshI,freshD]=await Promise.all([API_CALL.getIndents(),API_CALL.getDepts()]);
      await saveIndents(freshI);
      await saveDepts(freshD);
    }catch(err){notify(err.message||"Save failed","error");return;}

    const msg=action==="revision"?"Sent back for revision":action==="reject"?"Indent rejected":lv<maxLv?"Forwarded to L"+(lv+2):"Final decision: "+fmt(newApp)+" approved";
    notify(msg);
    setNotes(n=>{const x={...n};delete x[e.id];return x;});
    setSel(s=>{const x={...s};delete x[e.id];return x;});
  };

  const actioned=(indents||[]).filter(e=>e.history?.some(h=>h.by===user.id&&h.action!=="submitted")).slice(0,6);

  return(
    <div>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>Approvals</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:18,marginTop:0}}>Approver for: {apprDepts.map(d=>d.name+" (L"+(apprLvl(d.id)+1)+")").join(", ")}</p>

      {!pending.length
        ?<Card style={{textAlign:"center",padding:36,marginBottom:16}}><div style={{color:"#64748b"}}>All caught up! No pending approvals.</div></Card>
        :<div style={{marginBottom:24}}>
          <h3 style={{color:"#1e293b",marginBottom:10,fontSize:15,margin:"0 0 10px"}}>Pending ({pending.length})</h3>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {pagedPend.map(e=>{
              const dept=(depts||[]).find(d=>d.id===e.deptId);
              const aprs=getDeptApprovers(users,e.deptId);
              const lv=apprLvl(e.deptId);
              const indentTotal=totalAmt(e);
              const maxLevel=getMaxLevel(indentTotal);
              const maxLv=Math.min(aprs.length,maxLevel)-1;
              const isFinal=lv>=maxLv;
              const isel=getSel(e);
              const pendItems=(e.items||[]).filter(it=>!it.itemStatus||it.itemStatus==="pending");
              const nAppr=Object.values(isel).filter(v=>v==="approve").length;
              const nRej =Object.values(isel).filter(v=>v==="reject").length;
              return(
                <Card key={e.id} style={{borderLeft:"4px solid #d97706"}}>
                  <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10,marginBottom:10}}>
                    <div>
                      <div style={{fontWeight:700,color:"#1e293b",fontSize:15}}>{e.title||e.id}</div>
                      <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{e.id} -- {dept?.name} -- {(e.items||[]).length} items -- By: {e.submittedBy}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:19,fontWeight:800,color:"#1e293b"}}>{fmt(totalAmt(e))}</div>
                      <div style={{fontSize:10,color:"#94a3b8"}}>Level {lv+1} of {maxLv+1} (max {maxLevel})</div>
                    </div>
                  </div>

                  {/* Per-item approval table */}
                  <div style={{overflowX:"auto",marginBottom:10}}>
                    <table style={{width:"100%",borderCollapse:"collapse",minWidth:580}}>
                      <thead>
                        <tr style={{background:"#f8fafc"}}>
                          <th style={{padding:"6px 8px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",width:34}}>Dec.</th>
                          {["#","Code","Description","Qty","Amount","Vendor","Status"].map(h=><th key={h} style={{padding:"6px 8px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {(e.items||[]).map((it,i)=>{
                          const isPending=!it.itemStatus||it.itemStatus==="pending";
                          const dec=isel[i]||"approve";
                          const rowBg=!isPending?(it.itemStatus==="approved"?"#f0fdf4":it.itemStatus==="rejected"?"#fff5f5":"#fff"):dec==="reject"?"#fff5f5":"#f0fdf4";
                          return(
                            <tr key={i} style={{borderBottom:"1px solid #f8fafc",background:rowBg}}>
                              <td style={{padding:"7px 8px"}}>
                                {isPending
                                  ?<input type="checkbox" checked={dec!=="reject"} onChange={v=>toggle(e.id,i,v.target.checked?"approve":"reject")} style={{width:15,height:15,cursor:"pointer",accentColor:"#059669"}}/>
                                  :<span style={{fontWeight:700,color:it.itemStatus==="approved"?"#059669":"#dc2626",fontSize:13}}>{it.itemStatus==="approved"?"V":"X"}</span>
                                }
                              </td>
                              <td style={{padding:"7px 8px",color:"#94a3b8",fontSize:11}}>{i+1}</td>
                              <td style={{padding:"7px 8px"}}><span style={{background:"#00787818",color:"#007878",fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20}}>{it.code}</span></td>
                              <td style={{padding:"7px 8px",maxWidth:180}}>{it.desc}</td>
                              <td style={{padding:"7px 8px",color:"#64748b",fontSize:11,whiteSpace:"nowrap"}}>{it.qty} {it.unit}</td>
                              <td style={{padding:"7px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{fmt(it.amount)}</td>
                              <td style={{padding:"7px 8px",color:"#64748b",fontSize:11}}>{it.vendor||"--"}</td>
                              <td style={{padding:"7px 8px"}}>
                                {isPending
                                  ?<Badge label={dec==="reject"?"Will Reject":"Will Approve"} color={dec==="reject"?"#dc2626":"#059669"} bg={dec==="reject"?"#fee2e2":"#dcfce7"}/>
                                  :<Badge label={it.itemStatus==="approved"?"Approved":"Rejected"} color={it.itemStatus==="approved"?"#059669":"#dc2626"} bg={it.itemStatus==="approved"?"#dcfce7":"#fee2e2"}/>
                                }
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{background:"#f5f3ff",borderTop:"2px solid #e2e8f0"}}>
                          <td colSpan={5} style={{padding:"6px 8px",fontWeight:700,color:"#5b21b6",fontSize:12}}>{nAppr} approve -- {nRej} reject</td>
                          <td style={{padding:"6px 8px",fontWeight:800,color:"#059669"}}>{fmt((e.items||[]).filter((_,i)=>isel[i]!=="reject").reduce((s,it)=>s+Number(it.amount||0),0))}</td>
                          <td colSpan={2}/>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {e.notes&&<div style={{fontSize:11,color:"#64748b",fontStyle:"italic",marginBottom:6}}>Notes: "{e.notes}"</div>}
                  <AttachViewer atts={e.atts || e.attachments}/>
                  <div style={{margin:"10px 0"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",marginBottom:4,textTransform:"uppercase"}}>Timeline</div>
                    <Timeline indent={e} approvers={aprs}/>
                  </div>
                  <textarea placeholder="Add a comment (optional)..." value={notes[e.id]||""} onChange={ev=>setNotes(n=>({...n,[e.id]:ev.target.value}))} rows={2} style={{width:"100%",padding:"7px 10px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12,resize:"vertical",marginBottom:8}}/>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <Btn v="green" sz="sm" onClick={()=>act(e,isFinal?(nRej>0&&nAppr>0?"partial":"approve"):"approve",isFinal)}>
                      {isFinal?(nAppr===pendItems.length?"Approve All":"Approve "+nAppr+", Reject "+nRej):"Forward -> L"+(lv+2)+(nRej>0?" (Reject "+nRej+" now)":"")}
                    </Btn>
                    <Btn v="purple" sz="sm" onClick={()=>act(e,"revision")}>Send Back</Btn>
                    <Btn v="red"    sz="sm" onClick={()=>act(e,"reject")}>Reject All</Btn>
                  </div>
                </Card>
              );
            })}
          </div>
          <Paginator total={pending.length} page={pgPend} perPage={PER} onChange={p=>setPgPend(p)}/>
        </div>
      }

      {actioned.length>0&&(
        <div>
          <h3 style={{color:"#1e293b",marginBottom:10,fontSize:15,margin:"0 0 10px"}}>Recently Actioned</h3>
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {actioned.slice((pgDone-1)*PER,pgDone*PER).map(e=>{const dept=(depts||[]).find(d=>d.id===e.deptId);const sm=STS[e.status]||{label:e.status,color:"#64748b",bg:"#f1f5f9"};return(<Card key={e.id} style={{borderLeft:"4px solid "+sm.color}}><div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}><div><span style={{fontWeight:600,color:"#1e293b"}}>{e.title||e.id}</span><span style={{marginLeft:8}}><Badge label={sm.label} color={sm.color} bg={sm.bg}/></span><div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{e.id} -- {dept?.name} -- {(e.items||[]).length} items</div></div><span style={{fontSize:14,fontWeight:700,color:"#1e293b"}}>{fmt(totalAmt(e))}</span></div></Card>);})}
          </div>
          <Paginator total={actioned.length} page={pgDone} perPage={PER} onChange={p=>setPgDone(p)}/>
        </div>
      )}
    </div>
  );
}

// ==================== DEPARTMENTS PAGE ====================
function DeptsPage({depts,saveDepts,indents,users,notify}){
  const [tab,setTab]=useState("list");
  const [ed,setEd]=useState(null);
  const [form,setForm]=useState({id:"",name:"",notes:""});
  const [codes,setCodes]=useState([]);
  const [cf,setCf]=useState({code:"",desc:"",amount:""});
  const [saving,setSaving]=useState(false);
  const [pg,setPg]=useState(1);
  const PER=10;
  const paged=depts.slice((pg-1)*PER,pg*PER);
  useEffect(()=>{setPg(1);},[depts.length]);

  const openAdd=()=>{setEd(null);setForm({id:"",name:"",notes:""});setCodes([]);setCf({code:"",desc:"",amount:""});setTab("edit");};
  const openEdit=d=>{setEd(d);setForm({id:d.id,name:d.name,notes:d.notes||""});setCodes((d.codes||[]).map(c=>({...c})));setCf({code:"",desc:"",amount:""});setTab("edit");};
  const addCode=()=>{
    const code=cf.code.trim().toUpperCase();
    if(!code){notify("Code required","error");return;}
    if(codes.find(c=>c.code===code)){notify("Code already exists","error");return;}
    setCodes(cs=>[...cs,{code,desc:cf.desc.trim(),amount:Number(cf.amount)||0}]);
    setCf({code:"",desc:"",amount:""});
  };
  const save=async()=>{
    if(!form.name.trim()){notify("Name required","error");return;}
    const nid=ed?ed.id:(form.id.trim()?slug(form.id):slug(form.name));
    if(!nid){notify("Cannot generate ID","error");return;}
    if(!ed&&depts.find(d=>d.id===nid)){notify("ID already exists","error");return;}
    const budget=codes.reduce((s,c)=>s+(Number(c.amount)||0),0);
    const ex=depts.find(d=>d.id===nid);
    const ci=ed?depts.findIndex(d=>d.id===ed.id):depts.length;
    const nd={id:nid,name:form.name.trim(),notes:form.notes||"",budget,codes:codes.map(c=>({...c,deptId:nid,amount:Number(c.amount)||0})),spent:ex?.spent||0,reserved:ex?.reserved||0,color:ex?.color||PAL[ci%PAL.length]};
    setSaving(true);
    try{
      await API_CALL.saveDept(nd);
      const fresh=await API_CALL.getDepts();
      await saveDepts(fresh);
      notify(ed?"Updated":"Created");setTab("list");
    }catch(e){notify(e.message||"Save failed","error");}
    setSaving(false);
  };
  const del=async d=>{
    try{
      await API_CALL.deleteDept(d.id);
      const fresh=await API_CALL.getDepts();
      await saveDepts(fresh);
      notify("Deleted");
    }catch(e){notify(e.message||"Delete failed","error");}
  };

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:18,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 3px",fontSize:22}}>Departments</h2><p style={{color:"#64748b",fontSize:13,margin:0}}>Add, edit or delete departments and their budget codes.</p></div>
        {tab==="list"&&<Btn v="blue" onClick={openAdd}>+ Add Department</Btn>}
        {tab==="edit"&&<Btn v="gray" onClick={()=>setTab("list")}>&lt;-- Back</Btn>}
      </div>
      {tab==="list"&&(
        !depts.length
          ?<Card style={{textAlign:"center",padding:36}}><div style={{color:"#64748b"}}>No departments yet.</div></Card>
          :<div style={{display:"flex",flexDirection:"column",gap:9}}>
            {paged.map((d)=>{
              const absIdx=depts.findIndex(x=>x.id===d.id);
              const c=PAL[absIdx>=0?absIdx%PAL.length:0];
              const cnt=(users||[]).filter(u=>(u.role==="requester"&&(u.deptIds||[u.deptId]).includes(d.id))||(u.role==="approver"&&((u.approverAssignments||[]).some(a=>a.deptId===d.id)||(u.deptId===d.id)))).length;
              const sp=(indents||[]).filter(e=>e.deptId===d.id).reduce((s,e)=>s+approvedAmt(e),0);
              return(<Card key={d.id} style={{borderLeft:"4px solid "+c}}><div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10}}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:34,height:34,borderRadius:9,background:c+"22",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,color:c,fontSize:14}}>{d.name[0]}</div><div><div style={{fontWeight:700,color:"#1e293b"}}>{d.name} <span style={{fontSize:11,color:"#94a3b8",fontWeight:400}}>({d.id})</span></div><div style={{fontSize:11,color:"#64748b",marginTop:1}}>Budget: {fmt(d.budget)} -- {(d.codes||[]).length} codes -- {cnt} users -- Spent: {fmt(sp)}</div></div></div><div style={{display:"flex",gap:7,alignItems:"center"}}><Btn v="gray" sz="sm" onClick={()=>openEdit(d)}>Edit</Btn><Btn v="red" sz="sm" onClick={()=>del(d)}>Delete</Btn></div></div></Card>);
            })}
            <Paginator total={depts.length} page={pg} perPage={PER} onChange={setPg}/>
          </div>
      )}
      {tab==="edit"&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <Card>
            <h3 style={{margin:"0 0 14px",color:"#1e293b",fontSize:16}}>{ed?"Edit":"New"} Department</h3>
            <Inp label="Name *" value={form.name} onChange={v=>setForm(p=>({...p,name:v}))} ph="e.g. Marketing"/>
            <Inp label="ID" value={form.id} onChange={v=>setForm(p=>({...p,id:v}))} ph={form.name?slug(form.name):"auto-generated"}/>
            <Txt label="Notes" value={form.notes} onChange={v=>setForm(p=>({...p,notes:v}))} ph="Optional"/>
            <div style={{padding:9,background:"#f8fafc",borderRadius:7,fontSize:11,color:"#64748b",marginBottom:12}}>Total budget = sum of codes: <strong>{fmt(codes.reduce((s,c)=>s+(Number(c.amount)||0),0))}</strong></div>
            <Btn v="green" sz="lg" onClick={save} disabled={saving} style={{width:"100%"}}>{saving?"Saving...":ed?"Save Changes":"Create Department"}</Btn>
          </Card>
          <Card>
            <h3 style={{margin:"0 0 12px",color:"#1e293b",fontSize:16}}>Budget Codes ({codes.length})</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1.2fr 0.8fr auto",gap:6,marginBottom:10,alignItems:"end"}}>
              <div><div style={{fontSize:10,fontWeight:700,color:"#94a3b8",marginBottom:2,textTransform:"uppercase"}}>Code *</div><input value={cf.code} onChange={e=>setCf(p=>({...p,code:e.target.value}))} placeholder="MKT001" onKeyDown={e=>e.key==="Enter"&&addCode()} style={{width:"100%",padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}/></div>
              <div><div style={{fontSize:10,fontWeight:700,color:"#94a3b8",marginBottom:2,textTransform:"uppercase"}}>Description</div><input value={cf.desc} onChange={e=>setCf(p=>({...p,desc:e.target.value}))} placeholder="Advertising" onKeyDown={e=>e.key==="Enter"&&addCode()} style={{width:"100%",padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}/></div>
              <div><div style={{fontSize:10,fontWeight:700,color:"#94a3b8",marginBottom:2,textTransform:"uppercase"}}>Amount</div><input type="number" value={cf.amount} onChange={e=>setCf(p=>({...p,amount:e.target.value}))} placeholder="0" onKeyDown={e=>e.key==="Enter"&&addCode()} style={{width:"100%",padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}/></div>
              <Btn v="blue" sz="sm" onClick={addCode} style={{alignSelf:"flex-end"}}>Add</Btn>
            </div>
            {!codes.length
              ?<div style={{color:"#94a3b8",fontSize:12,textAlign:"center",padding:"18px 0"}}>No codes yet.</div>
              :<div style={{maxHeight:300,overflowY:"auto"}}>
                {codes.map((c,ci)=>(
                  <div key={c.code} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 9px",borderRadius:7,background:ci%2?"#fafbfc":"#fff",marginBottom:2}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
                      <span style={{background:"#00787818",color:"#007878",fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20,flexShrink:0}}>{c.code}</span>
                      <span style={{fontSize:11,color:"#374151",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.desc||"--"}</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                      <span style={{fontSize:12,fontWeight:700,color:"#1e293b"}}>{fmt(Number(c.amount)||0)}</span>
                      <button onClick={()=>setCodes(cs=>cs.filter((_,j)=>j!==ci))} style={{border:"none",background:"#fee2e2",color:"#dc2626",borderRadius:5,cursor:"pointer",padding:"2px 7px",fontSize:11,fontWeight:700}}>x</button>
                    </div>
                  </div>
                ))}
              </div>
            }
          </Card>
        </div>
      )}
    </div>
  );
}

// ==================== IMPORT ====================
function ImportPage({depts,saveDepts,notify}){
  const [hdrs,setHdrs]=useState([]);const [rows,setRows]=useState([]);const [map,setMap]=useState({});const [prev,setPrev]=useState(null);const [step,setStep]=useState(1);
  const onFile=e=>{
    const file=e.target.files[0];if(!file)return;
    const r=new FileReader();
    r.onload=ev=>{
      const wb=XLSX.read(ev.target.result,{type:"binary"});const ws=wb.Sheets[wb.SheetNames[0]];const data=XLSX.utils.sheet_to_json(ws,{header:1});
      if(data.length<2){notify("No data found","error");return;}
      const h=data[0].map(String);setHdrs(h);setRows(data.slice(1).filter(r=>r.some(c=>c!==undefined&&c!=="")));
      const a={};
      h.forEach((hh,i)=>{const l=hh.toLowerCase().trim();
        // Department name column
        if(a.dept===undefined&&(l==="department"||l==="dept"||l==="dept name"||l==="department name"||l.startsWith("dept")))a.dept=i;
        // Dept ID column
        if(a.deptId===undefined&&(l==="dept id"||l==="department id"||l==="deptid"||l==="dept_id")&&!l.includes("budget"))a.deptId=i;
        // Budget / amount column
        if(a.budget===undefined&&(l==="budget"||l==="amount"||l==="budget amount"||l==="allocated amount"||l==="allocation"||l.includes("alloc")||(l.includes("amount")&&!l.includes("code"))))a.budget=i;
        // Budget code column
        if(a.bcode===undefined&&(l==="budget code"||l==="code"||l==="bcode"||l==="cost code"||l==="gl code"||l==="account code"))a.bcode=i;
        // Description column
        if(a.bdesc===undefined&&(l==="description"||l==="desc"||l==="particulars"||l==="details"||l==="item"||l.includes("descr")))a.bdesc=i;
      });
      // fallback: if still no dept, try column 0; if no budget try to find any numeric column
      if(a.dept===undefined&&h.length>0)a.dept=0;
      if(a.budget===undefined){
        // find first column that looks numeric in row 1
        const firstRow=rows[0]||[];
        for(let i=0;i<h.length;i++){
          const v=firstRow[i];
          if(v!==undefined&&v!==null&&v!==""&&!isNaN(Number(String(v).replace(/[^0-9.-]/g,"")))){
            // skip the dept/id columns
            if(i!==a.dept&&i!==a.deptId&&i!==a.bcode&&i!==a.bdesc){a.budget=i;break;}
          }
        }
      }
      setMap(a);setStep(2);
    };
    r.readAsBinaryString(file);
  };
  // Parse numbers robustly - handles "75,000" "Rs.75000" "75000.00" etc
  const parseNum=v=>{
    if(v===undefined||v===null||v==="")return 0;
    const n=Number(String(v).replace(/[^0-9.-]/g,""));
    return isNaN(n)?0:n;
  };
  const build=()=>{
    const m={};
    rows.forEach(row=>{
      const name=map.dept!==undefined?String(row[map.dept]||"").trim():"";
      if(!name)return;
      const rawId=map.deptId!==undefined?String(row[map.deptId]||"").trim():"";
      const id=rawId||slug(name);
      if(!id)return;
      const budget=map.budget!==undefined?parseNum(row[map.budget]):0;
      const bcode=map.bcode!==undefined?String(row[map.bcode]||"").trim():"";
      const bdesc=map.bdesc!==undefined?String(row[map.bdesc]||"").trim():"";
      if(!m[id])m[id]={id,name,budget:0,codes:[]};
      m[id].budget+=budget;
      if(bcode)m[id].codes.push({code:bcode.toUpperCase(),desc:bdesc,amount:budget,deptId:id});
    });
    const result=Object.values(m);
    if(!result.length){notify("No valid department rows found. Check column mapping.","error");return;}
    setPrev(result);setStep(3);
  };
  const doImport=async()=>{
    const merged=[...depts];
    prev.forEach(d=>{
      const codes=d.codes.map(c=>({...c,deptId:d.id}));
      const idx=merged.findIndex(x=>x.id===d.id);
      if(idx>=0){merged[idx]={...merged[idx],name:d.name,budget:d.budget,codes};}
      else merged.push({id:d.id,name:d.name,budget:d.budget,codes,spent:0,reserved:0,color:PAL[merged.length%PAL.length]});
    });
    try{
      const savedDepts=await API_CALL.saveDeptBulk(merged);
      await saveDepts(Array.isArray(savedDepts)?savedDepts:merged);
      notify("Imported "+prev.length+" dept(s). Total: "+merged.length+" -- Go to Dashboard to view.");
      setStep(1);setPrev(null);setHdrs([]);setRows([]);setMap({});
    }catch(e){notify(e.message||"Import failed","error");}
  };
  return(
    <div>
      <h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 4px",fontSize:22}}>Import Budget</h2>
      <p style={{color:"#64748b",fontSize:13,marginBottom:14,marginTop:0}}>Imports merge with existing data. One row per budget code.</p>
      <div style={{display:"flex",gap:0,marginBottom:20,alignItems:"center"}}>
        {["Upload","Map","Preview"].map((s,i)=>(
          <div key={s} style={{display:"flex",alignItems:"center"}}>
            <div style={{width:24,height:24,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:step>i||step===i+1?"#007878":"#e2e8f0",color:step>=i+1?"#fff":"#94a3b8",fontSize:12,fontWeight:700}}>{i+1}</div>
            <span style={{marginLeft:5,fontSize:12,color:step===i+1?"#007878":"#94a3b8",fontWeight:step===i+1?700:400}}>{s}</span>
            {i<2&&<div style={{width:20,height:2,background:"#e2e8f0",margin:"0 8px"}}/>}
          </div>
        ))}
      </div>
      {step===1&&<Card><div style={{border:"2px dashed #80cbc4",borderRadius:10,padding:36,textAlign:"center",background:"#f0f7f7"}}><div style={{fontWeight:600,color:"#007878",marginBottom:10}}>Upload Excel or CSV</div><input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} style={{cursor:"pointer"}}/></div><div style={{marginTop:10,padding:10,background:"#f8fafc",borderRadius:7,fontSize:11,color:"#64748b"}}>Columns: Department Name, Dept ID, Budget Amount, Budget Code, Description. One row per code.</div></Card>}
      {step===2&&<Card><h3 style={{margin:"0 0 10px",fontSize:15}}>Map Columns</h3><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>{[["dept","Dept Name *"],["deptId","Dept ID"],["budget","Code Budget"],["bcode","Budget Code"],["bdesc","Description"]].map(([k,l])=><div key={k}><div style={{fontSize:10,fontWeight:700,color:"#6b7280",marginBottom:2,textTransform:"uppercase"}}>{l}</div><select value={map[k]??""} onChange={e=>setMap(m=>({...m,[k]:e.target.value===""?undefined:Number(e.target.value)}))} style={{width:"100%",padding:"6px 9px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}><option value="">-- skip --</option>{hdrs.map((h,i)=><option key={i} value={i}>{h}</option>)}</select></div>)}</div><div style={{marginTop:12,display:"flex",gap:8}}><Btn v="gray" onClick={()=>setStep(1)}>Back</Btn><Btn v="blue" onClick={build} disabled={map.dept===undefined}>Preview</Btn></div></Card>}
      {step===3&&prev&&<div>
        <Card style={{marginBottom:10}}>
          <h3 style={{margin:"0 0 6px",fontSize:15}}>Preview: {prev.length} dept(s) -- {prev.reduce((s,d)=>s+d.codes.length,0)} budget codes</h3>
          <div style={{marginBottom:8,padding:"8px 10px",background:"#f0f7f7",borderRadius:7,fontSize:11,color:"#004d4d"}}>
            <strong>Detected columns:</strong> Dept={map.dept!==undefined?hdrs[map.dept]:"(none)"} | ID={map.deptId!==undefined?hdrs[map.deptId]:"(auto)"} | Budget={map.budget!==undefined?hdrs[map.budget]:"(none)"} | Code={map.bcode!==undefined?hdrs[map.bcode]:"(none)"} | Desc={map.bdesc!==undefined?hdrs[map.bdesc]:"(none)"}
          </div>
          <div style={{fontSize:11,color:"#059669",marginBottom:8,fontWeight:600}}>{prev.filter(d=>depts.find(x=>x.id===d.id)).length} update -- {prev.filter(d=>!depts.find(x=>x.id===d.id)).length} new -- {depts.filter(d=>!prev.find(x=>x.id===d.id)).length} unchanged</div>
          <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{background:"#f8fafc"}}>{["","Dept","Budget","Code","Desc","Code Budget"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:"left",borderBottom:"1px solid #e2e8f0",color:"#64748b",fontSize:10,fontWeight:700}}>{h}</th>)}</tr></thead>
          <tbody>{prev.flatMap((d,i)=>d.codes.length?d.codes.map((c,j)=>(<tr key={d.id+c.code} style={{borderBottom:"1px solid #f8fafc",background:i%2?"#fafbfc":"#fff"}}><td style={{padding:"5px 8px"}}>{j===0&&<Badge label={depts.find(x=>x.id===d.id)?"Update":"New"} color={depts.find(x=>x.id===d.id)?"#1e40af":"#166534"} bg={depts.find(x=>x.id===d.id)?"#dbeafe":"#dcfce7"}/>}</td><td style={{padding:"5px 8px",fontWeight:j===0?700:400,color:j===0?"#1e293b":"#94a3b8"}}>{j===0?d.name:""}</td><td style={{padding:"5px 8px"}}>{j===0?fmt(d.budget):""}</td><td style={{padding:"5px 8px"}}><span style={{background:PAL[i%PAL.length]+"18",color:PAL[i%PAL.length],fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20}}>{c.code}</span></td><td style={{padding:"5px 8px",color:"#64748b"}}>{c.desc||"--"}</td><td style={{padding:"5px 8px",fontWeight:600}}>{fmt(c.amount)}</td></tr>)):[<tr key={d.id}><td style={{padding:"5px 8px"}}><Badge label={depts.find(x=>x.id===d.id)?"Update":"New"} color={depts.find(x=>x.id===d.id)?"#1e40af":"#166534"} bg={depts.find(x=>x.id===d.id)?"#dbeafe":"#dcfce7"}/></td><td colSpan={5} style={{padding:"5px 8px",fontWeight:700}}>{d.name} -- no codes</td></tr>])}</tbody></table></div>
        </Card>
        <div style={{display:"flex",gap:8}}><Btn v="gray" onClick={()=>setStep(2)}>Back</Btn><Btn v="green" onClick={doImport}>Confirm Import</Btn></div>
      </div>}
    </div>
  );
}

// ==================== USERS PAGE ====================
function UsersPage({depts,users,saveUsers,notify}){
  const [tab,setTab]=useState("list");
  const [eid,setEid]=useState(null);
  const [form,setForm]=useState({id:"",name:"",email:"",pw:"",role:"requester"});
  const [rdepts,setRdepts]=useState([]);
  const [asgn,setAsgn]=useState([]);
  const [na,setNa]=useState({deptId:"",level:0});
  const [search,setSearch]=useState("");
  const [roleFilter,setRoleFilter]=useState("all");
  const [deptFilter,setDeptFilter]=useState("all");
  const [pg,setPg]=useState(1);
  const PER=10;

  const reset=()=>{
    setForm({id:"",name:"",email:"",pw:"",role:"requester"});
    setRdepts([]);
    setAsgn([]);
    setNa({deptId:"",level:0});
    setEid(null);
  };

  const openEdit=u=>{
    setForm({id:u.id,name:u.name,email:u.email||"",pw:"",role:u.role});
    setEid(u.id);
    if(u.role==="requester")setRdepts(u.deptIds||(u.deptId?[u.deptId]:[]));
    if(u.role==="approver")setAsgn(u.approverAssignments||(u.deptId?[{deptId:u.deptId,approverLevel:u.approverLevel||0}]:[]));
    setTab("edit");
  };

  const addA=()=>{
    if(!na.deptId){notify("Select a dept","error");return;}
    if(asgn.find(a=>a.deptId===na.deptId)){notify("Already assigned","error");return;}
    setAsgn(a=>[...a,{deptId:na.deptId,approverLevel:Number(na.level)}]);
    setNa({deptId:"",level:0});
  };

  const save=async()=>{
    const isPwRequired = !eid;
    if(!form.id.trim()||!form.name.trim()||(isPwRequired && !form.pw.trim())||!form.email.trim()){notify("Fill all fields","error");return;}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())){notify("Invalid email format","error");return;}
    if(!eid&&(users||[]).find(u=>u.id===form.id.trim())){notify("ID already exists","error");return;}
    const nu={id:form.id.trim(),name:form.name.trim(),email:form.email.trim(),password:form.pw,role:form.role,deptIds:rdepts,approverAssignments:asgn};
    try{
      if(eid){await API_CALL.updateUser(eid,nu);}
      else{await API_CALL.createUser(nu);}
      const fresh=await API_CALL.getUsers();
      await saveUsers(fresh);
      notify(eid?"Updated":"Created");reset();setTab("list");
    }catch(e){notify(e.message||"Save failed","error");}
  };

  const dn=id=>depts.find(d=>d.id===id)?.name||id;

  const filteredUsers=(users||[]).filter(u=>{
    const term=search.toLowerCase().trim();
    if(term){
      const matchId=(u.id||"").toLowerCase().includes(term);
      const matchName=(u.name||"").toLowerCase().includes(term);
      const matchEmail=(u.email||"").toLowerCase().includes(term);
      if(!matchId&&!matchName&&!matchEmail)return false;
    }
    if(roleFilter!=="all"&&u.role!==roleFilter)return false;
    if(deptFilter!=="all"){
      if(u.role==="requester"){
        const ids=u.deptIds||(u.deptId?[u.deptId]:[]);
        if(!ids.includes(deptFilter))return false;
      }else if(u.role==="approver"){
        const assignments=u.approverAssignments||(u.deptId?[{deptId:u.deptId,approverLevel:u.approverLevel||0}]:[]);
        const ids=assignments.map(a=>a.deptId);
        if(!ids.includes(deptFilter))return false;
      }else{
        return false;
      }
    }
    return true;
  });

  const pagedUsers=filteredUsers.slice((pg-1)*PER,pg*PER);

  useEffect(()=>{
    setPg(1);
  },[search,roleFilter,deptFilter,users.length]);

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:18,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{fontWeight:800,color:"#1e1b4b",margin:"0 0 3px",fontSize:22}}>User Management</h2><p style={{color:"#64748b",fontSize:13,margin:0}}>Separate logins. Assign users to multiple departments and configure email addresses.</p></div>
        {tab==="list"&&<Btn v="blue" onClick={()=>{reset();setTab("edit");}}>+ Add User</Btn>}
        {tab==="edit"&&<Btn v="gray" onClick={()=>{reset();setTab("list");}}>Back</Btn>}
      </div>

      {tab==="list"&&(
        <div>
          <Card style={{marginBottom:14}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:10}}>
              <Inp label="Search Users" value={search} onChange={setSearch} ph="Search ID, name, email..." style={{marginBottom:0}}/>
              <Sel label="Role Filter" value={roleFilter} onChange={setRoleFilter} style={{marginBottom:0}}>
                <option value="all">All Roles</option>
                <option value="admin">Admin</option>
                <option value="requester">Requester</option>
                <option value="approver">Approver</option>
                <option value="procurement">Procurement</option>
              </Sel>
              <Sel label="Dept Filter" value={deptFilter} onChange={setDeptFilter} style={{marginBottom:0}}>
                <option value="all">All Departments</option>
                {depts.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
              </Sel>
            </div>
          </Card>

          {filteredUsers.length===0
            ?<Card style={{textAlign:"center",padding:36}}><div style={{color:"#64748b"}}>No users found.</div></Card>
            :<Card style={{padding:0,overflow:"hidden"}}>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr style={{background:"#f8fafc"}}>
                      {["User ID / Name","Email","Role","Access / Departments","Actions"].map(h=>(
                        <th key={h} style={{padding:"10px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedUsers.map((u,idx)=>{
                      const roleBadge = u.role === "admin"
                        ? { l: "Admin", c: "#1e40af", bg: "#dbeafe" }
                        : u.role === "procurement"
                        ? { l: "Procurement", c: "#0369a1", bg: "#e0f2fe" }
                        : u.role === "approver"
                        ? { l: "Approver", c: "#5b21b6", bg: "#ede9fe" }
                        : { l: "Requester", c: "#059669", bg: "#dcfce7" };

                      let deptText = "";
                      if (u.role === "admin" || u.role === "procurement") {
                        deptText = "Full Access (Global)";
                      } else if (u.role === "requester") {
                        const ids = u.deptIds || (u.deptId ? [u.deptId] : []);
                        deptText = ids.length ? ids.map(id => dn(id)).join(", ") : "None";
                      } else if (u.role === "approver") {
                        const assignments = u.approverAssignments || (u.deptId ? [{ deptId: u.deptId, approverLevel: u.approverLevel || 0 }] : []);
                        deptText = assignments.length ? assignments.map(a => `${dn(a.deptId)} (L${(a.approverLevel || 0) + 1})`).join(", ") : "None";
                      }

                      return (
                        <tr key={u.id} style={{borderBottom:"1px solid #f1f5f9",background:idx%2?"#fafbfc":"#fff"}}>
                          <td style={{padding:"10px 12px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{width:28,height:28,borderRadius:"50%",background:roleBadge.bg,color:roleBadge.c,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>
                                {u.name ? u.name[0].toUpperCase() : "?"}
                              </div>
                              <div>
                                <div style={{fontWeight:600,color:"#1e293b"}}>{u.name}</div>
                                <div style={{fontSize:10,color:"#94a3b8"}}>@{u.id}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{padding:"10px 12px",color:"#475569"}}>{u.email || "--"}</td>
                          <td style={{padding:"10px 12px"}}>
                            <Badge label={roleBadge.l} color={roleBadge.c} bg={roleBadge.bg} />
                          </td>
                          <td style={{padding:"10px 12px",color:"#475569",maxWidth:250,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={deptText}>
                            {deptText}
                          </td>
                          <td style={{padding:"10px 12px"}}>
                            <div style={{display:"flex",gap:4}}>
                              <Btn v="gray" sz="sm" onClick={()=>openEdit(u)}>Edit</Btn>
                              <Btn v="red" sz="sm" onClick={async()=>{
                                if(window.confirm(`Delete user ${u.name}?`)){
                                  try{
                                    await API_CALL.deleteUser(u.id);
                                    const fresh=await API_CALL.getUsers();
                                    await saveUsers(fresh);
                                    notify("User deleted");
                                  }catch(e){
                                    notify(e.message||"Failed to delete","error");
                                  }
                                }
                              }}>x</Btn>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Paginator total={filteredUsers.length} page={pg} perPage={PER} onChange={setPg}/>
            </Card>
          }
        </div>
      )}

      {tab==="edit"&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <Card>
            <h3 style={{margin:"0 0 14px",color:"#1e293b",fontSize:16}}>{eid?"Edit":"New"} User</h3>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <Inp label="User ID *" value={form.id} onChange={v=>setForm(p=>({...p,id:v}))} ph="john_doe" disabled={!!eid}/>
              <Inp label="Full Name *" value={form.name} onChange={v=>setForm(p=>({...p,name:v}))} ph="John Doe"/>
              <Inp label="Email *" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} ph="john@example.com"/>
              <Inp label="Password *" value={form.pw} onChange={v=>setForm(p=>({...p,pw:v}))} type="password" ph={eid?"Leave as is":""}/>
              <Sel label="Role *" value={form.role} onChange={v=>{setForm(p=>({...p,role:v}));setRdepts([]);setAsgn([]);}}>
                <option value="requester">Requester</option>
                <option value="approver">Approver</option>
                <option value="procurement">Procurement</option>
              </Sel>
            </div>
            <div style={{padding:9,background:"#fef9c3",borderRadius:7,fontSize:11,color:"#92400e",marginBottom:12,marginTop:12}}>Note: A person must not be both requester and approver for the same department.</div>
            <Btn v="green" onClick={save} style={{width:"100%"}}>{eid?"Update":"Create"} User</Btn>
          </Card>
          <Card>
            <h3 style={{margin:"0 0 12px",color:"#1e293b",fontSize:16}}>{form.role==="requester"?"Department Access":"Approver Assignments"}</h3>
            {form.role==="requester"&&(
              !depts.length?<div style={{color:"#94a3b8",fontSize:12}}>No departments.</div>:depts.map((d,i)=>(
                <label key={d.id} style={{display:"flex",alignItems:"center",gap:9,padding:"7px 9px",borderRadius:7,background:rdepts.includes(d.id)?PAL[i%PAL.length]+"12":"#f8fafc",marginBottom:5,cursor:"pointer",border:"1px solid "+(rdepts.includes(d.id)?PAL[i%PAL.length]+"44":"#e2e8f0")}}>
                  <input type="checkbox" checked={rdepts.includes(d.id)} onChange={e=>setRdepts(ids=>e.target.checked?[...ids,d.id]:ids.filter(x=>x!==d.id))} style={{width:14,height:14,cursor:"pointer"}}/>
                  <span style={{fontSize:12,fontWeight:600,color:PAL[i%PAL.length]}}>{d.name}</span>
                  <span style={{fontSize:10,color:"#94a3b8"}}>({d.id})</span>
                </label>
              ))
            )}
            {form.role==="approver"&&(
              <div>
                <p style={{fontSize:11,color:"#64748b",marginBottom:10}}>Same person can be L1 for one dept, L2 for another.</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:7,marginBottom:10}}>
                  <select value={na.deptId} onChange={e=>setNa(a=>({...a,deptId:e.target.value}))} style={{padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}><option value="">-- dept --</option>{depts.filter(d=>!asgn.find(a=>a.deptId===d.id)).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
                  <select value={na.level} onChange={e=>setNa(a=>({...a,level:Number(e.target.value)}))} style={{padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:7,fontFamily:"inherit",fontSize:12}}><option value={0}>Level 1</option><option value={1}>Level 2</option><option value={2}>Level 3</option></select>
                  <Btn v="blue" sz="sm" onClick={addA}>Add</Btn>
                </div>
                {!asgn.length?<div style={{color:"#94a3b8",fontSize:12,textAlign:"center",padding:"14px 0"}}>No assignments.</div>:asgn.map((a,i)=>(
                  <div key={a.deptId} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 10px",borderRadius:7,background:"#f5f3ff",border:"1px solid #e9d5ff",marginBottom:5}}>
                    <div><span style={{fontWeight:600,color:"#5b21b6"}}>{dn(a.deptId)}</span><span style={{marginLeft:7,background:"#7c3aed",color:"#fff",fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20}}>L{a.approverLevel+1}</span></div>
                    <button onClick={()=>setAsgn(aa=>aa.filter((_,j)=>j!==i))} style={{border:"none",background:"#fee2e2",color:"#dc2626",borderRadius:5,cursor:"pointer",padding:"2px 7px",fontSize:11,fontWeight:700}}>x</button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
