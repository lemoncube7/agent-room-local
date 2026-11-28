const encoder=new TextEncoder();
const curve={name:'ECDH',namedCurve:'P-256'};

function decode(value){
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
}

function join(...parts){
  const bytes=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return bytes;
}

async function derive(secret,salt,info,bits){
  const key=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);
  return crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,bits);
}

// RFC 8291 uses a single RFC 8188 record for each push payload.
export async function encryptPushPayload(payload,p256dh,auth){
  const receiver=decode(p256dh), authSecret=decode(auth);
  const message=encoder.encode(payload);
  if(receiver.length!==65||receiver[0]!==4||authSecret.length!==16||message.length>3993)throw Error('Invalid push payload or subscription key');
  const peer=await crypto.subtle.importKey('raw',receiver,curve,false,[]);
  const sender=await crypto.subtle.generateKey(curve,true,['deriveBits']);
  const senderRaw=new Uint8Array(await crypto.subtle.exportKey('raw',sender.publicKey));
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},sender.privateKey,256);
  const context=join(encoder.encode('WebPush: info\0'),receiver,senderRaw);
  const inputKey=await derive(shared,authSecret,context,256);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const [cek,nonce]=await Promise.all([
    derive(inputKey,salt,encoder.encode('Content-Encoding: aes128gcm\0'),128),
    derive(inputKey,salt,encoder.encode('Content-Encoding: nonce\0'),96)
  ]);
  const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,join(message,Uint8Array.of(2)));
  const header=new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16,4096);
  header[20]=senderRaw.length;
  return join(header,senderRaw,new Uint8Array(ciphertext));
}
