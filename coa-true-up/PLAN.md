# CoA Backfill — Engineering Plan (Standalone Project)

> **Audience:** the engineer building this. **Status:** ready to start.
> **Critical constraint:** this project is **decoupled from the in-flight Kondo branch** of the NCLims codebase. It reads from production read-only, talks to external services, writes its own bookkeeping. It does NOT modify NCLims source code, NCLims schema, or anything in the Kondo work-in-progress branch.

## 1. Context

North Coast Testing Laboratories (NCTL) operates a LIMS that generates Certificates of Analysis (CoAs) and pushes byte-identical copies to three destinations at issuance time:

1. **Confident Cannabis (CC)** — a third-party portal that customers see; today's authoritative archive
2. **Metrc** — the state regulator's tracking system
3. **Customer email** — automated send via the CS pipeline

CC is currently NCTL's de-facto "system of record" because it (a) preserves the as-issued PDF bytes, (b) holds the rare amendments that get made after a lab-error correction. Email-history search found exactly **one** amendment in NCTL history, so this is not a high-amendment-rate domain — but compliance still requires that *every* of-record CoA be retrievable from a system NCTL controls. Today, that's not true: a CC outage or contract dispute would leave NCTL without canonical bytes.

**The project:** pull every of-record CoA from CC into NCTL's own Azure Files share, with cryptographic integrity and per-file provenance, and keep that archive complete going forward.

**After this project ships, NCTL's internal LIMS becomes the system of record** for issued CoAs. Future amendments will be authored in LIMS and pushed to CC (separate initiative; see "Deferred" section).

## 2. Architecture overview

```
┌──────────────────────────────┐
│   YOUR STANDALONE PROJECT    │
│                              │
│   ┌────────────────────┐     │       Reads ConfidentCannabisId,
│   │ Sample enumerator  │─────┼─────► Sample.Id, LabId, LabSampleNr
│   │ (reads prod NCLims)│     │       from production NCLims DB
│   └────────────────────┘     │       (read-only connection string from KV)
│            │                 │
│            ▼                 │
│   ┌────────────────────┐     │       GET /v0/sample/{ccId}
│   │ Confident client   │─────┼─────► (HMAC-signed; per-lab credentials)
│   │ (HMAC + Polly)     │     │
│   └────────────────────┘     │
│            │                 │
│            ▼                 │
│   ┌────────────────────┐     │       Download Coa.Url bytes
│   │ Fetch + integrity  │     │       Compute SHA-256
│   │ (PDF + SHA-256)    │     │
│   └────────────────────┘     │
│            │                 │
│            ▼                 │
│   ┌────────────────────┐     │       PUT to nclimsfiles/production/
│   │ Upload to Azure    │─────┼─────► <labSlug>/Sample Reports/<GUID>.pdf
│   │ Files share        │     │       (the same share NCLims uses today)
│   └────────────────────┘     │
│            │                 │
│            ▼                 │
│   ┌────────────────────┐     │       Tracks: SampleId, CcSampleId,
│   │ Backfill ledger    │     │       CcCoaPublicKey, Sha256, FilePath,
│   │ (new isolated DB)  │     │       Status, Outcome — your DB, not theirs
│   └────────────────────┘     │
│                              │
└──────────────────────────────┘
```

**What's load-bearing:**

- The reconciliation primitive is **Confident's per-CoA-file identifier** (`CcFile.public_key`, a Guid in CC's API response). **Not** SHA-256 byte comparison — that would false-positive on rendering drift, embedded PDF timestamps, font changes, QR-URL refreshes, and any server-side processing CC does on upload.
- **SHA-256 still gets stored** on every imported file, but as **post-import integrity proof** (tamper-evidence for auditors), not as a comparison key.
- The ledger lives in **your own database**, separate from production NCLims. Add a new Azure SQL DB, or use SQLite, or use a separate schema in a side database — your call. **Don't touch the production NCLims schema.**
- The Azure Files share `nclimsfiles/production/<labSlug>/Sample Reports/` already exists and is where NCLims writes its own CoAs today. Backfilled files go to the same path (new GUIDs, no collision).

## 3. Reconciliation primitive — why not hashing

