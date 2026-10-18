import test from "node:test";
import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {inspectToken} from "../src/research.ts";
import {positionAmount,briefMarkdown} from "../src/brief.ts";
import {cases,fixtureFor} from "./helpers/fixture-fetcher.mjs";
const WETH=cases.find(c=>c.selection==="established_control"),USDP=cases.find(c=>c.selection==="highest_reported_liquidity");
test("position parsing is exact and bounded before any network access",()=>{
 assert.equal(positionAmount("250.123456").atomic,"250123456");
 assert.equal(positionAmount("500.000000").usdc,"500");
 assert.equal(positionAmount("10000").atomic,"10000000000");
 for(const value of ["0","0.5","10000.000001","250.1234567","01","1e3","-1"])assert.throws(()=>positionAmount(value));
});
test("custom position preserves the original ladder and uses exact matched token quantity",async()=>{
 const {fetcher,calls}=await fixtureFor(WETH,{onRequest:(url)=>{
  const u=new URL(url);
  if(u.hostname!=="api.0x.org")return;
  if(u.searchParams.get("sellAmount")==="250123456")return new Response(JSON.stringify({liquidityAvailable:true,sellToken:u.searchParams.get("sellToken"),buyToken:u.searchParams.get("buyToken"),sellAmount:"250123456",buyAmount:"12345678901234567890",blockNumber:"1"}));
  if(u.searchParams.get("sellAmount")==="12345678901234567890")return new Response(JSON.stringify({liquidityAvailable:true,sellToken:u.searchParams.get("sellToken"),buyToken:u.searchParams.get("buyToken"),sellAmount:"12345678901234567890",buyAmount:"240000000",blockNumber:"2"}));
 }});
 const r=await inspectToken(WETH.token,fetcher,8500,{positionUsdc:"250.123456",maxRoundTripDifferencePct:1});
 assert.deepEqual(r.quotes.map(q=>q.inputUsdcAtomic),["25000000","100000000","500000000","250123456"]);
 assert.equal(r.brief.positionUsdc,"250.123456");assert.equal(r.brief.state,"cost_limit_exceeded");
 assert.equal(r.brief.returnedUsdcBeforeGas,240);
 assert(calls.some(c=>new URL(c.url).searchParams.get("sellAmount")==="12345678901234567890"));
});
test("source-linked brief applies the user's cost limit without requiring payment",async()=>{
 const {fetcher}=await fixtureFor(USDP);
 const r=await inspectToken(USDP.token,fetcher,8500,{maxRoundTripDifferencePct:1});
 assert.equal(r.brief.state,"cost_limit_exceeded");assert.equal(r.brief.withinUserCostLimit,false);
 assert.equal(r.brief.paidEnrichment.required,false);assert.equal(r.verification.status,"sample_verified");
 const ids=new Set(r.brief.sources.map(s=>s.id));
 assert(r.brief.reasons.every(x=>x.evidenceIds.every(id=>ids.has(id))));
 assert(r.brief.contradictions.every(x=>x.evidenceIds.every(id=>ids.has(id))));
 assert(briefMarkdown(r).includes("Report sp_"));assert(briefMarkdown(r).includes(USDP.token));
});
test("sample sender is retained and an altered provider claim cannot pass independent verification",async()=>{
 const original=await fixtureFor(WETH);
 const {fetcher}=await fixtureFor(WETH,{onRequest:(url)=>{
  if(!url.includes("/trades?"))return;
  const source=original.trades.find(t=>url.includes(t.pool.attributes.address));
  const data=structuredClone(source.body);
  for(const trade of data.data)trade.attributes.tx_from_address="0x"+"a".repeat(40);
  return new Response(JSON.stringify(data));
 }});
 const r=await inspectToken(WETH.token,fetcher);
 assert.equal(r.pools[0].sampleTransactions[0].reportedSender,"0x"+"a".repeat(40));
 assert.equal(r.verification.status,"unresolved");assert.equal(r.verification.senderMatches,false);
 assert(r.brief.nextChecks.some(c=>c.tool==="verify_base_sample"));
});
test("authentication, rate limiting and malformed responses stay distinct from no liquidity",async()=>{
 for(const [status,error] of [[401,"authentication_or_access"],[429,"rate_limited"],[200,"non_json_response"]]){
  const r=await inspectToken(WETH.token,async()=>new Response("not JSON",{status}));
  assert(r.quotes.every(q=>q.error===error));assert(r.quotes.every(q=>q.buyLiquidityAvailable===null));
  assert.equal(r.brief.state,"entry_not_priced");
 }
});
test("a non-cooperative request cannot escape the total research budget",async()=>{
 const started=performance.now();
 const r=await inspectToken(WETH.token,()=>new Promise(()=>{}),180);
 assert(performance.now()-started<1000);
 assert.equal(r.brief.state,"entry_not_priced");
});
test("oversized source bodies fail closed without becoming facts",async()=>{
 const r=await inspectToken(WETH.token,async()=>new Response("x".repeat(701*1024)),400);
 assert(r.quotes.some(q=>q.error==="response_too_large"));assert(r.quotes.every(q=>["response_too_large","operation_budget_exhausted"].includes(q.error)));
 assert.equal(r.brief.roundTripDifferencePct,null);
});
test("invalid context and the reference token cannot initiate requests",async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error();};
 await assert.rejects(()=>inspectToken(WETH.token,fetcher,8500,{positionUsdc:"0.5"}));
 await assert.rejects(()=>inspectToken(WETH.token,fetcher,8500,{maxRoundTripDifferencePct:Infinity}));
 await assert.rejects(()=>inspectToken("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",fetcher));
 assert.equal(calls,0);
});

test("wrong token pairs and out-of-range amounts cannot become quote evidence",async()=>{
 const {fetcher}=await fixtureFor(WETH,{onRequest:(url)=>{
  const u=new URL(url);
  if(u.hostname==="api.0x.org")return new Response(JSON.stringify({liquidityAvailable:true,sellToken:u.searchParams.get("sellToken"),buyToken:"0x"+"a".repeat(40),sellAmount:u.searchParams.get("sellAmount"),buyAmount:(2n**256n).toString()}));
 }});
 const r=await inspectToken(WETH.token,fetcher);
 assert(r.quotes.every(q=>q.buyPriceAvailable===false&&q.error==="invalid_price_fields"));
});
test("a cost exactly at the user's boundary is not rejected by floating-point noise",async()=>{
 const {fetcher}=await fixtureFor(USDP);
 const r=await inspectToken(USDP.token,fetcher,8500,{maxRoundTripDifferencePct:2.236865});
 assert.equal(r.brief.withinUserCostLimit,true);
 assert.notEqual(r.brief.state,"cost_limit_exceeded");
});

