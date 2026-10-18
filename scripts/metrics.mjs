export function atomicUsdc(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error("Invalid USDC amount");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
}
export function summarizeTrades(records) {
  const seen = new Set();
  const normalized = [];
  let rejected = 0;
  for (const record of records) {
    const a = record?.attributes;
    if (!record?.id || !a || !/^0x[0-9a-f]{40}$/i.test(a.tx_from_address ?? "")
      || !/^0x[0-9a-f]{64}$/i.test(a.tx_hash ?? "")
      || !["buy", "sell"].includes(a.kind) || !Number.isFinite(Date.parse(a.block_timestamp))
      || a.volume_in_usd === null || a.volume_in_usd === "" || a.volume_in_usd === undefined
      || !Number.isFinite(Number(a.volume_in_usd)) || Number(a.volume_in_usd) < 0) {
      rejected++; continue;
    }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    normalized.push({ id: record.id, address: a.tx_from_address.toLowerCase(), kind: a.kind,
      volumeUsd: Number(a.volume_in_usd), timestamp: a.block_timestamp, txHash: a.tx_hash });
  }
  const buyers = new Map();
  let buyVolumeUsd = 0, sellVolumeUsd = 0;
  for (const t of normalized) {
    if (t.kind === "buy") { buyVolumeUsd += t.volumeUsd; buyers.set(t.address, (buyers.get(t.address) ?? 0) + t.volumeUsd); }
    else sellVolumeUsd += t.volumeUsd;
  }
  const largest = [...buyers].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const dates = normalized.map(t => t.timestamp).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { validTradeCount: normalized.length, rejectedRecordCount: rejected,
    uniqueSenderAddresses: new Set(normalized.map(t => t.address)).size,
    uniqueBuyerAddresses: buyers.size, observedBuyVolumeUsd: buyVolumeUsd,
    observedSellVolumeUsd: sellVolumeUsd,
    topFiveBuyerSharePct: buyVolumeUsd > 0 ? largest.reduce((s, v) => s + v[1], 0) / buyVolumeUsd * 100 : null,
    observedFrom: dates[0] ?? null, observedTo: dates.at(-1) ?? null,
    topBuyerAddresses: largest.map(([address, observedBuyVolumeUsd]) => ({address, observedBuyVolumeUsd})),
    verificationTransactions: normalized.slice(0, 3).map(t => ({hash:t.txHash, url:"https://basescan.org/tx/" + t.txHash})),
    limitations: ["One pool; at most 300 recent trades, not complete 24-hour activity.",
      "Sender addresses may be routers or smart accounts; addresses are not people.",
      "Observed buy/sell activity does not establish holdings, common ownership, or manipulation."] };
}
export function sizePenaltyPct(reference, current) {
  const rs = BigInt(reference.sellAmount), rb = BigInt(reference.buyAmount);
  const cs = BigInt(current.sellAmount), cb = BigInt(current.buyAmount);
  if ([rs, rb, cs, cb].some(x => x <= 0n)) throw new Error("Quote amounts must be positive");
  return Number((cs * rb - cb * rs) * 1000000n / (cb * rs)) / 10000;
}
