'use strict';
// Records the installed AI CLI versions for diagnostics and issue reports.
// Intent: CLIs auto-update often, so a version outside a "tested range" is NOT a warning by itself
// (that would alarm non-developers for no reason). We only keep the version so a failure can be traced,
// and flag a mismatch only when a known incompatibility symptom (e.g. an argument the CLI rejects) appears.
const {execFile}=require('node:child_process');
const cache=new Map();
const TTL=10*60*1000;

function parseVersion(text){
  const m=String(text||'').match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return m?m[0]:null;
}
function readVersion(file,{timeout=5000,run=execFile}={}){
  if(!file)return Promise.resolve(null);
  const hit=cache.get(file);
  if(hit&&Date.now()-hit.at<TTL)return Promise.resolve(hit.version);
  return new Promise(resolve=>{
    const shell=/\.(cmd|bat)$/i.test(file);
    try{
      run(file,['--version'],{timeout,windowsHide:true,shell},(error,stdout,stderr)=>{
        const version=error?null:parseVersion(stdout||stderr);
        cache.set(file,{at:Date.now(),version});
        resolve(version);
      });
    }catch{resolve(null);}
  });
}
async function readVersions(cliCfg,options){
  const out={};
  await Promise.all(Object.entries(cliCfg||{}).map(async([provider,file])=>{out[provider]=await readVersion(file,options);}));
  return out;
}
// Known symptoms that mean "this CLI version does not match what Agent Room sends".
const MISMATCH=[/unexpected argument/i,/unknown (option|flag|argument)/i,/unrecognized (option|argument)/i,/invalid value for '--/i];
function looksLikeVersionMismatch(errorText){return MISMATCH.some(re=>re.test(String(errorText||'')));}
function clearCache(){cache.clear();}
module.exports={parseVersion,readVersion,readVersions,looksLikeVersionMismatch,clearCache};
