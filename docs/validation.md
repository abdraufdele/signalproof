# Validation scope

Documented release: 0.6.0. Sources: local package/server version and saved release/status records, inspected 17 October 2026. Raw records are intentionally excluded from this repository.

| Check | Version / scope | Recorded outcome |
| --- | --- | --- |
| Source and evidence regressions | 0.6.0, local/offline | 49 + 18 = 67 passed in saved release |
| Starter conformance and deterministic builds | 0.6.0, local | Passed in saved release |
| Custom 250.123456-USDC hosted case | 0.4.1, historical | Four matched pairs; no price-pair errors; 249.355405 USDC indicative return before gas |
| Standalone receipt verification from that result | 0.4.1, historical | sample_verified; swap direction/amount not verified |
| Core, cost and holder hosted checks | 0.6.0, developer portal | Passed in saved records |
| Three installed-agent research calls | 0.6.0 candidate; deployed identity unattested by MCP | All three returned successfully |
| Actual payment or trade | Not performed | No payment/execution proof claimed |
| Genuine participant feedback | Not collected | Zero participants |

The installed-agent run reported approximately 0.8031774% total scenario cost for 500 USDC, walletReady=false, and 80 rebalanced holder candidates covering 74.8104% of supply. These dated observations are not thresholds or promises.

Open checks: approximately 90-second response-time lag versus local receipt; delivery-time collection freshness remains unverified. Discovery installation ID differed from the portal project ID; that can be a separate identifier but an authoritative deployment mapping/hash attestation was not returned. Neither caveat should be represented as resolved.

Tests use synthetic cases and public provider/onchain snapshots. Snapshots are only regression inputs. No account-specific hosted capture, owner wallet address, approval record, token or secret is intentionally included.
