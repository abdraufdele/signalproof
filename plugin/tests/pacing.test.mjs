import test from "node:test";
import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {inspectToken} from "../src/research.ts";
import {fixtureFor,cases} from "./helpers/fixture-fetcher.mjs";
const control=cases.find(c=>c.selection==="established_control");
test("a standard-plan fixed-window limiter receives no 0x burst and no automatic retries",async()=>{
 const starts=[],windows=new Map();
 const f=await fixtureFor(control,{onRequest:url=>{
  if(new URL(url).hostname!=="api.0x.org")return;
  const now=performance.now();starts.push(now);
  const window=Math.floor(now/1000),count=(windows.get(window)??0)+1;windows.set(window,count);
  if(count>5)return new Response(JSON.stringify({reason:"rate limit"}),{status:429});
 }});
 const r=await inspectToken(control.token,f.fetcher);
 assert.equal(starts.length,7);assert.equal(f.calls.filter(c=>new URL(c.url).hostname==="api.0x.org").length,7);
 assert(r.quotes.every(q=>q.reversePriceMatched));assert.equal(r.referenceRecheck.error,null);
 for(let i=1;i<starts.length;i++)assert(starts[i]-starts[i-1]>=250,`Request starts must remain spaced even across dependent phases: ${starts.map((v,j)=>j?v-starts[j-1]:0).join(",")}`);
 assert(Math.max(...windows.values())<=5);
});
test("quote-slot waits cannot start calls outside a short operation budget",async()=>{
 const starts=[];const r=await inspectToken(control.token,async url=>{
  if(new URL(url).hostname==="api.0x.org")starts.push(performance.now());
  return new Response("{}",{status:503});
 },180);
 assert(starts.length<=1);assert(r.quotes.some(q=>q.error==="operation_budget_exhausted"));
 assert(r.quotes.every(q=>q.buyLiquidityAvailable===null));
});
