import test from "node:test";
import assert from "node:assert/strict";
import {inspectToken,verifySample} from "../src/research.ts";
import {buildBrief} from "../src/brief.ts";
import {ageAt} from "../src/quality.ts";
import {fixtureFor,cases} from "./helpers/fixture-fetcher.mjs";
const control=cases.find(c=>c.selection==="established_control");
async function freshData(){
 const f=await fixtureFor(control),{brief,...data}=await inspectToken(control.token,f.fetcher);
 const now=Date.now();data.generatedAt=new Date(now).toISOString();
 for(const p of data.pools){p.windowStart=new Date(now-20*60000).toISOString();p.windowEnd=new Date(now-60000).toISOString();}
 for(const q of data.quotes){q.buyFetchedAt=data.generatedAt;q.reverseFetchedAt=data.generatedAt;q.buyBlock="100";q.reverseBlock="101";}
 data.referenceRecheck.fetchedAt=data.generatedAt;
 // Unit fixture: retain one captured claim/pool so this baseline isolates policy tests.
 data.pools=data.pools.slice(0,1);data.sampleChecks=data.sampleChecks.slice(0,1);data.selectedVerificationClaims=1;
 return data;
}
test("stale, missing and future observation times cannot claim recent participation",async()=>{
 const data=await freshData();assert.equal(buildBrief(data).state,"ready_for_research_review");
 for(const value of ["2020-01-01T00:00:00Z",null,new Date(Date.parse(data.generatedAt)+120000).toISOString()]){
  const d=structuredClone(data);d.pools[0].windowEnd=value;
  const b=buildBrief(d);assert.equal(b.state,"needs_more_evidence");assert.notEqual(b.coverage.pools[0].freshness,"fresh");
 }
});
test("freshness policy is configurable, explicit and bounded before networking",async()=>{
 const d=await freshData();d.pools[0].windowEnd=new Date(Date.parse(d.generatedAt)-45*60000).toISOString();d.pools[0].windowStart=new Date(Date.parse(d.generatedAt)-60*60000).toISOString();
 assert.equal(buildBrief(d).state,"needs_more_evidence");d.maxTradeAgeMinutes=60;
 assert.equal(buildBrief(d).state,"ready_for_research_review");assert.match(buildBrief(d).coverage.policy,/not safety/);
 let calls=0;await assert.rejects(()=>inspectToken(control.token,async()=>{calls++;},8500,{maxTradeAgeMinutes:0}));assert.equal(calls,0);
 assert.equal(ageAt(d.generatedAt,d.generatedAt,30).freshness,"fresh");
});
test("record count describes coverage rather than crossing an arbitrary confidence threshold",async()=>{
 const d=await freshData();d.pools[0].validSwapRecords=1;d.pools[0].recentRecordCapReached=true;
 const b=buildBrief(d);assert.equal(b.state,"ready_for_research_review");assert.equal(b.coverage.pools[0].records,1);
 assert(b.coverage.issues.some(s=>s.includes("capped")));assert.match(b.conclusion,/not statistical confidence/);
 d.pools[0].validSwapRecords=0;assert.equal(buildBrief(d).state,"needs_more_evidence");
});
test("missing reference, aged collection and backwards blocks preserve quotes but downgrade readiness",async()=>{
 for(const change of [
 d=>{d.repeated25UsdcCostChangePct=null;d.referenceRecheck.error="rate_limited";},
 d=>{d.quotes.find(q=>q.inputUsdc===500).reverseFetchedAt="2020-01-01T00:00:00Z";},
 d=>{d.quotes.find(q=>q.inputUsdc===500).reverseBlock="99";}
 ]){
  const d=await freshData();change(d);const b=buildBrief(d);
  assert.equal(b.state,"needs_more_evidence");assert(b.returnedUsdcBeforeGas>0);
 }
});
test("one pool outage cannot erase successful pricing or become zero liquidity",async()=>{
 const base=await fixtureFor(control),bad=base.trades[0].pool.attributes.address;
 const f=await fixtureFor(control,{onRequest:url=>url.includes("/pools/"+bad+"/trades")?new Response("busy",{status:429}):undefined});
 const r=await inspectToken(control.token,f.fetcher);
 assert(r.quotes.every(q=>q.reversePriceMatched));assert(r.pools.some(p=>p.error==="rate_limited"));
 assert.equal(r.brief.state,"needs_more_evidence");assert.equal(r.brief.coverage.participationStatus,"incomplete");
});
test("samples are deterministic across provider response ordering and cover selected pools",async()=>{
 const normal=await fixtureFor(control),shuffled=await fixtureFor(control,{onRequest:url=>{
  if(!url.includes("/trades?"))return;const source=normal.trades.find(t=>url.includes(t.pool.attributes.address));
  return new Response(JSON.stringify({...source.body,data:[...source.body.data].reverse()}));
 }});
 const a=await inspectToken(control.token,normal.fetcher),b=await inspectToken(control.token,shuffled.fetcher);
 assert.equal(a.sampleChecks.length,a.pools.length);
 assert.deepEqual(a.pools.map(p=>p.sampleTransactions),b.pools.map(p=>p.sampleTransactions));
 const rpcCalls=normal.calls.filter(c=>new URL(c.url).hostname==="mainnet.base.org").map(c=>JSON.parse(c.init.body));
 assert.equal(rpcCalls.filter(c=>c.method==="eth_chainId").length,1);
});
test("token verification, pool-address activity and pool-ID association remain separate",async()=>{
 const f=await fixtureFor(control),s=f.samples[0],tx=s.providerRecord.tx_hash,sender=s.providerRecord.tx_from_address;
 const tokenOnly=await verifySample(control.token,tx,sender,f.fetcher);
 assert.equal(tokenOnly.status,"sample_verified");assert.equal(tokenOnly.reportedPoolLogObserved,null);
 const absent=await verifySample(control.token,tx,sender,f.fetcher,7000,"0x"+"a".repeat(40));
 assert.equal(absent.status,"sample_verified");assert.equal(absent.poolActivityState,"address_log_not_observed");assert.equal(absent.swapDirectionAndAmountVerified,false);
 const id=await verifySample(control.token,tx,sender,f.fetcher,7000,"0x"+"b".repeat(64));
 assert.equal(id.poolActivityState,"pool_id_not_checked");assert.equal(id.reportedPoolLogObserved,null);
 const d=await freshData();d.sampleChecks[0].check=absent;assert.equal(buildBrief(d).state,"needs_more_evidence");
});
test("a malformed or removed Transfer log cannot verify token activity",async()=>{
 const f=await fixtureFor(control),s=f.samples[0];
 for(const bad of ["data","topics","removed"]){
  const fetcher=async(url,init)=>{
   const response=await f.fetcher(url,init),body=await response.json();
   if(JSON.parse(init.body).method==="eth_getTransactionReceipt"){
    for(const l of body.result.logs??[])if(l.address?.toLowerCase()===control.token.toLowerCase()){
     if(bad==="data")l.data="0x";if(bad==="topics")l.topics=l.topics.slice(0,1);if(bad==="removed")l.removed=true;
    }
   }return new Response(JSON.stringify(body));
  };
  const r=await verifySample(control.token,s.providerRecord.tx_hash,s.providerRecord.tx_from_address,fetcher);
  assert.equal(r.status,"unresolved");assert.equal(r.targetTokenTransferObserved,false);
 }
});
test("RPC errors and wrong chains fail verification instead of certifying pool activity",async()=>{
 const f=await fixtureFor(control),s=f.samples[0];
 const fetcher=async(url,init)=>JSON.parse(init.body).method==="eth_chainId"?new Response(JSON.stringify({result:"0x1",error:{code:-1}})):f.fetcher(url,init);
 const r=await verifySample(control.token,s.providerRecord.tx_hash,s.providerRecord.tx_from_address,fetcher,7000,"0x"+"a".repeat(40));
 assert.equal(r.status,"unresolved");assert.equal(r.reportedPoolLogObserved,null);assert(r.errors.includes("rpc_error"));
});
test("zero-versus-positive liquidity disagreements are exposed, not silently averaged",async()=>{
 const f=await fixtureFor(control),pool=f.pools.body.data.find(p=>p.attributes.address.length===42)??f.pools.body.data[0];
 const fetcher=async(url,init)=>{
  if(new URL(url).hostname==="api.dexscreener.com")return new Response(JSON.stringify([{chainId:"base",pairAddress:pool.attributes.address,
   baseToken:{address:control.token},quoteToken:{address:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},liquidity:{usd:0}}]));
  return f.fetcher(url,init);
 };
 const r=await inspectToken(control.token,fetcher);
 assert(r.discovery.liquidityDisagreements.length>0);assert(r.brief.coverage.issues.some(s=>s.includes("Liquidity reports disagree")));
 const d=await freshData();d.discovery.liquidityDisagreements=r.discovery.liquidityDisagreements;assert.equal(buildBrief(d).state,"needs_more_evidence");
});

test("wall-clock jumps cannot consume the monotonic operation budget",async()=>{
 const f=await fixtureFor(control),original=Date.now;let jumps=0;
 try{
  Date.now=()=>original()+(++jumps)*120000;
  const r=await inspectToken(control.token,f.fetcher);
  assert(r.quotes.every(q=>q.reversePriceMatched));assert.equal(r.sampleChecks.length,r.selectedVerificationClaims);
  assert(r.sampleChecks.length>0);
 }finally{Date.now=original;}
});