A natural instinct is "hash CC's bytes, hash our bytes, mark differences." Don't do this as the primary mechanism. Concrete failure modes:

1. **PDF metadata drift.** PDFs embed a `CreationDate` byte sequence; two renderings of the same content produce different hashes.
2. **Font/library drift.** Renderer or font versions change over years; output bytes shift.
3. **QR-URL drift.** NCLims embeds a QR code resolving to a public CC URL. The URL string itself can change without the underlying CoA changing.
4. **Server-side processing.** If CC re-renders, watermarks, or compresses on ingest, the bytes you upload aren't the bytes you'd get back via the API.
5. **The actual question isn't "do bytes match."** It's "is CC's of-record copy the one we have." That's identity, not content equality.

**The right primitive:** every CoA file on CC has a `public_key` Guid (in `CcFile`). It changes when CC stores new bytes; it doesn't change on cosmetic re-renders. Compare that.

**SHA-256 earns its slot** as integrity proof after import: "the file we wrote to Azure Files on date X hashed to Y; if it ever hashes differently again, something tampered with it." Auditor-friendly.

## 4. Backfill orchestration

Iteration is **local-sample-first**: walk NCTL's sample list and ask CC for each. The opposite direction (enumerate CC, match to NCTL) doesn't have a clean enumeration endpoint and isn't what we need.

### Sample population

```sql
-- Read-only against production NCLims via NCLimsConnection-Prod-ReadOnly
SELECT s.Id, s.LabSampleNr, s.LabId, s.ConfidentCannabisId
FROM   dbo.Sample s
WHERE  s.ConfidentCannabisId IS NOT NULL
  AND  s.LabId IN (1001, 1003)        -- 1001 = NCTL Ohio, 1003 = NCTLM Michigan
  AND  s.Deleted = 0
  AND  NOT EXISTS (
       SELECT 1 FROM <your-ledger-db>.dbo.CoaBackfillItem i
       WHERE i.SampleId = s.Id
         AND i.Outcome IN ('Imported', 'AlreadyHadIt')
  );
```

The `NOT EXISTS` clause is what makes the run resumable: anything already processed gets skipped naturally on restart.

### Per-sample workflow

For each sample row:

1. **Call CC**: `GET /v0/sample/{ccSampleId}`. HMAC-signed; see `CC_API_REFERENCE.md` for the signing protocol.
2. **Branch on the response**:
   - `has_coa = false` → no CoA in CC. Record `Outcome=NoCoaInCc`. These are side-channel candidates (Excel/PDF emailed off-pipeline) and will be reviewed by CS later. Don't try to invent a CoA.
   - `coa != null` → proceed.
3. **Download bytes**: HTTP GET on `coa.url`. Stream to memory or a temp file.
4. **Compute SHA-256** on the bytes.
5. **Idempotency check** (defends against double-runs): look up your ledger for an existing row with the same `(SampleId, Sha256)`. If found → `Outcome=AlreadyHadIt`, move on.
6. **Upload to Azure Files**: target path `nclimsfiles/production/<labSlug>/Sample Reports/<NewGuid>.pdf` where `<labSlug>` is `NCTL` for LabId=1001, `NCTLM` for LabId=1003. Mint a new GUID per file. **Never overwrite an existing file.**
7. **Write ledger row** with all provenance: `SampleId`, `CcSampleId`, `CcCoaPublicKey` (from `coa.public_key`), `CcCoaUrl`, `CcPublicUrl` (sample-page URL), `CcLastModifiedUtc` (from `last_modified`), `Sha256`, `ByteLength`, `OriginalFileName`, `AzureFolderPath`, `AzureFileName`, `Outcome=Imported`, `ImportedOnUtc`.
8. **Handle `coa_additions`** (a `List<CcFile>` on the CC response): for each additional file, repeat steps 3–7 with `Outcome=NeedsHumanReview` — we don't yet know empirically whether these are amendment history or supplemental docs (method addendums, accreditation letters, etc.). Save the bytes, flag for triage.
9. **Commit ledger row** before moving to the next sample. Per-sample commits = restart-safe.

### Concurrency, rate limits, retries

