# Confident Cannabis API — Reference for the Backfill Project

> Lifted from NCTL's existing `CcApiService.cs` implementation. This document captures **the protocol you need**, **the endpoints you'll use**, **and the bugs in the existing code you should NOT replicate**.

## Base URL

```
Production:  https://api.confidentcannabis.com
Sandbox:     https://sandbox-api.confidentcannabis.com   (commented out in CcApiService.cs:81)
API version: v0 (path prefix /v0)
```

Verify with Adam whether the sandbox tenant has representative historical data — if yes, do smoke testing there; if not, use a tight production slice.

## Authentication — HMAC-SHA256 signed requests

Every request needs three headers:

```
X-ConfidentCannabis-APIKey:     <Lab.CcApiKey as Guid string>
X-ConfidentCannabis-Timestamp:  <UTC ISO-8601 — see exact format below>
X-ConfidentCannabis-Signature:  <base64 HMAC-SHA256 of canonical string>
```

### Canonical string to sign

Per the existing `CcApiService.cs:1243` implementation, the canonical string is composed in this order (joined by `\n`):

```
{HTTP_METHOD}\n
{PATH_WITH_QUERY}\n
{HEADERS_TO_SIGN}\n
{BODY_HASH_BASE64}
```

Where:

- **`HTTP_METHOD`** — uppercase: `GET`, `POST`, etc.
- **`PATH_WITH_QUERY`** — the request path including `/v0/` prefix and any query string (e.g., `/v0/sample/12345.1`). Do NOT include the host. Do NOT include the fragment.
- **`HEADERS_TO_SIGN`** — comma-separated list of header name+value pairs that are part of the signature. For NCLims's implementation, the only header included is `x-confidentcannabis-timestamp={iso_timestamp}` (lowercase header name).
- **`BODY_HASH_BASE64`** — for GETs without a body, this is the base64-encoded SHA-256 of an empty string (`47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=` URL-safe, or `47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=` standard base64). For POSTs with form data, hash the URL-encoded form body.

### Timestamp format

```
yyyy-MM-ddTHH:mm:ssZ   (e.g., 2026-05-12T19:30:45Z)
```

UTC, second precision. Requests with timestamps more than ~5 minutes off CC's clock get rejected. Use `DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")` or equivalent.

### Signing process (pseudocode)

```csharp
var timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
var bodyHash = Convert.ToBase64String(SHA256.HashData(bodyBytes ?? Array.Empty<byte>()));
var headersToSign = $"x-confidentcannabis-timestamp={timestamp}";

var canonical = string.Join("\n", new[] {
    httpMethod.ToUpperInvariant(),
    pathWithQuery,
    headersToSign,
    bodyHash
});

using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secretKey));
var sig = Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical)));

request.Headers.Add("X-ConfidentCannabis-APIKey", apiKey);
request.Headers.Add("X-ConfidentCannabis-Timestamp", timestamp);
request.Headers.Add("X-ConfidentCannabis-Signature", sig);
```

**Verify against the existing implementation** at `NCLims.ConfidentCannabisApi/CcApiService.cs` (look at `SignRequest` and the helper methods around it) before going to prod with your own implementation. CC's docs are reportedly accurate; the NCLims code is a working reference.

### Per-lab credentials

CC has separate credentials per NCTL lab:

```sql
SELECT Id, Slug, CcApiKey, CcSecretKey FROM dbo.Lab WHERE Id IN (1001, 1003);
```

- **LabId 1001 (NCTL, Ohio)** — has its own ApiKey + SecretKey
- **LabId 1003 (NCTLM, Michigan)** — has its own ApiKey + SecretKey

Use the right pair based on which sample you're querying. `Sample.LabId` tells you which.

`CcSecretKey` is encrypted in the DB. Adam will share the decrypted form out-of-band, or mint fresh credentials specifically for your project. Don't try to reverse the encryption from the DB row alone.

