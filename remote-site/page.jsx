'use client';
import {useEffect,useRef,useState} from 'react';

const P={
  bg:'#0f1117',panel:'#161922',raised:'#1e222d',hover:'#282d3a',line:'#2a2f3b',
  text:'#e8eaf0',muted:'#9aa1b0',accent:'#7c9cff',
  ownBg:'#1f2a4a',ownLine:'#2f3f6e',ownName:'#b6c8ff',
  codex:'#6ea8ff',claude:'#f0a27a',agy:'#8fd16f',agentName:'#ffbf9e'
};
function accentFor(name,provider){
  if(provider==='agy'||/^(agy|antigravity)/i.test(name||'')||name?.includes('수소'))return P.agy;
  if(provider==='codex'||/^(codex|gpt|chatgpt|sol)\b/i.test(name||'')||name?.includes('솔'))return P.codex;
  if(provider==='claude'||/^(claude|opus|sonnet|haiku)/i.test(name||'')||name?.includes('오푸스'))return P.claude;
  return P.line;
}
function fmtAge(ts){if(!ts)return '';const m=Math.max(0,Math.floor((Date.now()-ts)/60000));return m<1?'방금 기준':m<60?m+'분 전 기준':Math.floor(m/60)+'시간 전 기준';}
function fmtReset(raw){
  if(!raw)return '';
  const ms=typeof raw==='number'?(raw<1e12?raw*1000:raw):Date.parse(raw);
  if(!Number.isFinite(ms))return '';
  const d=new Date(ms),now=new Date(),t=d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false});
  return (d.toDateString()===now.toDateString()?t:d.toLocaleDateString('ko-KR',{month:'numeric',day:'numeric'})+' '+t)+' 초기화';
}
function renderInline(text){
  const pattern=/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(((?:https?:\/\/|file:\/\/\/?)[^\s)]+)\)/g;
  const out=[];let start=0,k=0;
  for(const m of String(text||'').matchAll(pattern)){
    if(m.index>start)out.push(text.slice(start,m.index));
    if(m[5]){
      const isFile=m[5].startsWith('file:');
      out.push(<a key={k++} href={m[5]} title={m[5]} target={isFile?undefined:'_blank'} rel={isFile?undefined:'noopener noreferrer'} onClick={isFile?e=>{e.preventDefault();try{const u=new URL(m[5]);navigator.clipboard?.writeText(decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/,'$1').replace(/\//g,'\\')).catch(()=>{});}catch{}}:undefined} style={{color:P.accent}}>{m[4]}</a>);
    }
    else if(m[1])out.push(<code key={k++} style={{background:P.raised,borderRadius:4,padding:'1px 5px',fontSize:'0.92em'}}>{m[1]}</code>);
    else if(m[2])out.push(<strong key={k++}>{renderInline(m[2])}</strong>);
    else out.push(<em key={k++}>{renderInline(m[3])}</em>);
    start=m.index+m[0].length;
  }
  if(start<text.length)out.push(text.slice(start));
  return out;
}
function CodeBlock({code}){
  const [copied,setCopied]=useState(false);
  const onCopy=()=>{
    const t=code.replace(/\n$/,'');
    const done=()=>{setCopied(true);setTimeout(()=>setCopied(false),1400);};
    const fb=()=>{const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.append(ta);ta.focus();ta.select();if(document.execCommand('copy'))done();ta.remove();};
    if(navigator.clipboard?.writeText)navigator.clipboard.writeText(t).then(done).catch(fb);else fb();
  };
  return <div style={{position:'relative',margin:'0 0 6px'}}>
    <button type="button" onClick={onCopy} style={{position:'absolute',top:6,right:6,zIndex:2,padding:'2px 8px',fontSize:11,borderRadius:6,background:P.raised,border:`1px solid ${P.line}`,color:P.text,cursor:'pointer'}}>{copied?'복사됨':'복사'}</button>
    <pre style={{overflow:'auto',maxWidth:'100%',padding:'30px 10px 10px',margin:0,background:P.bg,border:`1px solid ${P.line}`,borderRadius:8}}>
      <code style={{whiteSpace:'pre',fontFamily:'ui-monospace,Consolas,monospace',fontSize:12.5}}>{code}</code>
    </pre>
  </div>;
}
function MessageBody({text}){
  const blocks=[];let code=null,para=[],list=null,listTag=null,listStart=1,k=0;
  const flushPara=()=>{if(para.length){blocks.push(<p key={k++} style={{margin:'0 0 6px',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{para.flatMap((line,i)=>i?[<br key={'br'+i}/>,...renderInline(line)]:renderInline(line))}</p>);para=[];}};
  const flushList=()=>{if(list){blocks.push(listTag==='ol'?<ol key={k++} start={listStart>1?listStart:undefined} style={{margin:'0 0 6px',paddingLeft:20}}>{list}</ol>:<ul key={k++} style={{margin:'0 0 6px',paddingLeft:20}}>{list}</ul>);list=null;listTag=null;listStart=1;}};
  const lines=String(text||'').split(/\r?\n/);
  for(let idx=0;idx<lines.length;idx++){
    let line=lines[idx];
    if(code!==null){const end=line.match(/^\s*```+(.*)$/);if(end){blocks.push(<CodeBlock key={k++} code={code}/>);code=null;if(!end[1].trim())continue;line=end[1];}else{code+=line+'\n';continue;}}
    if(/^\s*```/.test(line)){flushPara();flushList();code='';continue;}
    if(!line.trim()){flushPara();flushList();continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){flushPara();flushList();blocks.push(<hr key={k++} style={{border:0,borderTop:`1px solid ${P.line}`,margin:'8px 0'}}/>);continue;}
    if(/^\s*\|.*\|\s*$/.test(line)&&lines[idx+1]&&/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[idx+1])){
      flushPara();flushList();
      const head=line.trim().slice(1,-1).split('|').map(c=>c.trim());
      idx+=2;const rows=[];
      while(idx<lines.length&&/^\s*\|.*\|\s*$/.test(lines[idx])){rows.push(lines[idx].trim().slice(1,-1).split('|').map(c=>c.trim()));idx++;}
      idx--;
      blocks.push(<table key={k++} style={{borderCollapse:'collapse',maxWidth:'100%',fontSize:13,margin:'0 0 6px',display:'block',overflow:'auto'}}><thead><tr>{head.map((c,i)=><th key={i} style={{border:`1px solid ${P.line}`,padding:'4px 8px',background:P.raised,textAlign:'left'}}>{renderInline(c)}</th>)}</tr></thead><tbody>{rows.map((r,ri)=><tr key={ri}>{r.map((c,ci)=><td key={ci} style={{border:`1px solid ${P.line}`,padding:'4px 8px'}}>{renderInline(c)}</td>)}</tr>)}</tbody></table>);
      continue;
    }
    const item=line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if(item){
      flushPara();
      const tag=/^\d/.test(item[1])?'ol':'ul';
      if(listTag!==tag){flushList();list=[];listTag=tag;listStart=tag==='ol'?parseInt(item[1],10)||1:1;}
      list.push(<li key={list.length}>{renderInline(item[2])}</li>);
      continue;
    }
    flushList();
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){flushPara();const sz=Math.max(14,20-heading[1].length);blocks.push(<div key={k++} style={{fontWeight:700,fontSize:sz,margin:'4px 0 6px'}}>{renderInline(heading[2])}</div>);continue;}
    if(line.startsWith('> ')){flushPara();blocks.push(<blockquote key={k++} style={{margin:'0 0 6px',paddingLeft:10,borderLeft:'2px solid #596584',color:P.muted}}>{renderInline(line.slice(2))}</blockquote>);continue;}
    para.push(line);
  }
  flushPara();flushList();
  if(code!==null)blocks.push(<CodeBlock key={k++} code={code}/>);
  return <div style={{color:P.text,overflowWrap:'anywhere'}}>{blocks}</div>;
}

export default function RemoteRoom(){
  const [events,setEvents]=useState([]);
  const [rooms,setRooms]=useState([]);
  const [room,setRoom]=useState('');
  const [snap,setSnap]=useState(null);
  const [draft,setDraft]=useState('');
  const [newRoom,setNewRoom]=useState('');
  const [status,setStatus]=useState('');
  const [connected,setConnected]=useState(true);
  const [sending,setSending]=useState(false);
  const [showAct,setShowAct]=useState(true);
  const listRef=useRef(null);

  useEffect(()=>{
    let active=true;
    async function read(){
      try{
        const result=await fetch('/api/room/browser'+(room?'?room='+encodeURIComponent(room):''),{cache:'no-store'});
        if(result.status===404&&room){if(active){setEvents([]);setRoom('');}return;}
        if(!result.ok)throw Error('소유자 계정으로 로그인했는지 확인해 주세요.');
        const data=await result.json();
        if(active){
          setConnected(true);setEvents(data.events);setRooms(data.rooms);setSnap(data.snapshot||null);
          if(!room&&data.rooms.length)setRoom(data.rooms[0].id);
        }
      }catch(error){if(active){setConnected(false);setStatus(error.message);}}
    }
    void read();const timer=setInterval(read,2000);
    const onVis=()=>{if(document.visibilityState==='visible')void read();};
    document.addEventListener('visibilitychange',onVis);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',onVis);};
  },[room]);

  useEffect(()=>{
    const el=listRef.current;
    if(el&&el.scrollHeight-el.scrollTop-el.clientHeight<120)el.scrollTop=el.scrollHeight;
  },[events,snap]);

  async function postBrowser(body,msg='PC로 제어 요청을 보냈어요 (약 2초 내 반영).'){
    try{
      const r=await fetch('/api/room/browser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),...body})});
      if(!r.ok)throw Error('요청을 저장하지 못했어요.');
      setStatus(msg);return true;
    }catch(error){setStatus(error.message);return false;}
  }
  async function send(event){
    event.preventDefault();if(sending||!room||!draft.trim())return;
    const text=draft;setSending(true);
    try{if(await postBrowser({room,text},'PC로 보낼 메시지를 대기열에 넣었어요.'))setDraft('');}
    finally{setSending(false);}
  }

  const roomObj=rooms.find(r=>r.id===room);
  const members=(snap?.members||[]).filter(m=>m.room===room&&m.state!=='disconnected');
  const busy=members.filter(m=>m.busy);
  const approvals=snap?.approvals||[];
  const ranking=snap?.ranking?.find(r=>r.room===room);
  const roomMode=ranking?.mode||(ranking?.enabled?'ranking':'broadcast');
  const approved=members.filter(m=>m.state==='approved');
  const mainMember=roomMode==='hierarchy'?(approved.find(m=>m.id===ranking?.main_member)||approved.find(m=>m.provider)):null;
  const labels={pending:'승인 대기',starting:'CLI 시작 중…',start_failed:'실행 실패',approved:'대기 중'};
  const winNames={five_hour:'5시간',seven_day:'7일',primary:'5시간',secondary:'7일','gemini-5h':'5시간','gemini-weekly':'7일','3p-5h':'5시간','3p-weekly':'7일'};

  return <div style={{display:'flex',flexDirection:'column',height:'100dvh',overflow:'hidden',background:P.bg,color:P.text,fontFamily:'"Pretendard","Malgun Gothic","Segoe UI",sans-serif',fontSize:14,lineHeight:1.55}}>
    <header style={{flex:'none',padding:'12px 18px',borderBottom:`1px solid ${P.line}`,background:P.bg,display:'grid',gap:8}}>
      <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          <h1 style={{fontSize:16,margin:0,display:'inline-flex',alignItems:'center',gap:6,whiteSpace:'nowrap'}}>Agent Room <span style={{fontSize:11,fontWeight:600,padding:'1px 7px',borderRadius:6,background:'rgba(124,156,255,0.16)',border:`1px solid ${P.accent}`,color:P.accent,whiteSpace:'nowrap'}}>원격</span></h1>
          <span style={{fontSize:11,padding:'2px 8px',borderRadius:999,background:P.panel,border:`1px solid ${P.line}`,color:P.muted,display:'inline-flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}>
            <i style={{width:7,height:7,borderRadius:'50%',background:connected?'#4fd1a5':'#ff7b72',display:'inline-block'}}/>
            {connected?'원격 연결됨':'연결 확인 필요'}
          </span>
          {roomObj?<button type="button" onClick={()=>setShowAct(v=>!v)} style={{fontSize:12,padding:'4px 9px',borderRadius:8,border:`1px solid ${showAct?P.accent:P.line}`,background:P.raised,color:showAct?P.accent:P.text,cursor:'pointer'}}>현황판</button>:null}
          {roomObj?<select aria-label="구조 모드" value={roomMode} onChange={e=>void postBrowser({room,control:'room_ranking',mode:e.target.value,enabled:e.target.value==='ranking',mainMember:mainMember?.id||null})} style={{fontSize:12,padding:'4px 8px',borderRadius:8,border:`1px solid ${P.line}`,background:P.raised,color:P.text}}>
            <option value="broadcast">자유 · 동시</option>
            <option value="ranking">자동 · 순위</option>
            <option value="hierarchy">계층형 · 메인→하위</option>
          </select>:null}
          {roomObj&&roomMode==='hierarchy'&&approved.length?<select aria-label="메인 에이전트" value={mainMember?.id||''} onChange={e=>void postBrowser({room,control:'room_ranking',mode:'hierarchy',enabled:false,mainMember:e.target.value||null})} style={{fontSize:12,padding:'4px 8px',borderRadius:8,border:`1px solid ${P.accent}`,background:P.raised,color:P.text}}>
            {approved.map(m=><option key={m.id} value={m.id}>메인: {m.name}</option>)}
          </select>:null}
        </div>
        <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
          <select aria-label="채팅방" value={room} onChange={e=>{setEvents([]);setDraft('');setRoom(e.target.value);}} style={{font:'inherit',borderRadius:8,border:`1px solid ${P.line}`,background:P.raised,color:P.text,padding:'6px 10px'}}>
            {rooms.map(item=><option key={item.id} value={item.id}>{item.name}{snap?.members?.some(m=>m.room===item.id&&m.busy)?' ●':''}</option>)}
          </select>
          <form onSubmit={async e=>{e.preventDefault();if(!newRoom.trim())return;if(await postBrowser({control:'create',name:newRoom.trim()}))setNewRoom('');}} style={{display:'flex',gap:4}}>
            <input value={newRoom} onChange={e=>setNewRoom(e.target.value)} placeholder="새 방" maxLength={70} style={{width:110,font:'inherit',borderRadius:8,border:`1px solid ${P.line}`,background:P.raised,color:P.text,padding:'6px 9px'}}/>
            <button type="submit" style={{font:'inherit',borderRadius:8,border:`1px solid ${P.line}`,background:P.raised,color:P.text,padding:'6px 10px',cursor:'pointer'}}>+</button>
          </form>
        </div>
      </div>
      {showAct&&members.length?<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:8,maxHeight:'22vh',overflow:'auto'}}>
        {members.map(m=>{
          const pa=approvals.find(a=>a.room===room&&a.name===m.name);
          const rawW=m.provider&&snap?.limits?.[m.provider]?.windows;
          const entries=!rawW?[]:m.provider==='agy'?((!m.model||/gemini/i.test(m.model))?['gemini-5h','gemini-weekly']:['3p-5h','3p-weekly']).filter(k=>rawW[k]&&typeof rawW[k]==='object').map(k=>[k,rawW[k]]):Object.entries(rawW).filter(([,w])=>w&&typeof w==='object');
          const elapsed=m.busy&&m.progress?.updatedAt?Math.max(0,Math.floor((Date.now()-m.progress.updatedAt)/1000)):0;
          const step=pa?'허용 요청 대기: '+pa.tool:m.conflict?'⚠ 동시 수정 주의: '+m.conflict:m.paused?'일시정지됨 (응답 중지)':m.busy?(m.progress?.step||'작업 진행 중…')+(elapsed>=2?` (${elapsed}초)`:''):m.cliError?m.cliError.message:labels[m.state]||'대기 중';
          return <div key={m.id} style={{background:P.panel,border:`1px solid ${P.line}`,borderInlineStart:`3px solid ${accentFor(m.name,m.provider)}`,borderRadius:10,padding:'8px 10px',display:'grid',gap:3,minWidth:0}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:6,fontSize:12}}>
              <span style={{fontWeight:600,display:'inline-flex',alignItems:'center',gap:6}}>
                <i style={{width:8,height:8,borderRadius:'50%',background:pa||m.conflict?'#f5c451':m.paused?P.muted:m.busy?'#4fd1a5':m.cliError||m.state==='start_failed'?'#ff7b72':P.muted,display:'inline-block'}}/>
                {m.name}{mainMember?.id===m.id?' [메인]':''}
              </span>
              <span style={{fontSize:11,color:P.muted}}>{entries.length?(fmtAge(snap.limits[m.provider].updatedAt)||'잔여량'):'잔여량 정보 없음'}</span>
            </div>
            <div style={{fontSize:12,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{step}</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {m.provider&&(m.state==='approved'||m.state==='start_failed')?<button type="button" onClick={()=>void postBrowser({room,control:'pause_agent',participant:m.id,paused:!m.paused})} style={{fontSize:11,padding:'2px 8px',borderRadius:6,border:`1px solid ${P.line}`,background:P.raised,color:P.text,cursor:'pointer'}}>{m.paused?'재개':'일시정지'}</button>:null}
              {m.state==='start_failed'&&m.provider?<button type="button" onClick={()=>void postBrowser({room,control:'retry_agent',participant:m.id})} style={{fontSize:11,padding:'2px 8px',borderRadius:6,border:`1px solid ${P.line}`,background:P.raised,color:P.text,cursor:'pointer'}}>다시 실행</button>:null}
            </div>
            {entries.map(([k,w])=>{
              const raw=w.resets_at??w.resetsAt, ms=typeof raw==='number'?(raw<1e12?raw*1000:raw):Date.parse(raw);
              const expired=Number.isFinite(ms)&&ms<=Date.now();
              const rem=expired?100:Math.max(0,Math.min(100,Math.round(100-(Number(w.utilization)||0)*100)));
              return <div key={k} style={{display:'grid',gap:2,fontSize:11,color:P.muted}}>
                <div style={{display:'flex',justifyContent:'space-between'}}><span>{(winNames[k]||k)} · 남음 {rem}%</span><span>{expired?'초기화됨':fmtReset(raw)}</span></div>
                <div style={{height:4,borderRadius:999,background:P.raised,overflow:'hidden'}}><i style={{display:'block',height:'100%',width:rem+'%',background:rem<=10?'#ff7b72':rem<=25?'#f5c451':'#4fd1a5'}}/></div>
              </div>;
            })}
          </div>;
        })}
      </div>:null}
    </header>
    <main ref={listRef} aria-label="공용 대화" style={{flex:'1 1 0',minHeight:0,overflow:'auto',padding:'18px max(16px, calc((100% - 860px) / 2))',display:'flex',flexDirection:'column',gap:12}}>
      {!events.length&&!busy.length?<div style={{margin:'auto',color:P.muted,fontSize:13}}>아직 대화가 없어요. 아래에서 메시지를 보내 보세요.</div>:null}
      {events.map(event=>{
        const own=event.name==='나';
        const m=snap?.members?.find(x=>x.room===room&&x.name===event.name);
        return <article key={event.seq} style={{flexShrink:0,maxWidth:'min(84%, 720px)',minWidth:0,alignSelf:own?'flex-end':'flex-start',background:own?P.ownBg:P.panel,border:`1px solid ${own?P.ownLine:P.line}`,borderInlineStart:`${own?1:3}px solid ${own?P.ownLine:accentFor(event.name,m?.provider)}`,borderRadius:12,padding:'10px 14px'}}>
          <strong style={{display:'block',fontSize:13,marginBottom:4,color:own?P.ownName:P.agentName}}>{event.name}</strong>
          <MessageBody text={event.text}/>
        </article>;
      })}
      {busy.map(b=><article key={'typing-'+b.id} style={{flexShrink:0,maxWidth:'min(84%, 720px)',minWidth:0,alignSelf:'flex-start',background:P.panel,border:`1px solid ${P.line}`,borderInlineStart:`3px solid ${accentFor(b.name,b.provider)}`,borderRadius:12,padding:'10px 14px'}}>
        <strong style={{display:'block',fontSize:13,marginBottom:4,color:P.agentName}}>{b.name}</strong>
        {b.progress?.preview?<MessageBody text={b.progress.preview}/>:null}
        <small style={{color:'#ffcf90',fontSize:11}}>{b.progress?.step||'작업 진행 중…'}</small>
      </article>)}
    </main>
    {approvals.length?<section style={{flex:'none',display:'grid',gap:8,maxHeight:'34vh',overflow:'auto',padding:'0 max(16px, calc((100% - 860px) / 2))'}}>
      {approvals.map(item=><div key={item.id} style={{margin:'6px 0',padding:'10px 12px',background:'#2c2a1f',border:'1px solid #8a7433',borderRadius:10}}>
        <strong>{item.name} · {item.tool} 실행 허용 요청</strong>
        <pre style={{maxHeight:100,overflow:'auto',margin:'6px 0',padding:8,background:'#14192a',borderRadius:6,whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{item.input}</pre>
        <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
          <button type="button" onClick={()=>void postBrowser({room:item.room,control:'approval_decide',id_target:item.id,allow:false},'거부 응답을 보냈어요.')} style={{padding:'6px 11px',borderRadius:8,border:`1px solid ${P.line}`,background:P.raised,color:P.text,cursor:'pointer'}}>거부</button>
          <button type="button" onClick={()=>void postBrowser({room:item.room,control:'approval_decide',id_target:item.id,allow:true},'허용 응답을 보냈어요.')} style={{padding:'6px 11px',borderRadius:8,border:`1px solid ${P.accent}`,background:P.accent,color:P.bg,fontWeight:600,cursor:'pointer'}}>이번만 허용</button>
        </div>
      </div>)}
    </section>:null}
    <footer style={{flex:'none',borderTop:`1px solid ${P.line}`,background:P.bg,padding:'12px max(16px, calc((100% - 860px) / 2))'}}>
      <form onSubmit={send} style={{display:'flex',alignItems:'flex-end',gap:8}}>
        <textarea aria-label="메시지" placeholder="메시지 보내기 (Shift+Enter 줄바꿈)" rows={Math.min(8,Math.max(1,draft.split('\n').length))} maxLength={8000} value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229&&!matchMedia('(pointer:coarse)').matches)void send(event);}} autoComplete="off" style={{flex:1,minWidth:0,maxHeight:180,resize:'none',overflowY:'auto',font:'inherit',lineHeight:1.45,background:P.panel,color:P.text,border:`1px solid ${P.line}`,borderRadius:10,padding:'10px 14px'}}/>
        <button disabled={sending||!draft.trim()} style={{flex:'none',font:'inherit',background:P.accent,border:`1px solid ${P.accent}`,color:P.bg,fontWeight:600,padding:'10px 18px',borderRadius:10,cursor:sending||!draft.trim()?'default':'pointer',opacity:sending||!draft.trim()?0.5:1}}>보내기</button>
      </form>
      {status?<p role="status" style={{margin:'6px 0 0',fontSize:12,color:P.muted}}>{status}</p>:null}
    </footer>
  </div>;
}
