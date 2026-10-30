# Loggie tokenomics

**At $4.99 a month, a student who records about 24 calls a month (five or six a week) costs about $1.91 to serve, a 62% gross margin. The margin stays above 60% up to about six recorded calls a week.**

Sources: Nebius Token Factory's published model catalog (checked live on 2026-10-30), and Loggie's own usage log, which records the tokens, cost and latency of every cloud request the app makes (`src/hikyaku/usage.js`). The log covers 16 days of daily use, 2026-10-14 to 2026-10-29, by one heavy user who is also a developer.

---

## 1. Prices on Nebius Token Factory

| Model | Used for | Input, $ per 1M tokens | Cached input | Output, $ per 1M tokens |
|---|---|---:|---:|---:|
| NVIDIA Nemotron 3 Super 120B-A12B | sorting, drafting, filing | 0.30 | 0.06 | 0.90 |
| NVIDIA Nemotron 3 Ultra 550B-A55B | call notes, quote check, name check | 1.00 | 0.12 | 3.00 |

The cost of one request is

```math
c = \frac{p_{\text{in}}\, t_{\text{in}} + p_{\text{out}}\, t_{\text{out}}}{10^{6}}
```

where $t_{\text{in}}$ and $t_{\text{out}}$ are the input and output tokens and $p$ the prices above. Loggie computes this for every request and stores it with the request's token counts.

Speech never reaches the cloud, so it costs nothing per call. NVIDIA Parakeet TDT 0.6B v3 and Nemotron 3.5 ASR Streaming 0.6B run on the Mac.

---

## 2. What each request costs, measured

Means over every uncached request in the 16 days. Latency is the median.

| Step | Model | Requests | Input tokens | Output tokens | Cost per request | Latency |
|---|---|---:|---:|---:|---:|---:|
| Sort a new email (triage) | Super | 469 | 421 | 54 | $0.00017 | 1.1 s |
| Sort a chat message | Super | 217 | 647 | 56 | $0.00024 | 1.2 s |
| Pick the next move on mail | Super | 73 | 1,619 | 218 | $0.00068 | 1.8 s |
| Rank workspaces | Super | 53 | 1,394 | 260 | $0.00065 | 2.1 s |
| Find and update workspaces | Super | 876 | 2,598 | 87 | $0.00086 | 1.1 s |
| File a call into its workspace | Super | 36 | 8,255 | 57 | $0.00253 | 1.6 s |
| Write call notes | Ultra | 14 | 8,551 | 1,489 | $0.01302 | 4.7 s |
| Check every note against the quote | Ultra | 34 | 8,925 | 2,719 | $0.01708 | 6.5 s |

Two things drive cost. Input-heavy, output-light requests (sorting) are nearly free, because input tokens are cheap. Long outputs on Ultra (notes and the quote check) are where the money goes.

Repeats cost nothing: every request runs at temperature 0 and its answer is cached on the Mac under a hash of the request, so asking the same thing twice is free. That happened 329 times in the 16 days.

---

## 3. A month for one student

The monthly inference cost is a fixed background cost plus a cost per recorded call:

```math
C_{\text{inference}} = 30\,b + R\,k
```

| Symbol | Meaning | Value | Source |
|---|---|---:|---|
| $b$ | background cost per day: sorting about 45 emails and chats, next moves, ranking, small tasks, ongoing workspace updates | $0.0235 | measured |
| $k$ | cost per recorded call: notes $0.0130 + quote check $0.0171 + filing $0.0025 + name check $0.0009 | $0.0335 | measured |
| $R$ | recorded calls per month; about 5.5 a week | 24 | assumption |
| $s$ | web search (Tavily), about 50 searches at $0.008 | $0.40 | estimate |
| $P$ | price | $4.99 | plan |

So

```math
C_{\text{inference}} = 30(0.0235) + 24(0.0335) = 0.71 + 0.80 = \$1.51
```

```math
\text{margin} = \frac{P - C_{\text{inference}} - s}{P} = \frac{4.99 - 1.51 - 0.40}{4.99} \approx 62\%
```

| Line | Per month |
|---|---:|
| Background (sorting, next moves, ranking) | $0.71 |
| 24 recorded calls | $0.80 |
| Web search, estimated | $0.40 |
| **Cost to serve** | **$1.91** |
| Price | $4.99 |
| **Gross margin** | **$3.08, 62%** |

One-time workspace setup, run once when a user first connects their mail, cost $0.67 and is left out of the monthly figure.

---

## 4. How many calls the margin can carry

Keeping the margin at or above a target $m$ caps the recorded calls:

```math
R_{\max} = \frac{(1-m)\,P - s - 30\,b}{k}
```

| Target margin | Max recorded calls a month | About a week |
|---:|---:|---:|
| 60% | 26.6 | 6.1 |
| 62% | 23.6 | 5.4 |
| 50% | 41.5 | 9.6 |

Each extra recorded call costs about 3.4 cents, so a heavier user lowers the margin gradually: 10 calls a week still leaves about 49%.

---

## 5. What keeps it there

| Mechanism | Effect | Where |
|---|---|---|
| The right model per job | Sorting runs on Super at a fraction of a cent; only notes and checks use Ultra | `src/hikyaku/nebius.js` |
| On-device cache, temperature 0 | A repeated request costs $0 (329 in 16 days) | `src/hikyaku/nebius.js` |
| Daily spend limit | Background re-reads stop once the day's cost reaches the limit ($3 by default; a $4.99 plan would set it lower) | `cloudDailyLimitUsd` |
| Speech on the Mac | Transcription has no per-call cost | NVIDIA Parakeet, Nemotron ASR |

---

## 6. Limits of these numbers

- **One user.** The log is one heavy user who also built the app; a typical student's message volume and call count could differ either way. The model in section 3 states its assumptions so they can be changed.
- **Development activity removed.** The raw log totals $2.02 for the 16 days, $0.13 a day. That includes $0.67 of workspace setup re-run repeatedly during development and far more recorded calls than a student would make; sections 3 and 4 use per-request costs instead of the raw total.
- **Search is an estimate.** Tavily's cost here is assumed, not measured.
- **Prices can change.** They are Nebius's published prices as of 2026-10-30.
