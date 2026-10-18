import * as z from "zod/v4";
import type {EvidenceData} from "./research.js";

const ageState=z.enum(["fresh","stale","unknown"]);
export const coverageSchema=z.object({
 asOf:z.string(),maxTradeAgeMinutes:z.number(),maxCollectionAgeSeconds:z.literal(60),
 policy:z.string(),pools:z.array(z.object({
  pool:z.string(),records:z.number(),rejectedRecords:z.number(),uniqueSenders:z.number(),
  windowMinutes:z.number().nullable(),latestTradeAgeMinutes:z.number().nullable(),
  freshness:ageState,capped:z.boolean(),httpStatus:z.number().nullable(),error:z.string().nullable()
 }).strict()).max(2),
 participationStatus:z.enum(["observed_within_policy","incomplete"]),
 quoteCollectionStatus:ageState,quoteBlockOrder:z.enum(["consistent","inconsistent","unknown"]),
 referenceStatus:z.enum(["available","unavailable"]),verifiedSamples:z.number(),attemptedSamples:z.number(),
 selectedSamples:z.number(),sampledPools:z.number(),poolAddressClaimsMatched:z.number(),
 issues:z.array(z.string()).max(12)
}).strict();

export function ageAt(asOf:string,value:string|null,maxMinutes:number){
 if(!value)return {ageMinutes:null,freshness:"unknown" as const};
 const age=(Date.parse(asOf)-Date.parse(value))/60000;
 if(!Number.isFinite(age)||age< -1)return {ageMinutes:null,freshness:"unknown" as const};
 return {ageMinutes:Math.max(0,age),freshness:age>maxMinutes?"stale" as const:"fresh" as const};
}
export function buildCoverage(data:EvidenceData){
 const issues:string[]=[];
 const pools=data.pools.map(p=>{
  const age=ageAt(data.generatedAt,p.windowEnd,data.maxTradeAgeMinutes);
  const window=p.windowStart&&p.windowEnd?(Date.parse(p.windowEnd)-Date.parse(p.windowStart))/60000:NaN;
  const windowMinutes=Number.isFinite(window)&&window>=0?window:null;
  if(age.freshness!=="fresh")issues.push("Pool "+p.pool+" has "+age.freshness+" latest-trade age under the configured policy.");
  if(p.httpStatus!==200||p.error)issues.push("Pool "+p.pool+" trade retrieval: "+(p.error??"unavailable")+".");
  if(p.recentRecordCapReached)issues.push("Pool "+p.pool+" is capped; observations are not a complete trading history.");
  return {pool:p.pool,records:p.validSwapRecords,rejectedRecords:p.rejectedRecords,uniqueSenders:p.uniqueSenderAddresses,
   windowMinutes,latestTradeAgeMinutes:age.ageMinutes,freshness:age.freshness,capped:p.recentRecordCapReached,httpStatus:p.httpStatus,error:p.error};
 });
 const participationStatus=pools.length>0&&pools.every(p=>p.records>0&&p.httpStatus===200&&!p.error&&p.freshness==="fresh"&&p.windowMinutes!==null)?
  "observed_within_policy":"incomplete";
 const target=data.quotes.find(q=>q.inputUsdcAtomic===data.positionAtomic);
 const ages=target?[ageAt(data.generatedAt,target.buyFetchedAt,1),ageAt(data.generatedAt,target.reverseFetchedAt,1)]:[];
 const quoteCollectionStatus=ages.length!==2||ages.some(a=>a.freshness==="unknown")?"unknown":ages.some(a=>a.freshness==="stale")?"stale":"fresh";
 const blocks=target?.buyBlock&&target.reverseBlock?[BigInt(target.buyBlock),BigInt(target.reverseBlock)]:null;
 const quoteBlockOrder=blocks?(blocks[1]!<blocks[0]!?"inconsistent":"consistent"):"unknown";
 if(quoteCollectionStatus!=="fresh")issues.push("Selected quote collection times are "+quoteCollectionStatus+"; they do not establish current market conditions.");
 if(quoteBlockOrder!=="consistent")issues.push("Selected buy/reverse block order is "+quoteBlockOrder+".");
 const referenceStatus=data.repeated25UsdcCostChangePct!==null&&!data.referenceRecheck.error&&ageAt(data.generatedAt,data.referenceRecheck.fetchedAt,1).freshness==="fresh"?"available":"unavailable";
 if(referenceStatus==="unavailable")issues.push("The repeated reference check is unavailable or stale; stability is unknown.");
 if(data.discovery.coinGeckoHttpStatus!==200||data.discovery.dexScreenerHttpStatus!==200)
  issues.push("Discovery-provider coverage is incomplete; available pricing remains separately reported.");
 for(const conflict of data.discovery.liquidityDisagreements)issues.push("Liquidity reports disagree for "+conflict.pool+": CoinGecko "+conflict.coinGeckoUsd+" USD versus DexScreener "+conflict.dexScreenerUsd+" USD. Indexing and observation times may differ.");
 for(const sample of data.sampleChecks)if(sample.check.reportedPoolLogObserved===false)issues.push("The reported pool address was not observed in the checked receipt for "+sample.pool+".");
 const verification=data.sampleChecks;
 return coverageSchema.parse({
  asOf:data.generatedAt,maxTradeAgeMinutes:data.maxTradeAgeMinutes,maxCollectionAgeSeconds:60,
  policy:"Latest trade at most the configured age (default 30 minutes); collection at most 60 seconds old; future clock tolerance 60 seconds. These are research freshness rules, not safety or statistical-confidence thresholds. Record count is descriptive, with no 50-record pass threshold. Quote collection time does not verify provider block recency.",
  pools,participationStatus,quoteCollectionStatus,quoteBlockOrder,referenceStatus,
  selectedSamples:data.selectedVerificationClaims,attemptedSamples:verification.length,
  verifiedSamples:verification.filter(s=>s.check.status==="sample_verified").length,
  sampledPools:new Set(verification.map(s=>s.pool)).size,
  poolAddressClaimsMatched:verification.filter(s=>s.check.reportedPoolLogObserved===true).length,
  issues:issues.slice(0,12)
 });
}
