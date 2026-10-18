import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {inspectToken,verifySample,researchOutputSchema} from "../src/research.ts";
import {fixtureFor as fixture,readSnapshot as read,cases} from "./helpers/fixture-fetcher.mjs";
const selection={cases};
for(const caseData of selection.cases)test("real response replay: "+caseData.selection,async()=>{
 const {fetcher,calls}=await fixture(caseData);
 const report=await inspectToken(caseData.token,fetcher);
 assert(researchOutputSchema.safeParse(report).success);
 assert.equal(report.noPaymentOrTradeExecuted,true);
 assert(calls.every(c=>!JSON.stringify(c.init).includes("api-key")));
 assert(calls.every(c=>new URL(c.url).protocol==="https:"));
 if(caseData.selection==="highest_reported_h1_volume")assert.equal(report.evidenceStatus,"execution_evidence_incomplete");
 if(caseData.selection==="lowest_positive_liquidity_active")assert.equal(report.evidenceStatus,"exit_evidence_incomplete");
 if(caseData.selection==="established_control"){
  assert.equal(report.evidenceStatus,"indicative_entry_and_exit_available");
  assert.equal(report.pools.length,2);
  assert(report.quotes.every(q=>q.reversePriceMatched));
 }
});
test("provider outages yield a bounded partial report, never fabricated liquidity",async()=>{
 const report=await inspectToken("0x"+"a".repeat(40),async()=>{throw new Error("offline");});
 assert.equal(report.evidenceStatus,"execution_evidence_incomplete");
 assert(report.quotes.every(q=>q.buyLiquidityAvailable===null));
 assert(report.quotes.every(q=>q.roundTripDifferencePct===null));
});
test("invalid contract identifiers cannot initiate network requests",async()=>{
 let called=false;
 await assert.rejects(()=>inspectToken("WETH",async()=>{called=true;throw Error();}));
 assert.equal(called,false);
});
test("receipt replay checks onchain source and rejects a false sender claim",async()=>{
 const caseData=selection.cases[0],sample=(await read(caseData.token.toLowerCase()+"/receipt-samples.json"))[0];
 const fetcher=async(url,init)=>{
  assert.equal(url,"https://mainnet.base.org");const method=JSON.parse(init.body).method;
  const body=method==="eth_chainId"?{result:"0x2105"}:
   method==="eth_getTransactionReceipt"?sample.receipt.body:
   method==="eth_getTransactionByHash"?sample.transaction.body:{result:"0x"};
  return new Response(JSON.stringify(body));
 };
 const token=caseData.token,tx=sample.providerRecord.tx_hash;
 assert.equal((await verifySample(token,tx,sample.providerRecord.tx_from_address,fetcher)).status,"sample_verified");
 assert.equal((await verifySample(token,tx,"0x"+"0".repeat(40),fetcher)).status,"unresolved");
});
