import test from "node:test";
import assert from "node:assert/strict";
import {assessCost} from "../src/cost.ts";
const weth="0x4200000000000000000000000000000000000006",usdc="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",wallet="0x1111111111111111111111111111111111111111";
function fixture(options={}){
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url,init});const u=new URL(url);
  if(u.hostname==='mainnet.base.org'){
   const {method,params}=JSON.parse(init.body);assert(['eth_chainId','web3_sha3','eth_call','eth_estimateGas','eth_gasPrice','eth_getBalance'].includes(method));
   const result=method==='eth_chainId'?'0x2105':method==='web3_sha3'?'0x'+'11'.repeat(32):method==='eth_getBalance'?'0xde0b6b3a7640000':method==='eth_call'?(params[0].data.startsWith('0x275aedd2')?(options.operatorMissing?null:options.operatorFee?'0xe8d4a51000':'0x0'):(options.l1Missing?null:'0xe8d4a51000')):method==='eth_estimateGas'?(options.approvalMissing?null:'0x186a0'):'0x989680';
   return Response.json({jsonrpc:'2.0',id:1,result});
  }
  assert.equal(u.hostname,'api.0x.org');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert(!('0x-api-key' in init.headers));
  const sell=u.searchParams.get('sellToken'),buy=u.searchParams.get('buyToken'),amount=u.searchParams.get('sellAmount');
  const conversion=u.pathname.endsWith('/price');
  const body={sellToken:sell,buyToken:buy,sellAmount:amount,buyAmount:conversion?'3000000000':sell===usdc?'200000000000000000':'499000000',liquidityAvailable:true,fees:{zeroExFee:{amount:'1',token:buy,type:'volume'},integratorFee:null,gasFee:null},totalNetworkFee:'2000000000000',transaction:{to:wallet,data:'0x1234',gas:'100000',gasPrice:'10000000',value:'0'},issues:{allowance:options.approvalMissing?{actual:'0',spender:'0x0000000000001ff3684f28c67538d4d072c22734'}:null,balance:options.noBalance?{actual:'0',expected:amount}:null,simulationIncomplete:!!options.simulationMissing}};
  body.minBuyAmount=options.missingMinimum?undefined:options.lowerMinimum&&!conversion?(sell===usdc?"190000000000000000":"494000000"):body.buyAmount;body.blockNumber="100";
  if(options.wrongReverse&&sell===weth&&!conversion)body.sellAmount='1';
  if(options.missingFee)body.totalNetworkFee=null;
  return Response.json(body);
 };
 return {fetcher,calls};
}
test('complete fee estimate includes both L2 and L1 without double counting provider swap fees',async()=>{
 const f=fixture();const r=await assessCost(weth,wallet,'500',2,f.fetcher);
 assert.equal(r.status,'estimate_available');assert.equal(r.knownNetworkCostUsdc,.012);assert.equal(r.withinCostLimit,true);assert.equal(r.returnedUsdcBeforeNetworkFees,499);assert.equal(r.executionVerified,false);assert.equal(r.holderConcentrationStatus,'not_assessed_by_this_tool');
 assert.equal(new URL(f.calls.filter(c=>c.url.includes('/quote'))[1].url).searchParams.get('sellAmount'),'200000000000000000');
 assert(!f.calls.some(c=>c.init.body&&JSON.parse(c.init.body).method==='web3_sha3'));assert(!JSON.stringify(r).includes('0x1234'));assert(f.calls.every(c=>!c.init.body||!JSON.parse(c.init.body).method.startsWith('eth_send')));
});
test('missing L1 fee never becomes zero or a passing total-cost verdict',async()=>{
 const f=fixture({l1Missing:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.status,'incomplete');assert.equal(r.knownNetworkCostUsdc,null);assert.equal(r.withinCostLimit,null);
});
test('unfunded wallet retains complete scenario estimate while execution readiness is false',async()=>{
 const f=fixture({noBalance:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.status,'estimate_available');assert.equal(r.withinCostLimit,true);assert.equal(r.walletReady,false);assert(r.walletIssues.some(s=>s.includes('balance')));
});
test('required but unestimated approvals block total-cost conclusions',async()=>{
 const f=fixture({approvalMissing:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.knownNetworkCostUsdc,null);assert.equal(r.withinCostLimit,null);assert(r.gaps.some(s=>s.includes('approval cost')));
});
test('wrong reverse amount is rejected and invalid input cannot access the network',async()=>{
 const f=fixture({wrongReverse:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.returnedUsdcBeforeNetworkFees,null);assert.equal(r.withinCostLimit,null);
 let calls=0;await assert.rejects(()=>assessCost(weth,'bad','500',2,async()=>{calls++;throw Error()}));assert.equal(calls,0);
});
test('noncooperative providers cannot escape the shared deadline',async()=>{
 const started=performance.now();const r=await assessCost(weth,wallet,'500',2,()=>new Promise(()=>{}),120);assert(performance.now()-started<700);assert.equal(r.withinCostLimit,null);
});
test('minimum entry output sizes the reverse and minimum reverse output drives total costs',async()=>{
 const f=fixture({lowerMinimum:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.returnedUsdcBeforeNetworkFees,494);assert.equal(new URL(f.calls.filter(c=>c.url.includes('/quote'))[1].url).searchParams.get('sellAmount'),'190000000000000000');assert(r.estimatedTotalCostPct>1.2);
});
test('missing minimum output cannot produce a complete executable-cost verdict',async()=>{
 const f=fixture({missingMinimum:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.returnedUsdcBeforeNetworkFees,null);assert.equal(r.withinCostLimit,null);
});
test('provider simulation gaps block cost completeness even when numerical fees are present',async()=>{const f=fixture({simulationMissing:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.status,'incomplete');assert.equal(r.withinCostLimit,null);});
test('read-only approval estimate declares native-only overrides and never mutates token storage',async()=>{
 const f=fixture({approvalMissing:true});await assessCost(weth,wallet,'500',2,f.fetcher);const requests=f.calls.filter(c=>c.init.body).map(c=>JSON.parse(c.init.body)).filter(c=>c.method==='eth_estimateGas');assert(requests.length>0);for(const r of requests){assert.deepEqual(r.params[2],{[wallet]:{balance:'0xde0b6b3a7640000'}});assert.equal(r.params[0].data.slice(0,10),'0x095ea7b3');}
});
test('operator fees are read from the chain and included without assuming they are zero',async()=>{const f=fixture({operatorFee:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.status,'estimate_available');assert.equal(r.operatorFeeUpperBoundWeiPerTransaction,'1000000000000');assert.equal(r.knownNetworkCostUsdc,.018);});
test('missing operator fee prevents a complete cost conclusion',async()=>{const f=fixture({operatorMissing:true});const r=await assessCost(weth,wallet,'500',2,f.fetcher);assert.equal(r.status,'incomplete');assert.equal(r.withinCostLimit,null);});
