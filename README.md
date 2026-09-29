# omp-cpa-pool

Read-only Codex account-pool quota extension for [OMP](https://omp.sh). It shows aggregate weekly and five-hour availability in the statusline and provides `/quota`, `/quota refresh`, and `/quota debug`.

This repository publishes only the OMP **client**. It expects an independently hosted HTTPS endpoint with a scoped read token; it does not contain the server adapter, server configuration, or credentials.

## Install

```sh
git clone https://github.com/isjiajia01/omp-cpa-pool.git ~/Developer/omp-cpa-pool
omp plugin link ~/Developer/omp-cpa-pool
```

Set `CPA_POOL_URL` to your endpoint and `CPA_POOL_READ_TOKEN` to its scoped read token. Alternatively, on macOS store the token in Keychain as service `cpa_pool_read_token`. Do not commit it to this repository. The source defaults to the author's endpoint; it is not a public quota service. The endpoint must return the schema parsed by `parseSnapshot()` in `index.ts`.

The initial published version refreshes on session start, every 90 seconds, and when `/quota` needs newer data. `/quota refresh` forces one request. Statusline rendering and key presses do not issue requests.

## Source and license

The published `index.ts` is a snapshot of the locally used version before removal of its 90-second client refresh. MIT licensed; see [LICENSE](LICENSE).
