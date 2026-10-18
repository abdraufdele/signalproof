import test from "node:test";
import assert from "node:assert/strict";
import { atomicUsdc, summarizeTrades, sizePenaltyPct } from "./metrics.mjs";
const make = (id, address, kind, volume, seconds=0) => ({id, attributes:{
  tx_from_address:"0x"+address.repeat(40), tx_hash:"0x"+"a".repeat(64),
  kind, volume_in_usd:volume, block_timestamp:new Date(1700000000000+seconds*1000).toISOString()}});
test("USDC decimal conversion is exact and rejects precision loss",()=>{
 assert.equal(atomicUsdc("0.10"),100000n);
 assert.equal(atomicUsdc("25"),25000000n);
 assert.throws(()=>atomicUsdc("0.0000001"));
 assert.throws(()=>atomicUsdc("-1"));
});
test("duplicate records are removed but separate trades sharing a transaction survive",()=>{
 const a=make("a","1","buy","10"), b=make("b","1","buy","20");
 const r=summarizeTrades([a,a,b]);
 assert.equal(r.validTradeCount,2); assert.equal(r.observedBuyVolumeUsd,30);
});
test("missing volume is rejected rather than interpreted as zero",()=>{
 const r=summarizeTrades([make("bad","1","buy",null),make("ok","2","sell","4")]);
 assert.equal(r.rejectedRecordCount,1); assert.equal(r.observedSellVolumeUsd,4);
 assert.equal(r.topFiveBuyerSharePct,null);
});
test("concentration uses observed buying volume, and actual time boundaries",()=>{
 const r=summarizeTrades(Array.from({length:6},(_,i)=>make(String(i),String(i+1),"buy","10",6-i)));
 assert.equal(r.uniqueBuyerAddresses,6);
 assert.ok(Math.abs(r.topFiveBuyerSharePct-100*5/6)<1e-10);
 assert.ok(r.observedFrom<r.observedTo);
});
test("size premium compares unit economics rather than absolute output",()=>{
 assert.equal(sizePenaltyPct({sellAmount:"25",buyAmount:"100"},{sellAmount:"100",buyAmount:"400"}),0);
 assert.equal(sizePenaltyPct({sellAmount:"25",buyAmount:"100"},{sellAmount:"100",buyAmount:"320"}),25);
});