## Endpoints you will use

### `GET /v0/sample/{sampleId}` — primary backfill endpoint

This is your workhorse. Returns the full sample record including CoA file references.

**Path param:** `sampleId` = CC's sample identifier (NCLims stores this as `Sample.ConfidentCannabisId`, e.g. `2604NCTL1753.14775`).

**Response:** JSON `CcSample` (see `NCLims.ConfidentCannabisApi/CcSample.cs` for the full schema). Fields you care about:

```json
{
  "id": "2604NCTL1753.14775",
  "lims_id": "217848",
  "has_coa": true,
  "has_coa_draft": false,
  "coa": {
    "filename": "217848_Klutch_Cannabis_20260506.pdf",
    "public_key": "abc123...",
    "url": "https://..."
  },
  "coa_additions": [
    { "filename": "...", "public_key": "...", "url": "..." }
  ],
  "public_url": "https://confidentcannabis.com/sample/...",
  "last_modified": "2026-05-06T15:11:06Z",
  "manifest_id": "1A40703000023F2000119043",
  "regulator_sample_id": "...",
  "order_id": "..."
}
```

**Behavior notes:**
- `coa` is `null` when `has_coa = false`.
- `coa.url` is a time-limited download URL — fetch the bytes within minutes of getting it; don't store the URL and assume it works later.
- `coa.public_key` is your **reconciliation key**. Persist it.
- `coa_additions` is sometimes empty, sometimes populated. Semantics unknown until verified — see sample 217848 test.

### `GET /v0/orders` — for the optional orphan crawl

Paginated list of CC orders. Useful only if you want to find CC samples that have no matching NCLims sample (data-entry mismatches, side-channel-only work).

**Query params:**
- `start` (int, default 0)
- `limit` (int, default 100)
- `status_id` (int, optional)
- `modified_since_time` (datetime, optional) — **the NCLims client has a bug here**, see below
- `client_id` (int, optional)

**Don't rely on it for the primary backfill** — go local-sample-first.

### `GET /v0/lab` — sanity check

Returns metadata about the current lab (the one whose API key you authenticated with). Good first call to verify your HMAC signing works before doing anything destructive.

### `POST /v0/sample/{sampleId}/coa` — for future amendment push (NOT this project)

Uploads a CoA PDF as multipart/form-data. The deferred amendment UX will use this. **You don't need this endpoint for the backfill.** Documented here only so you don't accidentally implement it now.

## Known bugs in NCLims's existing `CcApiService.cs` — DON'T replicate

The existing client has been in production but has rough edges. For a standalone backfill project, do it right from day one:

### 1. No retries / no backoff

`CcApiService.cs:557` literally has `// Implement retries?` as an unanswered comment. The existing client throws on transient errors. **Build Polly in from day one**:

```csharp
var retryPolicy = Policy
    .Handle<HttpRequestException>()
    .OrResult<HttpResponseMessage>(r =>
        (int)r.StatusCode >= 500 ||
        r.StatusCode == HttpStatusCode.RequestTimeout ||
        r.StatusCode == HttpStatusCode.TooManyRequests)
    .WaitAndRetryAsync(
        retryCount: 5,
        sleepDurationProvider: (attempt, response, _) =>
        {
            // Respect Retry-After when present
            if (response?.Result?.Headers?.RetryAfter?.Delta is TimeSpan ra)
                return ra;
            // Else exponential with jitter
            return TimeSpan.FromSeconds(Math.Pow(2, attempt)) +
                   TimeSpan.FromMilliseconds(Random.Shared.Next(0, 500));
        },
        onRetryAsync: (outcome, delay, attempt, ctx) =>
        {
            // log it
            return Task.CompletedTask;
        });
```

### 2. `Orders.modifiedSinceTime` parameter doesn't serialize correctly