- **Single-threaded with a rate-limiting semaphore** (Polly's `RateLimiterAsyncPolicy` or a manual `SemaphoreSlim` + `Stopwatch`). Default target: **0.5 requests/second sustained** for a ~5–7 day total run on ~200k samples. (Math: 200k samples × ~2 network ops each = ~400k ops; at 0.5/sec → ~9 days for ops alone, less if some samples have no CoA.) **See decisions page for the chosen pace.**
- **Polly retry policy** for transient failures: `HttpRequestException`, `HttpStatusCode.RequestTimeout`, 429 (Too Many Requests), 5xx. Exponential backoff with jitter; cap at ~5 retries; respect `Retry-After` if present.
- **No parallel workers in v1.** A single steady stream against CC is gentle on their infra and avoids ledger contention. If a future iteration needs more throughput, partition by LabId (NCTL and NCTLM on separate processes hitting separate API keys).

### CC API quirks to know

The existing NCLims `CcApiService.cs` has a few latent issues. **Don't replicate them** in your standalone client:

- **No retry/backoff logic** (`CcApiService.cs:557` has a literal `// Implement retries?` comment). Build Polly in from day one.
- **`Orders.modifiedSinceTime` parameter is not serialized correctly** into the outgoing request. If you need date-range filtering on Orders for the optional orphan crawl, fix the form-encoding (look at the form-data construction around line 434).
- **`Sample.ResultsSentToConfidentCannabis` flag** flips to `true` after test-results upload, *before* the CoA upload. It does NOT prove CC has the PDF. Don't trust it as a "CC has the file" signal — query CC directly.

Lift the HMAC signing pattern from `CcApiService.cs` (around line 1243 onward, plus `CcRequest.cs`). It's correct. See `CC_API_REFERENCE.md` for the protocol summary.

## 5. Going-forward incremental sync (no NCLims code changes)

Once the backfill completes, you need to keep the ledger current as NCLims issues new CoAs. The original Kondo plan called for a code change inside `ReportingService.ReportOnSample` to write a ledger row on each issuance — but for a standalone, KONDO-decoupled project, **that change isn't needed**.

Instead: run an **incremental scanner** on a schedule. It reads from production NCLims (still read-only):

```sql
-- Find newly-issued CoAs since last scan
SELECT rf.Id, rf.SampleId, rf.FiledOn, fs.NewFileName, fs.FolderPath,
       fs.FileName AS OriginalName, s.LabSampleNr, s.LabId,
       s.ConfidentCannabisId
FROM   dbo.ReportFile rf
JOIN   dbo.FileStorage fs ON fs.ReportFileId = rf.Id
JOIN   dbo.Sample s ON s.Id = rf.SampleId
WHERE  rf.ReportType = 2                  -- CoA
  AND  rf.Deleted = 0
  AND  fs.Deleted = 0
  AND  rf.FiledOn > @lastScanWatermarkUtc
  AND  s.LabId IN (1001, 1003)
ORDER  BY rf.FiledOn;
```

For each row: download the bytes (Azure Files via the stored `FolderPath` + `NewFileName`), compute SHA-256, write a ledger row with `SourceSystem=LimsIssued`, `Outcome=Imported`. Don't re-pull from CC — at issuance time, LIMS bytes are byte-identical to CC's copy (the upload to CC happens in the same code path), so trusting LIMS bytes is correct AND avoids unnecessary CC API calls.

**Cadence:** hourly or every 4 hours, your call. Run it as an Azure Function or WebJob with a CRON trigger. Update `@lastScanWatermarkUtc` only after the batch successfully commits.

**Optional safety net:** weekly, sample ~1% of recent backfilled rows and re-fetch their CC `coa.public_key`. If any drifted from what's in your ledger, flag for review. Detects CC-side amendments made manually in their UI (which still happens until NCTL's amendment UX ships).

This pattern keeps Pearson's microbials release entirely untouched. **No edits to NCLims source code.**

## 6. Ledger schema (your DB, not production NCLims)

