# Changelog

## 1.0.0, 2025-09-15

Initial public release.

- Real-time trade ingestion via Solana `logsSubscribe` over Helius WebSocket
- Batched transaction parsing through Helius Enhanced Transactions API
- Automatic fallback to `getParsedTransaction` for non-Helius RPCs
- WebSocket bridge from server to browser
- HTML canvas visualization: buys and sells radiate from a center hub
- Live trade feed with wallet, amount, and Solscan link
- Running stats: buys, sells, buy volume, sell volume, net flow, average size
- Live buy-pressure gauge and 30-second rolling volume bars
- Click-to-copy token address