In `CcApiService.cs` around line 434, the `modifiedSinceTime` value is constructed but not included in the outgoing form body / query string correctly. If you use the `Orders` endpoint with a date filter (optional orphan crawl), fix the parameter encoding.

Same bug affects `Clients(modifiedSinceTime: ...)` around line 207.

### 3. `Sample.ResultsSentToConfidentCannabis` flag is misleading

In `CcApiService.cs:743-777` (`SampleTestResults`), the flag flips to `true` when the test results upload succeeds — which happens **before** the CoA PDF upload (lines 900-934). So `ResultsSentToConfidentCannabis = true` does NOT mean CC has the PDF. It only means CC has the lab data.

**For your backfill:** ignore this flag. Query CC directly via `GET /v0/sample/{ccId}` and check `has_coa` + `coa` to determine actual state.

### 4. `SendSampleToCc` picks any PDF report, not just CoAs

In `CcApiService.cs:925-926`, the file selection is `FileName.ToLower().Contains(".pdf")` without filtering on `ReportType=2` (CoA). If non-CoA PDF reports ever get attached to a sample, the wrong file is selected.

**For your backfill:** you're reading from CC, not pushing, so this bug doesn't bite you directly. But if you reference this code, don't copy the file-selection logic.

## Rate limiting strategy

CC's published rate limits aren't documented in NCLims source. Empirical strategy:

- **Start with 0.5 requests/second sustained** (one request every 2 seconds). At 200k samples × 2 ops each = 400k requests, that's ~9 days of pure API time. Real-world wall-clock will be longer due to processing, retries.
- **Monitor for 429s** during your 1,000-sample pilot. If you see them, slow down to 0.25 req/sec.
- **Respect `Retry-After` headers** when CC sends them.
- **Single-threaded for v1** — no parallel workers. Avoids ledger contention and is gentler on CC.

If you need higher throughput, partition by lab (NCTL on one process with one API key, NCTLM on another) — that gives you effectively 2x without changing the per-API-key rate.

## Error handling notes

- **HTTP 401** — your HMAC signature is wrong, or your API key is wrong, or your timestamp is too skewed from CC's clock. Verify the canonical-string construction against the working NCLims code.
- **HTTP 404** — the `ConfidentCannabisId` you queried doesn't exist in CC. Could be: data-entry error in NCLims, sample never actually got pushed to CC, or CC deleted it. Record `Outcome=FetchFailed, ErrorMessage="404 from CC"` and move on. Don't retry 404s.
- **HTTP 429** — rate-limited. Polly handles this with the retry policy above.
- **HTTP 500/502/503/504** — CC server error. Retry with exponential backoff. If persistent over multiple retries, record `Outcome=FetchFailed`, surface in the closeout report.

## Useful files to reference in NCLims source

If you can read `https://github.com/<the-NCLims-repo>` or get a snapshot from Adam:

- `NCLims.ConfidentCannabisApi/CcApiService.cs` — the existing client. Read the HMAC signing, ignore the bugs called out above.
- `NCLims.ConfidentCannabisApi/CcSample.cs` — full JSON schema for the sample response. Helpful when deserializing.
- `NCLims.ConfidentCannabisApi/CcFile.cs` — schema for the `coa` and `coa_additions` entries. Three fields: `filename`, `public_key` (Guid), `url`.
- `NCLims.ConfidentCannabisApi/CcRequest.cs` — request construction + signing helpers.

You can either lift these into your project (and clean up the bugs) or rewrite from scratch using this doc as the protocol spec. Either approach is fine — the protocol is correct, the code has known gaps.

## Bytes you'll be storing

CoAs are PDFs, typically 0.5–1.5 MiB each. Multi-MiB outliers exist (longer reports, more analytes). At ~200k samples × ~1 MiB average ≈ 200 GiB of new bytes landing on the share. The share is currently using 504 GiB out of a 100 TiB max — there's plenty of headroom.

`coa_additions` files (when present) are usually smaller (a few hundred KB) but vary widely.
