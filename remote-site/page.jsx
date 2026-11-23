'use client';
import {useEffect,useState} from 'react';

const palette={
  bg:'#0f1117',
  panel:'#161922',
  raised:'#1e222d',
  line:'#2a2f3b',
  text:'#e8eaf0',
  muted:'#9aa1b0',
  accent:'#7c9cff',
  ownBg:'#1f2a4a',
  ownLine:'#2f3f6e',
  ownName:'#b6c8ff',
  agentName:'#ffbf9e'
};
const gutter='max(22px, calc((100% - 860px) / 2))';

export default function RemoteRoom(){
  const [events,setEvents]=useState([]);
  const [rooms,setRooms]=useState([]);
  const [room,setRoom]=useState('');
  const [draft,setDraft]=useState('');
  const [status,setStatus]=useState('');
  const [sending,setSending]=useState(false);
  useEffect(()=>{
    let active=true;
    async function read(){
      try{
        const result=await fetch('/api/room/browser'+(room?'?room='+encodeURIComponent(room):''),{cache:'no-store'});
        if(result.status===404&&room){if(active){setEvents([]);setRoom('');}return;}
        if(!result.ok)throw Error('소유자 계정으로 로그인했는지 확인해 주세요.');
        const data=await result.json();if(active){setEvents(data.events);setRooms(data.rooms);if(!room&&data.rooms.length)setRoom(data.rooms[0].id);}
      }catch(error){if(active)setStatus(error.message);}
    }
    void read();const timer=setInterval(read,2500);
    return()=>{active=false;clearInterval(timer);};
  },[room]);
  async function send(event){
    event.preventDefault();if(sending||!room||!draft.trim())return;
    const text=draft;setSending(true);
    try{
      const result=await fetch('/api/room/browser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),room,text})});
      if(!result.ok)throw Error('메시지를 저장하지 못했어요.');
      setDraft('');setStatus('PC로 보낼 메시지를 대기열에 넣었어요.');
    }catch(error){setStatus(error.message);}
    finally{setSending(false);}
  }
  return <div style={{display:'flex',flexDirection:'column',height:'100dvh',overflow:'hidden',background:palette.bg,color:palette.text,fontFamily:'"Pretendard","Malgun Gothic","Segoe UI",sans-serif',fontSize:14,lineHeight:1.55}}>
    <header style={{flex:'none',padding:`12px ${gutter}`,borderBottom:`1px solid ${palette.line}`,background:palette.bg,display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:'10px 16px'}}>
      <div style={{display:'flex',alignItems:'baseline',gap:10,flexWrap:'wrap'}}>
        <h1 style={{fontSize:17,margin:0}}>Agent Room</h1>
        <p style={{margin:0,fontSize:12,color:palette.muted}}>공유된 방만 표시됩니다.</p>
      </div>
      <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:palette.muted}}>
        채팅방
        <select value={room} onChange={event=>{setEvents([]);setDraft('');setRoom(event.target.value);}} style={{font:'inherit',borderRadius:8,border:`1px solid ${palette.line}`,background:palette.raised,color:palette.text,padding:'7px 11px'}}>
          {rooms.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
    </header>
    <main aria-label="공용 대화" style={{flex:'1 1 0',minHeight:0,overflow:'auto',padding:`20px ${gutter}`,display:'flex',flexDirection:'column',gap:14}}>
      {events.map(event=>{
        const own=event.name==='나';
        return <article key={event.seq} style={{flexShrink:0,maxWidth:'min(82%, 720px)',minWidth:0,alignSelf:own?'flex-end':'flex-start',background:own?palette.ownBg:palette.panel,border:`1px solid ${own?palette.ownLine:palette.line}`,borderRadius:12,padding:'10px 14px'}}>
          <strong style={{display:'block',fontSize:13,color:own?palette.ownName:palette.agentName}}>{event.name}</strong>
          <p style={{margin:'6px 0 0',whiteSpace:'pre-wrap',overflowWrap:'anywhere',color:palette.text}}>{event.text}</p>
        </article>;
      })}
    </main>
    <footer style={{flex:'none',borderTop:`1px solid ${palette.line}`,background:palette.bg,padding:`12px ${gutter}`}}>
      <form onSubmit={send} style={{display:'flex',alignItems:'flex-end',gap:8}}>
        <textarea aria-label="메시지" placeholder="메시지 보내기 (Shift+Enter 줄바꿈)" rows={Math.min(8,Math.max(1,draft.split('\n').length))} maxLength={8000} value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229&&!matchMedia('(pointer:coarse)').matches)void send(event);}} autoComplete="off" style={{flex:1,minWidth:0,maxHeight:180,resize:'none',overflowY:'auto',font:'inherit',lineHeight:1.45,background:palette.panel,color:palette.text,border:`1px solid ${palette.line}`,borderRadius:10,padding:'10px 14px'}}/>
        <button disabled={sending||!draft.trim()} style={{flex:'none',font:'inherit',background:palette.accent,border:`1px solid ${palette.accent}`,color:palette.bg,fontWeight:600,padding:'10px 18px',borderRadius:10,cursor:sending||!draft.trim()?'default':'pointer',opacity:sending||!draft.trim()?0.5:1}}>보내기</button>
      </form>
      {status?<p role="status" style={{margin:'6px 0 0',fontSize:12,color:palette.muted}}>{status}</p>:null}
    </footer>
  </div>;
}
