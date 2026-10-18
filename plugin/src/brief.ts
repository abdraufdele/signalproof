import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { EvidenceData } from "./research.js";
import {buildCoverage,coverageSchema} from "./quality.js";

export const positionPattern=/^(?:[1-9][0-9]{0,3}(?:\.[0-9]{1,6})?|10000(?:\.0{1,6})?)$/;
export type ResearchRequest={positionUsdc?:string;maxRoundTripDifferencePct?:number;maxTradeAgeMinutes?:number};
export function positionAmount(value="500"){
 if(!positionPattern.test(value))throw new Error("Position must be 1–10000 USDC, with at most six decimals.");
 const [whole,fraction=""]=value.split(".");
 const atomic=BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,"0"));
 const normalized=whole+(fraction.replace(/0+$/,"")?"."+fraction.replace(/0+$/,""):"");
 return {usdc:normalized,atomic:atomic.toString(),display:Number(atomic)/1e6};
}
const reason=z.object({text:z.string(),evidenceIds:z.array(z.string())}).strict();
export const evidenceBriefSchema=z.object({
 reportId:z.string(),question:z.string(),coverage:coverageSchema,
 state:z.enum(["entry_not_priced","reverse_not_priced","market_moving","cost_limit_exceeded","needs_more_evidence","ready_for_research_review"]),
 conclusion:z.string(),positionUsdc:z.string(),costLimitPct:z.number().nullable(),
 roundTripDifferencePct:z.number().nullable(),returnedUsdcBeforeGas:z.number().nullable(),withinUserCostLimit:z.boolean().nullable(),
 reasons:z.array(reason).max(10),contradictions:z.array(reason).max(8),
 sources:z.array(z.object({id:z.string(),label:z.string(),url:z.string(),observedAt:z.string()}).strict()).max(16),
 nextChecks:z.array(z.object({priority:z.number(),action:z.string(),reason:z.string(),tool:z.string().nullable(),argumentsJson:z.string().nullable()}).strict()).max(6),
 scope:z.array(z.string()).max(8),
 paidEnrichment:z.object({required:z.literal(false),relevance:z.string(),proposalTool:z.literal("propose_research_purchase")}).strict()
}).strict();
export function buildBrief(data:EvidenceData){
 const coverage=buildCoverage(data);
 const target=data.quotes.find(q=>q.inputUsdcAtomic===data.positionAtomic);
 const quoteId=(atomic:string)=>"Q"+positionAmount(String(Number(BigInt(atomic))/1e6)).usdc;
 const sources:z.infer<typeof evidenceBriefSchema>["sources"]=[];
 const reasons:z.infer<typeof reason>[]=[],contradictions:z.infer<typeof reason>[]=[];
 const fmt=(value:number|null)=>value===null?"unknown":value.toFixed(1);
 data.pools.forEach((pool,index)=>{
  const id="P"+(index+1);
  sources.push({id,label:"Pool "+(index+1)+" observed trades",url:pool.sourceUrl,observedAt:pool.fetchedAt});
  sources.push({id:id+"M",label:"Pool "+(index+1)+" metadata",url:data.discovery.coinGeckoSourceUrl,observedAt:pool.metadataFetchedAt});
  reasons.push({text:pool.validSwapRecords+" usable swap records from "+pool.uniqueSenderAddresses+" sender addresses; "+
   (pool.topFiveObservedBuySharePct===null?"buy concentration unavailable":pool.topFiveObservedBuySharePct.toFixed(2)+"% of observed buy volume from the five largest observed buyer addresses")+
   ". Window: "+(pool.windowStart??"unknown")+" to "+(pool.windowEnd??"unknown")+
   "; latest age "+fmt(coverage.pools[index]!.latestTradeAgeMinutes)+" minutes ("+coverage.pools[index]!.freshness+
   "); "+(pool.recentRecordCapReached?"capped sample":"cap not reached")+".",evidenceIds:[id]});
  if(pool.reportedH1VolumeUsd!==null&&pool.reportedH1VolumeUsd>0&&pool.liquidityUsd===0)
   contradictions.push({text:"Reported historical activity coexists with zero reported current pool liquidity. Historical volume does not establish a current route.",evidenceIds:[id+"M"]});
 });
 for(const quote of data.quotes){
  const id=quoteId(quote.inputUsdcAtomic);
  sources.push({id,label:quote.inputUsdc+"-USDC entry price",url:quote.buySourceUrl,observedAt:quote.buyFetchedAt});
  if(quote.reverseSourceUrl)sources.push({id:id+"R",label:quote.inputUsdc+"-USDC matched-quantity reverse price",url:quote.reverseSourceUrl,observedAt:quote.reverseFetchedAt!});
 }
 sources.push({id:"T25",label:"Repeated 25-USDC reference price",url:data.referenceRecheck.sourceUrl,observedAt:data.referenceRecheck.fetchedAt});
 const qid=target?quoteId(target.inputUsdcAtomic):null;
 if(target){
  if(!target.buyPriceAvailable)reasons.push({text:target.buyLiquidityAvailable===false?
   "The pricing provider reported no available entry liquidity for "+data.positionUsdc+" USDC.":
   "Entry pricing for the requested position is unresolved; this is not evidence that the token has no liquidity.",
   evidenceIds:qid?[qid]:[]});
  else if(!target.reversePriceMatched){
   reasons.push({text:"An indicative entry price was returned, but a reverse price for exactly that token quantity is unresolved.",evidenceIds:qid?[qid,...(target.reverseSourceUrl?[qid+"R"]:[])]:[]});
   contradictions.push({text:"An available buy price does not establish a priced exit. Missing reverse pricing does not establish a honeypot.",evidenceIds:qid?[qid,...(target.reverseSourceUrl?[qid+"R"]:[])]:[]});
  }else reasons.push({text:data.positionUsdc+" USDC hypothetically returns "+target.returnedUsdc!.toFixed(6)+
   " USDC through sequential indicative buy/reverse prices, a "+target.roundTripDifferencePct!.toFixed(3)+"% difference before gas.",evidenceIds:qid?[qid,qid+"R"]:[]});
 }
 data.sampleChecks.forEach((sample,index)=>{
  sources.push({id:"V"+(index+1),label:"Transaction sample for pool "+sample.pool,url:sample.check.explorerUrl,observedAt:sample.check.checkedAt});
 });
 reasons.push({text:coverage.verifiedSamples+" of "+coverage.attemptedSamples+" attempted transaction/token samples verified across "+
  coverage.sampledPools+" pools; "+coverage.selectedSamples+" claims selected. Pool-address log matches: "+coverage.poolAddressClaimsMatched+
  ". Swap direction and amount remain unverified.",evidenceIds:data.sampleChecks.map((_,i)=>"V"+(i+1))});
 for(const issue of coverage.issues)contradictions.push({text:issue,evidenceIds:[]});
 const unstable=data.repeated25UsdcCostChangePct!==null&&Math.abs(data.repeated25UsdcCostChangePct)>1;
 if(unstable)contradictions.push({text:"The repeated 25-USDC effective price changed by more than 1%; time variation confounds comparisons across sizes.",evidenceIds:["Q25","T25"]});
 const within=target?.roundTripDifferencePct!=null&&data.maxRoundTripDifferencePct!==null?
  (target.roundTripDifferencePct<=data.maxRoundTripDifferencePct||Math.abs(target.roundTripDifferencePct-data.maxRoundTripDifferencePct)<=Number.EPSILON*Math.max(1,Math.abs(target.roundTripDifferencePct),Math.abs(data.maxRoundTripDifferencePct))*8):null;
 const participationIncomplete=coverage.participationStatus!=="observed_within_policy";
 const verificationIncomplete=coverage.selectedSamples===0||coverage.attemptedSamples!==coverage.selectedSamples||coverage.verifiedSamples!==coverage.selectedSamples||data.sampleChecks.some(s=>s.check.reportedPoolLogObserved===false);
 const timingIncomplete=data.discovery.liquidityDisagreements.length>0||coverage.quoteCollectionStatus!=="fresh"||coverage.quoteBlockOrder!=="consistent"||coverage.referenceStatus!=="available";
 const state=!target?.buyPriceAvailable?"entry_not_priced":!target.reversePriceMatched?"reverse_not_priced":
  unstable?"market_moving":within===false?"cost_limit_exceeded":
  participationIncomplete||verificationIncomplete||timingIncomplete?"needs_more_evidence":"ready_for_research_review";
 const conclusions={
  entry_not_priced:"The requested entry is not supported by a valid current price response. Resolve pricing coverage before drawing a trade conclusion.",
  reverse_not_priced:"Entry pricing is available, but a matched reverse price is unresolved. The evidence does not support an exit-cost estimate.",
  market_moving:"The repeated reference price moved materially during collection. Treat the size comparison as unstable.",
  cost_limit_exceeded:"The observed sequential round-trip difference exceeds your stated limit. Review the cost evidence and time variation.",
  needs_more_evidence:"Some useful pricing evidence is available, but freshness, coverage, timing or sampled verification remains incomplete.",
  ready_for_research_review:"The requested position has indicative entry/reverse pricing, captured participation within the stated freshness policy and successful transaction/token sample checks for the selected pools. These are bounded observations, not statistical confidence, token safety, verified swap amounts or execution approval."
 };
 const next:z.infer<typeof evidenceBriefSchema>["nextChecks"]=[];
 if(!target?.buyPriceAvailable)next.push({priority:1,action:"Resolve the entry-pricing gap",reason:target?.buyLiquidityAvailable===false?
  "The provider reported no available route at this size. Check other current venues before inferring broader availability.":
  "Check provider status, configured host access, credentials and rate limits before interpreting a missing response.",tool:null,argumentsJson:null});
 else if(!target.reversePriceMatched)next.push({priority:1,action:"Investigate the missing reverse price",reason:"Inspect current alternate venues and the exact token quantity. Do not infer sellability or a honeypot from this result alone.",tool:null,argumentsJson:null});
 if(unstable)next.push({priority:next.length+1,action:"Recheck when price variation is understood",reason:"The repeated 25-USDC reference changed by more than 1%; this does not isolate price impact.",tool:null,argumentsJson:null});
 if(within===false)next.push({priority:next.length+1,action:"Review the cost-limit mismatch",reason:"Compare the existing size ladder and account for provider fees, sequential market movement and excluded gas. No trade has occurred.",tool:null,argumentsJson:null});
 if(verificationIncomplete){
  const failed=data.sampleChecks.find(s=>s.check.status!=="sample_verified");
  const sample=failed?{transactionHash:failed.check.transactionHash,reportedSender:data.pools.find(p=>p.pool===failed.pool)?.sampleTransactions[0]?.reportedSender}:data.pools.flatMap(p=>p.sampleTransactions)[0];
  if(sample)next.push({priority:next.length+1,action:"Verify a provider-reported transaction and sender",reason:"Independent sample verification is unresolved or was outside the call budget.",
   tool:"verify_base_sample",argumentsJson:JSON.stringify({token:data.token,transactionHash:sample.transactionHash,expectedSender:sample.reportedSender})});
 }
 if(participationIncomplete)next.push({priority:next.length+1,action:"Improve participation coverage",reason:"Inspect the configured latest-trade age, missing retrievals, sample window and cap. Record count is descriptive; no count alone establishes confidence.",tool:null,argumentsJson:null});
 if(timingIncomplete)next.push({priority:next.length+1,action:"Resolve quote timing and reference gaps",reason:"A missing or stale reference is not evidence of stability. Check collection times and buy/reverse blocks before comparing costs.",tool:null,argumentsJson:null});
 next.push({priority:next.length+1,action:"Assess complete wallet-specific costs",reason:"The price-only limit excludes gas and approvals. Supply a public taker address. Separate the complete cost scenario from wallet readiness; missing fee or simulation evidence must remain explicit.",tool:"assess_base_execution_cost",argumentsJson:null});
 next.push({priority:next.length+1,action:"Synchronize holder concentration",reason:"Check provider candidates against one onchain block; keep global ranking and beneficial ownership limits explicit.",tool:"inspect_base_holder_concentration",argumentsJson:JSON.stringify({token:data.token})});
 next.push({priority:next.length+1,action:"Investigate contract and ownership questions separately",reason:"Recent trading and indicative prices do not establish token permissions, holder distribution, economic independence or safety.",tool:null,argumentsJson:null});
 return evidenceBriefSchema.parse({
  reportId:"sp_"+createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0,16),
  question:"What evidence supports reviewing "+data.token+" on Base for a "+data.positionUsdc+"-USDC position?",
  state,coverage,conclusion:conclusions[state],positionUsdc:data.positionUsdc,costLimitPct:data.maxRoundTripDifferencePct,
  roundTripDifferencePct:target?.roundTripDifferencePct??null,returnedUsdcBeforeGas:target?.returnedUsdc??null,withinUserCostLimit:within,
  reasons:reasons.slice(0,10),contradictions:contradictions.slice(0,8),sources:sources.slice(0,16),nextChecks:next.slice(0,6),
  scope:["Research assessment only. No wallet funding, signature, trade or payment was used.",
   "Indicative sequential prices combine routing, fees and time variation; gas is excluded.",
   "Sender addresses are not independent people or holder balances. Concentration concerns sampled buy volume only.",
   "Pool creation is not token deployment or launch time. A recent sample can be capped or incomplete.",
   "Verification covers selected transaction/sender/token activity. Pool-address log checks are separate and do not decode swap amounts or direction; 32-byte pool IDs remain unassociated.",
   "The report fingerprint identifies this report content; it is not a proof that every provider statement is correct."],
  paidEnrichment:{required:false,relevance:"Optional broad Ethereum context is separate. The existing paid endpoint is not verified to resolve this token's exit, contract or ownership gaps.",proposalTool:"propose_research_purchase"}
 });
}
export function briefMarkdown(report:{brief:z.infer<typeof evidenceBriefSchema>}){
 const b=report.brief,sources=new Map(b.sources.map(s=>[s.id,s]));
 const refs=(ids:string[])=>ids.map(id=>{const s=sources.get(id);return s?"["+id+"]("+s.url+")":id;}).join(" ");
 return [
  "# SignalProof research brief",b.question,"**"+b.state.replaceAll("_"," ")+"**",b.conclusion,
  "## Evidence",...b.reasons.map(r=>"- "+r.text+" "+refs(r.evidenceIds)),
  ...(b.contradictions.length?["## Conflicts to investigate",...b.contradictions.map(r=>"- "+r.text+" "+refs(r.evidenceIds))]:[]),
  "## Next checks",...b.nextChecks.map(n=>n.priority+". "+n.action+": "+n.reason+(n.tool?" Tool: "+n.tool+(n.argumentsJson?" "+n.argumentsJson:""):"")),
  "## Coverage policy",b.coverage.policy,...b.coverage.issues.map(s=>"- "+s),
  "## Source times",...b.sources.map(s=>"- "+s.id+": "+s.observedAt),
  "## Limits",...b.scope.map(s=>"- "+s),
  "Report "+b.reportId+". Paid enrichment is optional; "+b.paidEnrichment.relevance
 ].join("\n\n");
}