Recommended: a separate Azure SQL DB (cheap, integrated with the rest of NCTL's Azure footprint). SQLite works too if you're running this from a single host.

### `CoaBackfillRun`

| Column | Type | Notes |
|---|---|---|
| Id | int identity PK | |
| StartedOnUtc | datetime2 NOT NULL | |
| CompletedOnUtc | datetime2 NULL | NULL while running |
| TriggeredByUserId | nvarchar(100) NULL | |
| LabId | int NULL | NULL = both labs |
| TotalCandidates | int NULL | filled after enumeration |
| SuccessCount | int NOT NULL default 0 | |
| FailureCount | int NOT NULL default 0 | |
| SkippedCount | int NOT NULL default 0 | |
| Notes | nvarchar(max) NULL | |

### `CoaBackfillItem` (one row per attempt, immutable)

| Column | Type | Notes |
|---|---|---|
| Id | int identity PK | |
| RunId | int FK → CoaBackfillRun | |
| SampleId | int NOT NULL | from production NCLims |
| LabSampleNr | int NOT NULL | denormalized for grep-ability |
| LabId | int NOT NULL | |
| CcSampleId | nvarchar(50) NULL | e.g. `2604NCTL1753.14775` |
| CcCoaPublicKey | uniqueidentifier NULL | the comparison key |
| CcCoaUrl | nvarchar(500) NULL | |
| CcPublicUrl | nvarchar(500) NULL | sample-page URL |
| CcLastModifiedUtc | datetime2 NULL | |
| Status | nvarchar(20) NOT NULL | Pending / Fetched / Saved / Skipped / Failed |
| Outcome | nvarchar(30) NULL | Imported / AlreadyHadIt / NoCoaInCc / NeedsHumanReview / OrphanInCc / FetchFailed |
| SourceSystem | nvarchar(30) NOT NULL | ConfidentCannabisBackfill / LimsIssued / SideChannel |
| Sha256 | char(64) NULL | hex |
| ByteLength | bigint NULL | |
| OriginalFileName | nvarchar(500) NULL | from `FileStorage.FileName` if available |
| AzureFolderPath | nvarchar(500) NULL | e.g. `NCTL/Sample Reports` |
| AzureFileName | nvarchar(500) NULL | new GUID |
| AttemptCount | int NOT NULL default 1 | |
| LastAttemptOnUtc | datetime2 NOT NULL | |
| ErrorMessage | nvarchar(max) NULL | |

Indexes:
- `IX_Item_SampleId` on `SampleId` — for the NOT EXISTS resumability check
- `IX_Item_RunId` on `RunId`
- `IX_Item_Outcome` on `Outcome` — for triage queries

Append-only by convention. If a sample needs a retry, insert a new row referencing the same RunId; don't UPDATE the old row.

## 7. Bulletproof invariants (auditor walk-through)

1. **Every imported file has a SHA-256** stored in the ledger. Tamper-evident.
2. **Append-only ledger.** Rows never get UPDATEd or DELETEd (except `CoaBackfillRun.CompletedOnUtc` at run close, and only that column).
3. **Provenance complete.** Every row records source system, source IDs, source URLs, byte length, timestamps. Auditor can answer "for sample X, what's the of-record CoA and where did it come from" with a single query.
4. **Replayable.** `CoaBackfillRun` + `CoaBackfillItem` reconstruct the entire backfill. "Here's the run that imported the historical corpus, here are the per-sample outcomes."
5. **No silent overwrite.** Files on Azure Files always use a fresh GUID. Existing files never get clobbered.
6. **Resumable.** Per-sample commits; restart picks up via the NOT EXISTS clause.

## 8. Verification

### Smoke test (first 10 samples)
- Pick 10 known-good samples from production where `ConfidentCannabisId IS NOT NULL` and `ReportFile` rows exist. **Sample 217848 (Klutch Cannabis, the known amendment)** is your gold case for testing `coa_additions` handling.
- Run the backfill scoped to those 10 samples. Confirm:
  - `CoaBackfillItem` row written per sample with sane `Outcome`.
  - Files appear on `nclimsfiles/production/NCTL/Sample Reports/` with new GUIDs (visible in Azure Portal → Storage Browser).
  - SHA-256 round-trip: download a file from the share, hash locally, confirm match against the ledger.
  - Sample 217848's `coa_additions` (if present in CC) get imported as `Outcome=NeedsHumanReview`.
  - Stop the job mid-run, restart → no duplicate inserts.

### 1,000-sample pilot
- Run against a 1,000-sample window. Validate rate limit holds (no 429s under 0.5 req/sec). Validate ledger throughput. Validate Azure Files capacity (~0.5–1.5 MiB per CoA × 1,000 = manageable).

### Full corpus
- Once smoke + pilot pass, kick the full run. Monitor:
  - `SELECT Status, COUNT(*) FROM CoaBackfillItem WHERE RunId = @latestRun GROUP BY Status;`
  - Failure rate < 1% expected. If higher, pause and triage `ErrorMessage` distribution.
- Closeout report when done: total imported, total `NoCoaInCc`, total `NeedsHumanReview`, total `Failed`.

### Going-forward sync verification
- Wait for a sample to be reported in NCLims after the incremental scanner is running.
- Confirm a `CoaBackfillItem` row gets created within the scanner's cadence window, with `SourceSystem=LimsIssued`.

## 9. Deferred / out of scope

The original Kondo-branch plan included **a LIMS-side "Amend CoA" UI** (Razor modal, canned amendment templates, a native red "REPORT AMENDED" banner stamped on the cover page like sample 217848 shows). That work touches reporter / cover-page renderer code, which would collide with Pearson's microbials release currently in flight. **It's deferred to a follow-up initiative** that NCTL will pick up after Pearson ships.

For the duration of this project: amendments continue to be authored manually in CC's UI by CS. The going-forward incremental scanner will pick those up only when LIMS *also* regenerates a CoA for the same sample — i.e., it won't catch CC-only amendments. The optional weekly safety-net pass (§5) can be turned on if catching these is important; otherwise they accumulate as drift until the amendment UX ships and natively records them.

## 10. Open discovery items (don't block on these — surface findings)

1. **What is `CcSample.CoaAdditions` actually?** Best test case: sample 217848 (the known historical amendment). Fetch its CC payload during the smoke test, look at what's in `coa_additions`. Likely candidates: amendment history (great — backfill captures it for free), supplemental documents (method addendums, accreditation letters — capture but don't promote to "CoA"), or something else entirely. Bring findings to Adam Scavone before deciding canonical treatment.

