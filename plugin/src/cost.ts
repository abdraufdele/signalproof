import * as z from "zod/v4";
import {positionAmount} from "./brief.js";
const USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",WETH="0x4200000000000000000000000000000000000006";
const RPC="https://mainnet.base.org",ORACLE="0x420000000000000000000000000000000000000f";
const HOLDER="0x0000000000001ff3684f28c67538d4d072c22734";
const address=/^0x[0-9a-f]{40}$/i;
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
const uint=(v:unknown)=>typeof v==="string"&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<2n**256n?BigInt(v):null;
const hexUint=(v:unknown)=>typeof v==="string"&&/^0x[0-9a-f]{1,64}$/i.test(v)?BigInt(v):null;
const atomicText=(v:bigint|null)=>v===null?null:v.toString();
const word=(v:bigint)=>v.toString(16).padStart(64,"0");
export const costOutputSchema=z.object({token:z.string(),taker:z.string(),chainId:z.literal(8453),positionUsdc:z.string(),checkedAt:z.string(),
 status:z.enum(["estimate_available","incomplete"]),executionVerified:z.literal(false),holderConcentrationStatus:z.literal("not_assessed_by_this_tool"),walletReady:z.boolean(),walletIssues:z.array(z.string()),approvalEstimationMode:z.literal("native_balance_override_read_only"),slippageBpsPerLeg:z.number(),l1FeeUpperBoundWeiPerTransaction:z.string().nullable(),operatorFeeUpperBoundWeiPerTransaction:z.string().nullable(),
 returnedUsdcBeforeNetworkFees:z.number().nullable(),knownNetworkCostUsdc:z.number().nullable(),estimatedTotalCostPct:z.number().nullable(),withinCostLimit:z.boolean().nullable(),
 costLimitPct:z.number(),legs:z.array(z.object({side:z.string(),sourceUrl:z.string(),fetchedAt:z.string(),httpStatus:z.number().nullable(),sellAmount:z.string(),buyAmount:z.string().nullable(),minimumBuyAmount:z.string().nullable(),networkFeeWei:z.string().nullable(),approvalNetworkFeeWei:z.string().nullable(),approvalRequired:z.boolean().nullable(),balanceIssue:z.boolean().nullable(),simulationIncomplete:z.boolean().nullable(),error:z.string().nullable()}).strict()).max(2),
 diagnostics:z.array(z.string()).max(20),gaps:z.array(z.string()).max(20),limitations:z.array(z.string()),noPaymentOrTradeExecuted:z.literal(true)}).strict();
