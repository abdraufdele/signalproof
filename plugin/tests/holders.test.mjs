import test from "node:test";
import assert from "node:assert/strict";
import {inspectHolders} from "../src/holders.ts";
import {holderCandidates} from "../src/holder-candidates.ts";
const token='0x4200000000000000000000000000000000000006',blockHash='0x'+'ab'.repeat(32),addresses=[1,2,3].map(i=>'0x'+String(i).padStart(40,'0'));
function fixture(options={}){
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url,init});const b=JSON.parse(init.body);assert.equal(init.redirect,'error');
  if(url.includes('coinmarketcap')&&options.providerDown)return new Response('{}',{status:429});
  if(url.includes('coinmarketcap'))return Response.json({status:{timestamp:new Date().toISOString()},data:{holders:addresses.map((a,i)=>({walletAddress:a,tokenAddress:options.wrongToken?'0x'+'9'.repeat(40):token,balance:'99999999',percent:'99.9',publicName:i===0?'Test custody':''}))}});
  assert.equal(url,'https://mainnet.base.org');
  const one=q=>{let result=null;
   if(q.method==='eth_chainId')result=options.wrongChain?'0x1':'0x2105';
   else if(q.method==='eth_getBlockByNumber')result={number:'0x64',hash:options.reorg&&q.params[0]==='0x64'?'0x'+'cd'.repeat(32):blockHash,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
   else if(q.method==='eth_call'){
    assert.equal(q.params[1],'0x64');const data=q.params[0].data;
    result=data==='0x18160ddd'?'0x2710':data==='0x313ce567'?'0x0':'0x'+((addresses.findIndex(a=>data.endsWith(a.slice(2)))+1)*100).toString(16);
    if(options.missingBalance&&q.id===101)return {jsonrpc:'2.0',id:q.id,error:{code:-32000}};
   }else if(q.method==='eth_getCode'){assert.equal(q.params[1],'0x64');result=q.id===1000?'0x6000':'0x';}
   else assert.fail('Unexpected RPC method');
   return {jsonrpc:'2.0',id:q.id,result};};
  return Response.json(Array.isArray(b)?b.map(one):one(b));
 };return {fetcher,calls};
}
test('holder balances and supply are synchronized to one block, re-ranked independently of provider percentages',async()=>{
 const f=fixture();const r=await inspectHolders(token,f.fetcher);assert.equal(r.status,'synchronized');assert.equal(r.blockNumber,'100');assert.equal(r.blockHashRechecked,true);assert.equal(r.coveredSupplyPct,6);assert.equal(r.topFiveCandidateSharePct,6);assert.equal(r.verifiedBalanceCount,3);assert.equal(r.holders[0].balanceAtomic,'300');assert.equal(r.completeHolderUniverseVerified,false);assert.equal(r.beneficialOwnershipVerified,false);assert.equal(r.holders.find(h=>h.address===addresses[0]).codeState,'contract_code');
});
test('reorganized block suppresses synchronized concentration claims',async()=>{const f=fixture({reorg:true});const r=await inspectHolders(token,f.fetcher);assert.equal(r.status,'partial');assert.equal(r.topFiveCandidateSharePct,null);assert.equal(r.blockHashRechecked,false);});
test('missing candidate balances preserve partial facts without a top-five verdict',async()=>{const f=fixture({missingBalance:true});const r=await inspectHolders(token,f.fetcher);assert.equal(r.status,'partial');assert.equal(r.verifiedBalanceCount,2);assert.equal(r.topFiveCandidateSharePct,null);});
test('wrong chain and unrelated token candidates cannot certify concentration',async()=>{for(const options of [{wrongChain:true},{wrongToken:true}]){const f=fixture(options);const r=await inspectHolders(token,f.fetcher);assert.equal(r.status,'unavailable');assert.equal(r.topFiveCandidateSharePct,null);}});
test('invalid identifiers cause no network calls and noncooperative calls remain bounded',async()=>{
 let calls=0;await assert.rejects(()=>inspectHolders('bad',async()=>{calls++;throw Error()}));assert.equal(calls,0);
 const start=performance.now();const r=await inspectHolders(token,()=>new Promise(()=>{}),120);assert(performance.now()-start<800);assert.equal(r.status,'unavailable');
});
test('provider throttling uses dated candidates but recalculates every balance and supply onchain',async()=>{
 const originalNow=Date.now;Date.now=()=>Date.parse(holderCandidates.observedAt)+60000;
 try{const f=fixture({providerDown:true});const r=await inspectHolders(token,f.fetcher);assert.equal(r.status,'synchronized');assert.equal(r.candidateSource,'bundled_candidate_snapshot');assert.equal(r.candidateLimit,80);assert.equal(r.verifiedBalanceCount,80);assert(r.providerWarnings.some(s=>s.includes('429')));assert.equal(r.coveredSupplyPct,0);assert.equal(r.blockHashRechecked,true);}finally{Date.now=originalNow;}
});
test('expired candidate fallback is not silently presented as current discovery',async()=>{
 const originalNow=Date.now;Date.now=()=>Date.parse(holderCandidates.observedAt)+25*3600000;
 try{const f=fixture({providerDown:true});const r=await inspectHolders(token,f.fetcher);assert.equal(r.candidateSource,'unavailable');assert.equal(r.status,'unavailable');assert.equal(r.candidateCount,0);}finally{Date.now=originalNow;}
});