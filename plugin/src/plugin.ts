import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { x402OutputSchema, proposeX402 } from "./paybox.js";
import {inspectToken,researchOutputSchema,verifySample,verificationOutputSchema} from "./research.js";
import {positionPattern,briefMarkdown} from "./brief.js";
import {assessCost,costOutputSchema} from "./cost.js";
import {inspectHolders,holderOutputSchema} from "./holders.js";
const ADDRESS=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
serveStdio(() => {
 const server=new McpServer({name:"signalproof",version:"0.6.0"},{supportedProtocolVersions:["2026-07-28"]});
 server.registerTool("inspect_base_token",{
  title:"Inspect Base token evidence",
  description:"Review an exact Base token for a chosen positionUsdc (default 500; 1–10000 USDC, decimal string) and optional maxRoundTripDifferencePct. Returns a source-linked research brief with conflicts, unknowns and next checks. Preserves the 25/100/500 ladder, adds the chosen amount, and checks one deterministically selected claim per pool within a shared budget. maxTradeAgeMinutes defaults to 30; freshness policy and sample coverage are explicit. Use the brief as a research assessment; do not interpret it as safety, profit or execution approval. Paid Ethereum context is optional and cannot resolve token-specific gaps. No funded wallet needed.",
  inputSchema:z.object({token:ADDRESS,positionUsdc:z.string().regex(positionPattern).optional(),maxRoundTripDifferencePct:z.number().min(0).max(100).optional(),maxTradeAgeMinutes:z.number().min(1).max(1440).optional()}).strict(),outputSchema:researchOutputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
 },async({token,positionUsdc,maxRoundTripDifferencePct,maxTradeAgeMinutes})=>{
  const report=await inspectToken(token,fetch,8500,{positionUsdc,maxRoundTripDifferencePct,maxTradeAgeMinutes});
  return {content:[{type:"text",text:briefMarkdown(report)}],structuredContent:report};
 });
 server.registerTool("assess_base_execution_cost",{
  title:"Assess Base execution costs without trading",
  description:"Wallet-specific unsigned 0x entry/reverse quotes, exact matched quantity, provider balance/allowance/simulation issues, L2 execution fees, Base oracle L1 fee upper bounds and required approval estimates. Converts network fees to USDC and returns an all-in limit verdict only when every required check is available. Cost completeness is separate from wallet readiness. Approval estimates use read-only native-ETH balance overrides; no token storage changes, signatures, approvals or trades. Explicit slippageBpsPerLeg defaults to 25. Holder analysis is a separate tool.",
  inputSchema:z.object({token:ADDRESS,taker:ADDRESS,positionUsdc:z.string().regex(positionPattern).optional(),maxTotalCostPct:z.number().min(0).max(100).optional(),slippageBpsPerLeg:z.number().int().min(0).max(500).optional()}).strict(),outputSchema:costOutputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
 },async({token,taker,positionUsdc,maxTotalCostPct,slippageBpsPerLeg})=>{const report=await assessCost(token,taker,positionUsdc,maxTotalCostPct,fetch,8500,slippageBpsPerLeg);return {content:[{type:"text",text:JSON.stringify(report)}],structuredContent:report};});
 server.registerTool("inspect_base_holder_concentration",{
  title:"Synchronize Base holder concentration",
  description:"Fetch up to 80 public provider holder candidates, then independently read their balances, totalSupply and decimals at one fixed Base block and recheck its hash. Re-ranks that candidate set, reports covered supply, top-five/top-ten candidate shares and provider labels with sampled code checks. Does not independently certify the complete holder universe, global top ranking or beneficial ownership. No wallet, secrets or payment required.",
  inputSchema:z.object({token:ADDRESS}).strict(),outputSchema:holderOutputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
 },async({token})=>{const report=await inspectHolders(token);return {content:[{type:"text",text:JSON.stringify(report)}],structuredContent:report};});
 server.registerTool("verify_base_sample",{
  title:"Verify a sampled Base transaction",
  description:"Read-only independent check of one claimed transaction and token contract against Base RPC. Compares transaction hash, sender, block hash, receipt success and target-token Transfer logs. Optionally checks claimed sender's latest bytecode and activity at an expected pool address. Pool activity is separate from token verification; pool IDs and swap direction/amount remain unverified. Does not establish economic ownership, intent, pool amounts or all trades. No payment or wallet signature.",
  inputSchema:z.object({token:ADDRESS,transactionHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),expectedSender:ADDRESS.optional(),expectedPool:z.string().regex(/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).optional()}).strict(),
  outputSchema:verificationOutputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
 },async({token,transactionHash,expectedSender,expectedPool})=>{
  const report=await verifySample(token,transactionHash,expectedSender,fetch,7000,expectedPool);
  return {content:[{type:"text",text:JSON.stringify(report)}],structuredContent:report};
 });
 server.registerTool("propose_research_purchase",{
  title:"Propose optional Ethereum context purchase",
  description:"Optional unsigned proposal for one Messari Ethereum asset-details request. This is broad Ethereum context, not research on an arbitrary Base token. Base USDC only, maximum 0.10 USDC (100000 atomic units). PayBox validates the live price and obtains any required approval. Does not pay or trade locally. Poll the same request ID after approval; verify payment and delivery before retrying.",
  inputSchema:z.object({asset:z.literal("ethereum")}).strict(),outputSchema:x402OutputSchema,
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}
 },async()=>proposeX402({chain:"eip155:8453",url:"https://api.messari.io/metrics/v2/assets/details?assetIDs=ethereum",maxAmount:"100000"}));
 return server;
},{legacy:"reject"});