2. **CC rate-limit behavior under sustained load.** CC's published rate limits, if any, aren't documented in NCLims source. Run the 1,000-sample pilot and watch for 429 responses or `Retry-After` headers. Adjust the semaphore if needed. Worst case: drop to 0.25 req/sec and accept a ~3-week run.

3. **CC sandbox vs production.** `CcApiService.cs:81-82` has a commented-out sandbox URL (`sandbox-api.confidentcannabis.com`). Verify with Adam whether the sandbox tenant has historical data or is reset periodically; use sandbox for smoke testing if it has representative data, otherwise smoke against a small production slice.

## 11. Stack recommendation

- **.NET 8** console app or WebJob (matches NCTL's existing stack; HMAC + Polly + Azure SDKs are first-class).
- **Polly** for retry + rate-limiting.
- **Azure.Storage.Files.Shares** SDK for the share writes (same package NCLims uses today).
- **Dapper or EF Core** for the ledger DB (Dapper is fine; EF is overkill for 3 tables).
- **Azure Key Vault** SDK for reading `NCLimsConnection-Prod-ReadOnly` and CC credentials.
- Host on **Azure WebJob** or **Container App** with managed identity. Long-running, restartable, observable.
- **Application Insights** for telemetry (request counts, success rate, latency histograms).

You can run this from a developer laptop initially for smoke testing, then move to Azure for the full backfill (multi-day runs benefit from cloud uptime).

## 12. First-day checklist

- [ ] Get the access listed in `SETUP.md` (KV secret read, Azure Files RBAC, CC credentials).
- [ ] Read `HANDOFF.md` for context on prior decisions.
- [ ] Read `CC_API_REFERENCE.md` for the HMAC protocol and known endpoints.
- [ ] Scaffold the project: .NET 8 console app + Polly + Azure SDKs + your ledger DB schema.
- [ ] Implement the smoke test (10-sample scope) end-to-end. **Sample 217848 must be one of the 10.**
- [ ] Verify the SHA-256 round-trip and the resumability NOT-EXISTS join work.
- [ ] Report findings on `coa_additions` (open discovery item #1) before scaling up.

Welcome aboard.
