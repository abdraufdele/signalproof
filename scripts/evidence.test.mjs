import test from "node:test";
import assert from "node:assert/strict";
import {analyzeCase,poolIdPattern,poolEvidence,quoteEvidence,receiptEvidence,codeEvidence} from "./evidence.mjs";
const p=(sell,buy)=>({httpStatus:200,body:{liquidityAvailable:true,sellAmount:sell,buyAmount:buy}});
test("new 32-byte pool IDs are retained alongside 20-byte addresses",()=>{
 assert(poolIdPattern.test("0x"+"a".repeat(64)));assert(poolIdPattern.test("0x"+"a".repeat(40)));assert(!poolIdPattern.test("0x"+"a".repeat(42)));
});
test("one transaction with two swaps is not counted as two transactions",()=>{
 const attributes={tx_from_address:"0x"+"1".repeat(40),tx_hash:"0x"+"a".repeat(64),kind:"buy",volume_in_usd:"10",block_timestamp:"2026-10-16T19:00:00Z"};
 const result=poolEvidence({httpStatus:200,pool:{attributes:{address:"0x"+"a".repeat(64)}},body:{data:[{id:"a",attributes},{id:"b",attributes},{id:"a",attributes}]}});
 assert.equal(result.validTradeCount,2);assert.equal(result.uniqueTransactionCount,1);
});
test("round-trip calculation requires the exact bought token quantity",()=>{
 const matched=quoteEvidence({inputUsdc:25,buy:p("25000000","100000000000000000001"),sellBack:p("100000000000000000001","24500000")});
 assert.equal(matched.roundTripShortfallPct,2);
 const wrong=quoteEvidence({inputUsdc:25,buy:p("25000000","100000000000000000001"),sellBack:p("100000000000000000000","24500000")});
 assert.equal(wrong.roundTripShortfallPct,null);assert.equal(wrong.exactQuantityMatched,false);
});
test("provider failure is not reported as zero liquidity",()=>{
 const result=quoteEvidence({inputUsdc:25,buy:{httpStatus:503,body:null}});
 assert.equal(result.buyLiquidityAvailable,null);assert.equal(result.buyPriceAvailable,false);
 const pool=poolEvidence({httpStatus:200,pool:{attributes:{reserve_in_usd:null}},body:{data:[]}});
 assert.equal(pool.reportedLiquidityUsd,null);
});
test("receipt validation requires correct chain, hashes, sender, block and target token activity",()=>{
 const hash="0x"+"1".repeat(64),sender="0x"+"2".repeat(40),token="0x"+"3".repeat(40),block="0x"+"4".repeat(64);
 const sample={providerRecord:{tx_hash:hash,tx_from_address:sender},receipt:{body:{result:{transactionHash:hash,from:sender,blockHash:block,status:"0x1",logs:[{address:token,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}]}}},transaction:{body:{result:{hash,from:sender,blockHash:block}}}};
 assert.equal(receiptEvidence(sample,token,true).status,"sample_verified");
 assert.equal(receiptEvidence(sample,token,false).status,"unresolved");
 sample.transaction.body.result.from="0x"+"5".repeat(40);
 assert.equal(receiptEvidence(sample,token,true).status,"unresolved");
});
test("account bytecode is not presented as proof of independent human ownership",()=>{
 assert.equal(codeEvidence({response:{httpStatus:200,body:{result:"0x"}}}).status,"no_code_at_latest_block");
 assert.equal(codeEvidence({response:{httpStatus:200,body:{result:"0xef0100abc"}}}).status,"delegated_code_at_latest_block");
 assert.equal(codeEvidence({response:{httpStatus:503}}).status,"unknown");
});
test("empty evidence yields an incomplete verdict; market drift is explicit",()=>{
 const common={caseData:{token:"0x"+"a".repeat(40)},discovery:{},dex:{},tradeFiles:[],receiptSamples:[],codeSamples:[],chainVerified:false};
 assert.equal(analyzeCase({...common,quotes:[],bracket:{}}).status,"execution_evidence_incomplete");
 const result=analyzeCase({...common,quotes:[{inputUsdc:25,buy:p("25000000","100000000000000000000"),sellBack:p("100000000000000000000","24500000")}],bracket:p("25000000","90000000000000000000")});
 assert.equal(result.bracketing.status,"unstable");
});