export async function assessCost(token:string,taker:string,positionUsdc="500",limit=2,fetcher:typeof fetch=fetch,budgetMs=8500,slippageBpsPerLeg=25){
 if(!address.test(token)||!address.test(taker)||token.toLowerCase()===USDC||!Number.isFinite(limit)||limit<0||limit>100||!Number.isInteger(slippageBpsPerLeg)||slippageBpsPerLeg<0||slippageBpsPerLeg>500)throw Error("Invalid token, public taker or cost limit");
 token=token.toLowerCase();taker=taker.toLowerCase();const position=positionAmount(positionUsdc),deadline=performance.now()+budgetMs;
 const diagnostics:string[]=[],gaps:string[]=[],walletIssues:string[]=[],legs:z.infer<typeof costOutputSchema>["legs"]=[];
 async function read(url:string,payload?:Obj){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const remaining=deadline-performance.now();
  const base={fetchedAt:new Date().toISOString(),httpStatus:null as number|null,body:{} as Obj,error:null as string|null};
  if(remaining<100)return {...base,error:"operation_budget_exhausted"};
  try{
   const operation=(async()=>{
    const r=await fetcher(url,{method:payload?"POST":"GET",redirect:"error",signal:controller.signal,headers:payload?{"content-type":"application/json"}:{"0x-version":"v2"},...(payload?{body:JSON.stringify(payload)}:{})});
    const chunks:Uint8Array[]=[];let size=0;const stream=r.body?.getReader();
    if(stream)try{for(;;){const c=await stream.read();if(c.done)break;size+=c.value.byteLength;if(size>700*1024){await stream.cancel();throw Error("response_too_large");}chunks.push(c.value);}}finally{stream.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    return {fetchedAt:new Date().toISOString(),httpStatus:r.status,body:obj(JSON.parse(new TextDecoder().decode(bytes))),error:r.ok?null:r.status===429?"rate_limited":r.status===401||r.status===403?"authentication_or_access":"provider_http_error"};
   })();
   return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("network_or_timeout"));},Math.min(2500,remaining));})]);
  }catch(e){return {...base,error:e instanceof Error&&e.message==="response_too_large"?e.message:"network_or_timeout"};}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 const rpc=async(method:string,params:unknown[])=>{const r=await read(RPC,{jsonrpc:"2.0",id:1,method,params});if(r.error||r.body.error){diagnostics.push(method+": "+(r.error??("rpc_error_"+String(obj(r.body.error).code))));return null;}return r.body.result;};
 let lastQuoteStart=-Infinity;
 const quote=async(sellToken:string,buyToken:string,amount:string,firm=true)=>{
  while(performance.now()<lastQuoteStart+275)await new Promise<void>(resolve=>setTimeout(resolve,Math.max(1,lastQuoteStart+275-performance.now())));
  const url="https://api.0x.org/swap/allowance-holder/"+(firm?"quote":"price")+"?"+new URLSearchParams({chainId:"8453",sellToken,buyToken,sellAmount:amount,...(firm?{taker}:{}),slippageBps:String(slippageBpsPerLeg)});
  lastQuoteStart=performance.now();const r=await read(url),b=r.body;
  const valid=!r.error&&b.liquidityAvailable===true&&String(b.sellToken).toLowerCase()===sellToken&&String(b.buyToken).toLowerCase()===buyToken&&b.sellAmount===amount&&(uint(b.buyAmount)??0n)>0n&&(!firm||((uint(b.minBuyAmount)??0n)>0n&&uint(b.minBuyAmount)!<=uint(b.buyAmount)!));
  return {url,...r,valid};
 };
 const entry=await quote(USDC,token,position.atomic);
 const reverse=entry.valid?await quote(token,USDC,String(entry.body.minBuyAmount)):null;
 const conversion=entry.valid&&reverse?.valid?await quote(WETH,USDC,"1000000000000000000",false):null;
 if(entry.valid&&reverse?.valid&&(!(uint(entry.body.blockNumber)!==null&&uint(reverse.body.blockNumber)!==null)||uint(reverse.body.blockNumber)!<uint(entry.body.blockNumber)!))gaps.push("Quote block order unavailable or backwards");
 const rate=conversion?.valid?uint(conversion.body.buyAmount):null;
 const [chain,approvalGasPriceResult,nativeBalanceResult]=await Promise.all([rpc("eth_chainId",[]),rpc("eth_gasPrice",[]),rpc("eth_getBalance",[taker,"latest"])]);if(chain!=="0x2105")gaps.push("Base chain could not be verified");
 // Calculate a documented Base L1 upper bound in addition to L2 execution gas.
 // Fixed ABI selector derived offline; no web3_sha3 RPC dependency.
 const selector="0xf1c7a58b";
 const maximumTxBytes=Math.max(580,...[entry,reverse].map(q=>{const data=obj(q?.body.transaction).data;return typeof data==="string"?Math.ceil((data.length-2)/2)+512:580;}));
 const maximumQuotedGas=[entry,reverse].reduce((n,q)=>{const gas=uint(obj(q?.body.transaction).gas);return gas!==null&&gas>n?gas:n;},0n);
 let l1BoundPromise:Promise<unknown>|undefined,operatorBoundPromise:Promise<unknown>|undefined;let l1Bound:bigint|null=null,operatorBound:bigint|null=null;
 async function networkUpper(gas:bigint|null,gasPrice:bigint|null){
  if(gas===null||gasPrice===null||gas<=0n||gasPrice<=0n||!selector||chain!=="0x2105")return null;
  l1BoundPromise??=rpc("eth_call",[{to:ORACLE,data:selector+word(BigInt(maximumTxBytes))},"latest"]);
  const operatorGas=gas>maximumQuotedGas?gas:maximumQuotedGas;
  if(!operatorBoundPromise||gas>maximumQuotedGas)operatorBoundPromise=rpc("eth_call",[{to:ORACLE,data:"0x275aedd2"+word(operatorGas)},"latest"]);
  const [l1,operator]=await Promise.all([l1BoundPromise,operatorBoundPromise]);l1Bound=hexUint(l1);operatorBound=hexUint(operator);
  return l1Bound===null||operatorBound===null?null:gas*gasPrice+l1Bound+operatorBound;
 }
 let totalWei=0n,networkComplete=true;
 for(const [side,q,sellToken,amount] of [["entry",entry,USDC,position.atomic],["reverse",reverse,token,entry.valid?String(entry.body.minBuyAmount):"0"]] as const){
  const b=q?.body??{},issues=obj(b.issues),tx=obj(b.transaction);
  const allowanceKnown=Object.hasOwn(issues,"allowance"),balanceKnown=Object.hasOwn(issues,"balance");
  const approvalRequired=allowanceKnown?issues.allowance!==null:null;
  const balanceIssue=balanceKnown?issues.balance!==null:null;
  const simulationIncomplete=typeof issues.simulationIncomplete==="boolean"?issues.simulationIncomplete:null;
  let cost:bigint|null=null,approvalNetworkFee:bigint|null=null;
  const calldata=typeof tx.data==="string"&&/^0x(?:[0-9a-f]{2})*$/i.test(tx.data)?tx.data:null;
  if(q?.valid&&calldata&&address.test(String(tx.to))&&uint(tx.value)===0n){
   // 512 bytes conservatively covers unsigned transaction envelope/signature fields.
   cost=await networkUpper(uint(tx.gas),uint(tx.gasPrice));
   const reported=uint(b.totalNetworkFee);if(cost!==null&&reported!==null&&reported>cost)cost=reported;
  }
  if(cost===null){networkComplete=false;gaps.push(side+": network cost including L1/operator fees unresolved");}else totalWei+=cost;
  if(approvalRequired){
   walletIssues.push(side+": approval would be required before execution; none was performed");
   const spender=String(obj(issues.allowance).spender).toLowerCase();
   if(spender!==HOLDER){networkComplete=false;gaps.push(side+": unrecognized approval spender; no estimation attempted");}
   else{
    const approval={from:taker,to:sellToken,data:"0x095ea7b3"+spender.slice(2).padStart(64,"0")+word(BigInt(amount)),value:"0x0"};
    const gas=await rpc("eth_estimateGas",[approval,"latest",{[taker]:{balance:"0xde0b6b3a7640000"}}]),price=approvalGasPriceResult;
    const approvalCost=await networkUpper(hexUint(gas),hexUint(price));
    approvalNetworkFee=approvalCost;
    if(approvalCost===null){networkComplete=false;gaps.push(side+": required approval cost unresolved");}else totalWei+=approvalCost;
   }
  }else if(approvalRequired===null){networkComplete=false;gaps.push(side+": allowance status missing");}
  if(balanceIssue!==false)walletIssues.push(side+": wallet balance unavailable or insufficient; no funded-state simulation performed");
  if(simulationIncomplete!==false)gaps.push(side+": provider simulation incomplete or missing");
  if(!q?.valid)gaps.push(side+": valid matched quote unavailable");
  if(b.fees===undefined||obj(b.fees).gasFee!==null){networkComplete=false;gaps.push(side+": fee treatment unresolved; cannot rule out double counting");}
  legs.push({side,sourceUrl:q?.url??"https://api.0x.org/swap/allowance-holder/quote",fetchedAt:q?.fetchedAt??new Date().toISOString(),httpStatus:q?.httpStatus??null,sellAmount:amount,buyAmount:q?.valid?String(b.buyAmount):null,minimumBuyAmount:q?.valid?String(b.minBuyAmount):null,networkFeeWei:cost?.toString()??null,approvalNetworkFeeWei:approvalRequired?approvalNetworkFee?.toString()??null:approvalRequired===false?"0":null,approvalRequired,balanceIssue,simulationIncomplete,error:q?.error??(!q?.valid?"invalid_or_missing_quote":null)});
 }
 const nativeBalance=hexUint(nativeBalanceResult);
 if(nativeBalance===null||nativeBalance<totalWei)walletIssues.push("Native ETH balance unavailable or below estimated network cost");
 if(!rate)gaps.push("ETH network-fee conversion to USDC unavailable");
 const conversionAtomic=rate?(totalWei*rate+10n**18n-1n)/10n**18n:null;
 const knownCost=conversionAtomic===null||!networkComplete?null:Number(conversionAtomic)/1e6;
 const returned=reverse?.valid?Number(uint(reverse.body.minBuyAmount)!)/1e6:null;
 const estimate=returned!==null&&knownCost!==null?(Number(position.atomic)/1e6-returned+knownCost)/(Number(position.atomic)/1e6)*100:null;
 // Cost completeness and actual wallet readiness are separate; missing fee/simulation evidence still blocks a verdict.
 const complete=estimate!==null&&gaps.length===0;
 return costOutputSchema.parse({token,taker,chainId:8453,positionUsdc:position.usdc,checkedAt:new Date().toISOString(),status:complete?"estimate_available":"incomplete",executionVerified:false,holderConcentrationStatus:"not_assessed_by_this_tool",walletReady:walletIssues.length===0&&complete,walletIssues,approvalEstimationMode:"native_balance_override_read_only",slippageBpsPerLeg,l1FeeUpperBoundWeiPerTransaction:atomicText(l1Bound),operatorFeeUpperBoundWeiPerTransaction:atomicText(operatorBound),returnedUsdcBeforeNetworkFees:returned,knownNetworkCostUsdc:knownCost,estimatedTotalCostPct:estimate,withinCostLimit:complete?estimate!<=limit:null,costLimitPct:limit,legs,diagnostics:[...new Set(diagnostics)].slice(0,20),gaps:[...new Set(gaps)].slice(0,20),limitations:["Unsigned quote analysis only; transaction calldata is not returned for signing or submission.","Shared conservative L1 byte-size and operator gas upper bounds cover both swap payloads and approvals; L2 estimates are converted using a contemporaneous WETH/USDC indicative price. No fee is counted twice; provider swap fees remain in returned amounts.","Reverse input uses the entry minimum buy amount; returned USDC uses the reverse minimum buy amount. Entry/reverse quotes are sequential, not an atomic round trip or future exit guarantee. Per-leg slippage is an explicit input, default 25 bps. The conservative scenario estimate is not an execution guarantee.","Approval gas estimation uses a read-only native-ETH balance override. No token storage, allowances or blockchain state were changed. Provider quote gas is an estimate; execution is not verified.","Run inspect_base_holder_concentration separately for balances synchronized at one block; its ranking is scoped to provider candidates and does not establish all beneficial owners."],noPaymentOrTradeExecuted:true});
}