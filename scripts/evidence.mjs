import {summarizeTrades,sizePenaltyPct} from "./metrics.mjs";
const TRANSFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const poolIdPattern=/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const lower=x=>typeof x==="string"?x.toLowerCase():"";
const numeric=x=>x===null||x===undefined||x===""||!Number.isFinite(Number(x))?null:Number(x);
export function validPrice(response){
 const b=response?.body;
 return response?.httpStatus===200 && b?.liquidityAvailable===true
  && /^[1-9][0-9]*$/.test(b.buyAmount??"") && /^[1-9][0-9]*$/.test(b.sellAmount??"");
}
export function quoteEvidence(item){
 const buyValid=validPrice(item.buy),sellValid=validPrice(item.sellBack);
 const comparable=buyValid&&sellValid&&item.sellBack.body.sellAmount===item.buy.body.buyAmount;
 const returned=comparable?Number(BigInt(item.sellBack.body.buyAmount))/1e6:null;
 return {inputUsdc:item.inputUsdc,buyStatus:item.buy?.httpStatus??null,
  buyLiquidityAvailable:item.buy?.body?.liquidityAvailable??null,
  buyPriceAvailable:buyValid,reversePriceAvailable:sellValid,
  exactQuantityMatched:comparable,
  returnedUsdc:returned,roundTripShortfallUsdc:returned===null?null:item.inputUsdc-returned,
  roundTripShortfallPct:returned===null?null:(item.inputUsdc-returned)/item.inputUsdc*100,
  buyAmountAtomic:buyValid?item.buy.body.buyAmount:null,
  buyBlock:item.buy?.body?.blockNumber??null,sellBlock:item.sellBack?.body?.blockNumber??null,
  buyFetchedAt:item.buy?.receivedAt??null,sellFetchedAt:item.sellBack?.receivedAt??null,
  buyIssues:item.buy?.body?.issues??null,sellIssues:item.sellBack?.body?.issues??null,
  networkFeeWei:[item.buy?.body?.totalNetworkFee??null,item.sellBack?.body?.totalNetworkFee??null],
  sourceUrls:[item.buy?.url??null,item.sellBack?.url??null].filter(Boolean),
  errorType:item.buy?.transportError??item.buy?.body?.name??null,
  caveat:"Indicative sequential prices only, not execution. Round-trip shortfall combines route economics, provider fees and market movement; gas is not subtracted."};
}
export function receiptEvidence(sample,token,chainVerified){
 const a=sample.providerRecord??{};
 const r=sample.receipt?.body?.result,t=sample.transaction?.body?.result;
 const hashesMatch=!!r&&!!t&&lower(r.transactionHash)===lower(a.tx_hash)&&lower(t.hash)===lower(a.tx_hash);
 const sendersMatch=!!r&&!!t&&lower(r.from)===lower(a.tx_from_address)&&lower(t.from)===lower(a.tx_from_address);
 const blocksMatch=!!r&&!!t&&lower(r.blockHash)!==""&&lower(r.blockHash)===lower(t.blockHash);
 const tokenTransferObserved=Array.isArray(r?.logs)&&r.logs.some(log=>lower(log.address)===lower(token)&&lower(log.topics?.[0])===TRANSFER);
 const passed=chainVerified&&hashesMatch&&sendersMatch&&blocksMatch&&r?.status==="0x1"&&tokenTransferObserved;
 return {transactionHash:a.tx_hash,explorerUrl:"https://basescan.org/tx/"+a.tx_hash,
  status:passed?"sample_verified":"unresolved",chainVerified,hashesMatch,sendersMatch,blocksMatch,
  transactionSucceeded:r?.status==="0x1",tokenTransferObserved,
  limitation:"Verifies this sampled transaction and token activity. Does not verify amount, pool attribution, ownership, intent, all trades or economic independence."};
}
export function codeEvidence(sample){
 const code=sample.response?.body?.result;
 const status=sample.response?.httpStatus!==200||typeof code!=="string"?"unknown":
  code==="0x"?"no_code_at_latest_block":code.startsWith("0xef0100")?"delegated_code_at_latest_block":"code_present_at_latest_block";
 return {address:sample.address,status,checkedAt:sample.response?.receivedAt??null,
  limitation:"Latest bytecode is a point-in-time account property, not an identity or bot classifier."};
}
export function poolEvidence(item){
 const records=item.httpStatus===200&&Array.isArray(item.body?.data)?item.body.data:[];
 const summary=summarizeTrades(records);
 const pool=item.pool?.attributes??{};
 const valid=records.filter(r=>r?.attributes&&/^0x[0-9a-f]{64}$/i.test(r.attributes.tx_hash??""));
 const txs=new Set(valid.map(r=>lower(r.attributes.tx_hash)));
 const a=summary.topFiveBuyerSharePct;
 return {pool:pool.address,identifierKind:pool.address?.length===66?"32_byte_pool_id":"20_byte_pool_address",
  fetchedAt:item.receivedAt??null,httpStatus:item.httpStatus,status:item.httpStatus===200?"observed":"unavailable",
  ...summary,uniqueTransactionCount:txs.size,swapRecordsBeyondUniqueTransactions:summary.validTradeCount-txs.size,
  providerReturnedRecordCount:records.length,recordCapReached:records.length>=300,
  observedWindowMinutes:summary.observedFrom&&summary.observedTo?(Date.parse(summary.observedTo)-Date.parse(summary.observedFrom))/60000:null,
  topFiveShareLabel:a===null?"not available":a.toFixed(2)+"% of observed buy volume, not holder supply",
  poolCreatedAt:pool.pool_created_at??null,reportedLiquidityUsd:numeric(pool.reserve_in_usd),
  reportedH1VolumeUsd:numeric(pool.volume_usd?.h1),reportedH1PriceChangePct:numeric(pool.price_change_percentage?.h1),
  marketCapUsd:numeric(pool.market_cap_usd),fdvUsd:numeric(pool.fdv_usd)};
}
export function analyzeCase(input){
 const {caseData,discovery,dex,tradeFiles,quotes,bracket,receiptSamples,codeSamples,chainVerified}=input;
 const token=caseData.token,pools=tradeFiles.map(poolEvidence);
 const quoteRows=quotes.map(quoteEvidence);
 const base=quotes.find(q=>q.inputUsdc===25)?.buy;
 const bracketChange=validPrice(base)&&validPrice(bracket)?
  sizePenaltyPct({sellAmount:base.body.sellAmount,buyAmount:base.body.buyAmount},{sellAmount:bracket.body.sellAmount,buyAmount:bracket.body.buyAmount}):null;
 const bracketing={repeatedSizeUsdc:25,rateCostChangePct:bracketChange,
  status:bracketChange===null?"unresolved":Math.abs(bracketChange)>1?"unstable":"within_1pct_bracket",
  limitation:"Bracketing observes time variation; it does not isolate or remove market movement."};
 for(let i=0;i<quoteRows.length;i++)quoteRows[i].rateCostDifferenceVs25Pct=validPrice(base)&&validPrice(quotes[i].buy)?
  sizePenaltyPct(base.body,quotes[i].buy.body):null;
 const cgPools=(discovery?.body?.data??[]).map(p=>lower(p.attributes?.address)).filter(Boolean);
 const dexPairs=Array.isArray(dex?.body)?dex.body:[];
 const dexPools=dexPairs.map(p=>lower(p.pairAddress)).filter(Boolean);
 const poolDiscovery={coinGeckoStatus:discovery?.httpStatus??null,dexScreenerStatus:dex?.httpStatus??null,
  coinGeckoReturnedPools:cgPools.length,dexScreenerReturnedPools:dexPools.length,
  commonIdentifiers:cgPools.filter(p=>dexPools.includes(p)),
  limitations:"Provider lists can differ by indexing and pool representation; overlap is not independent verification of reserves."};
 const receipts=receiptSamples.map(s=>receiptEvidence(s,token,chainVerified));
 const senderCodes=codeSamples.map(codeEvidence);
 const findings=[],unknowns=[
  "Token deployment/launch time, holder concentration, common ownership and contract safety were not established.",
  "Quotes do not establish execution readiness, future liquidity, or profitable trading.",
  "Two provider pool lists may share upstream information; receipt checks are the independent sample validation."];
 for(const p of pools){
  if(p.reportedH1VolumeUsd>0&&p.reportedLiquidityUsd===0)findings.push({kind:"contradiction",text:"A sampled pool reports trading volume but zero current liquidity; historical activity does not establish a current route.",pool:p.pool});
  if(p.reportedH1VolumeUsd>0&&p.reportedLiquidityUsd>0&&p.reportedLiquidityUsd<25)findings.push({kind:"constraint",text:"A sampled pool reports less than $25 in current liquidity despite recorded activity.",pool:p.pool});
  if(p.validTradeCount<50)unknowns.push("Pool "+p.pool+" has fewer than 50 usable observed records; participation evidence is sparse.");
  if(p.recordCapReached)unknowns.push("Pool "+p.pool+" reached the 300-record cap; this is a truncated recent sample.");
  if(p.reportedLiquidityUsd===null)unknowns.push("Pool "+p.pool+" has unknown current liquidity.");
 }
 const missing=quoteRows.filter(q=>!q.buyPriceAvailable);
 if(missing.length)findings.push({kind:"execution_gap",text:"No valid indicative buy price returned at "+missing.map(q=>q.inputUsdc+" USDC").join(", ")+". Provider no-liquidity flags and transport failures are retained separately."});
 const reverseMissing=quoteRows.filter(q=>q.buyPriceAvailable&&!q.exactQuantityMatched);
 if(reverseMissing.length)findings.push({kind:"exit_gap",text:"A matched reverse price is unresolved at "+reverseMissing.map(q=>q.inputUsdc+" USDC").join(", ")+". This is not proof of a honeypot."});
 const complete=quoteRows.filter(q=>q.exactQuantityMatched);
 for(const q of complete)findings.push({kind:"cost",text:q.inputUsdc+" USDC: sequential indicative round trip returns "+q.returnedUsdc.toFixed(6)+" USDC before gas; difference "+q.roundTripShortfallPct.toFixed(3)+"%."});
 if(bracketing.status==="unstable")unknowns.push("The repeated 25-USDC rate changed by more than 1%; size comparisons are unstable.");
 if(receipts.some(r=>r.status!=="sample_verified")||!receipts.length)unknowns.push("Some or all sampled onchain receipt checks remain unresolved.");
 const providerComplete=pools.length>0&&pools.every(p=>p.httpStatus===200);
 const status=!providerComplete||missing.length?"execution_evidence_incomplete":reverseMissing.length?"exit_evidence_incomplete":"indicative_entry_and_exit_available";
 return {token,chainId:8453,label:caseData.tokenMetadata?.symbol??token,selection:caseData.selection,
  status,notATradeRecommendation:true,pools,poolDiscovery,quotes:quoteRows,bracketing,
  receiptSamples:receipts,senderCodeSamples:senderCodes,findings,unknowns:[...new Set(unknowns)],
  baseline:{description:"Provider-reported headline data only; not a tested competing product",pool:caseData.seedPool?.attributes?.address??pools[0]?.pool??null,
    h1VolumeUsd:numeric(caseData.seedPool?.attributes?.volume_usd?.h1),
    h1PriceChangePct:numeric(caseData.seedPool?.attributes?.price_change_percentage?.h1)},
  improvement:"Adds size-specific entry/exit prices, explicit coverage and onchain sample checks to headline activity. No predictive return claim."};
}
