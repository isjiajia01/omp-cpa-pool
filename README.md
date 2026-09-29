# omp-cpa-pool

Read-only Codex account-pool quota extension for [OMP](https://omp.sh). It shows aggregate weekly and five-hour availability in the statusline and provides `/quota`, `/quota refresh`, and `/quota debug`.

This repository publishes only the OMP **client**. It expects an independently hosted HTTPS endpoint with a scoped read token; it does not contain the server adapter, server configuration, or credentials.

## Install

```sh
git clone https://github.com/isjiajia01/omp-cpa-pool.git ~/Developer/omp-cpa-pool
omp plugin link ~/Developer/omp-cpa-pool
```

Set `CPA_POOL_URL` to your endpoint and `CPA_POOL_READ_TOKEN` to its scoped read token. Alternatively, on macOS store the token in Keychain as service `cpa_pool_read_token`. Do not commit it to this repository. The source defaults to the author's endpoint; it is not a public quota service. The endpoint must return the schema parsed by `parseSnapshot()` in `index.ts`.

The client refreshes on session start. `/quota` refreshes if its cached snapshot is older than 90 seconds; `/quota refresh` forces one request. There is no background client timer. Statusline rendering and key presses do not issue requests.

## Source and license

The first public commit preserves the previously used 90-second background timer for reference. This revision removes that timer while retaining startup and on-demand refresh. MIT licensed; see [LICENSE](LICENSE).
