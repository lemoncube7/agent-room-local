'use client';
import {useEffect,useState} from 'react';

export default function RemoteRoom(){
  const [events,setEvents]=useState([]);
  const [draft,setDraft]=useState('');
  const [status,setStatus]=useState('');
  const [sending,setSending]=useState(false);
  useEffect(()=>{
    let active=true;
    async function read(){
      try{
        const result=await fetch('/api/room/browser',{cache:'no-store'});
        if(!result.ok)throw Error('소유자 계정으로 로그인했는지 확인해 주세요.');
        const data=await result.json();if(active)setEvents(data.events);
      }catch(error){if(active)setStatus(error.message);}
    }
    void read();const timer=setInterval(read,2500);
    return()=>{active=false;clearInterval(timer);};
  },[]);
  async function send(event){
    event.preventDefault();if(sending||!draft.trim())return;
    const text=draft;setSending(true);
    try{
      const result=await fetch('/api/room/browser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),text})});
      if(!result.ok)throw Error('메시지를 저장하지 못했어요.');
      setDraft('');setStatus('PC로 보낼 메시지를 대기열에 넣었어요.');
    }catch(error){setStatus(error.message);}
    finally{setSending(false);}
  }
  return <main style={{maxWidth:720,margin:'2rem auto',padding:'0 1rem',fontFamily:'system-ui'}}>
    <h1>Agent Room</h1>
    {events.map(event=><article key={event.seq} style={{borderBottom:'1px solid #8885',padding:'0.75rem 0'}}><strong>{event.name}</strong><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{event.text}</p></article>)}
    <form onSubmit={send} style={{display:'flex',gap:8,marginTop:16}}>
      <input aria-label="메시지" maxLength={8000} value={draft} onChange={event=>setDraft(event.target.value)} autoComplete="off" style={{flex:1}}/>
      <button disabled={sending||!draft.trim()}>보내기</button>
    </form>
    <p role="status">{status}</p>
  </main>;
}
