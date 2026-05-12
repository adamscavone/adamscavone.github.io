# How CoA Storage Works Today — A Guided Tour

> **For:** David Kohn. **Purpose:** before you build the backfill, you need to understand how NCTL's existing LIMS stores CoAs and how to navigate that storage via the Azure Portal. This is the same orientation Adam went through to get comfortable with the system before handing the project off.
>
> **Not an audit task.** Don't worry about correctness or finding issues. The goal is "walk this path once, end-to-end, so you've seen every layer." Total time: ~30 minutes.

## The data model in one diagram

```
Sample (production NCLims DB)
  Id, LabSampleNr, LabId, ConfidentCannabisId, ...
        │
        │   1:N
        ▼
ReportFile
  Id, SampleId, ReportType, FileName (original human-readable),
  FiledOn, CreatedOn, ...
        │
        │   1:1
        ▼
FileStorage
  Id, ReportFileId, FolderPath, NewFileName (GUID), 
  FileName (original), FileCreatedOn, ...
        │
        │   resolves to
        ▼
Azure Files share:
  nclimsfiles / production / <FolderPath> / <NewFileName>
  e.g., NCTL/Sample Reports/954bab91-b409-41bf-bf28-813aea538318.pdf
```

The **same file** has a database-visible identity (`ReportFile` + `FileStorage` rows, both joined to a `Sample`) and a **physical-storage identity** (the bytes sitting on an Azure Files share with a GUID filename). The original human-readable filename (`142462_Curaleaf_20240826150542830.pdf`) is preserved on `FileStorage.FileName` — the GUID is just for storage uniqueness.

**Why GUIDs:** every regeneration produces a new file with a new GUID, so the old one is never overwritten. Multiple versions of a CoA accumulate naturally. (See "Version history" below for a live example.)

## Step 1 — find the storage account name (it's not in code)

The application reads two env vars at runtime: `FileShareConnectionString` (a Key Vault reference) and `FileShareName` (a plain App Service application setting). Neither is in the codebase — both live on the deployed App Service.

**To discover from the Portal:**

1. Portal → **App Services** → the **production** NCLims app (NOT `nclims-kondo-test` — that's the dev branch's deployment slot).
2. Left nav → **Settings → Environment variables** (older portal: **Configuration → Application settings**).
3. Look for `FileShareName`. Value will be `production`.
4. Look for `FileShareConnectionString`. Value will display as `@Microsoft.KeyVault(SecretUri=https://nclims-kv.vault.azure.net/secrets/FileShareConnectionString/...)`.

**To extract the storage account name without exposing the secret:**

1. Portal → **Key vaults** → `nclims-kv` → **Secrets** → `FileShareConnectionString` → current version → **Show Secret Value**.
2. The connection string contains `AccountName=<X>;AccountKey=<long-base64>;…`. The `<X>` is your storage account name. For NCTL, it's **`nclimsfiles`**.

You only need to do this once. After that, you can navigate directly to **Storage accounts → nclimsfiles** in the Portal.

## Step 2 — see the share structure

1. Portal → **Storage accounts** → `nclimsfiles`.
2. Left nav → **File shares** (NOT **Containers** — those are for Blob Storage, which NCTL doesn't use here. Common point of confusion).
3. You'll see two shares: `production` and `test`. Click `production`.

**What you'll see at the share's overview page:**
- **Used storage:** ~500 GiB (varies). This is the entire historical archive. It is NOT dormant despite some date fields suggesting otherwise.
- **"Configuration modified" date:** typically reads as 2021. **Ignore this** — it's the date the share's *settings* (quota, tier) were last changed, NOT the date files were last written.
- **"Last modified" under Backup → Snapshots:** also reads as 2021. That's the date of the lone snapshot taken in 2021. The share has never been re-snapshotted; this doesn't mean files aren't being written.
- **Soft delete: 7 days** — deleted files are recoverable for a week.
- **Redundancy: GRS (Geo-redundant)** — paired region South Central US.

To **verify the share is actively being written to** (and not actually dormant despite those 2021 dates), use **Metrics** (Storage account → Monitoring → Metrics, scope to the `production` share, metric = `Transactions` or `Egress`). A daily heartbeat confirms it's live.

## Step 3 — drill into the folder layout

The Portal gives you two ways to browse:

### Option A — "Browse" blade (limited)

1. From the `production` share overview, left nav → **Browse**.
2. The root shows two directories: `NCTL` and `NCTLM`.
   - `NCTL` = Ohio lab (`Lab.Slug` for `LabId = 1001`)
   - `NCTLM` = Michigan lab (`Lab.Slug` for `LabId = 1003`)
3. Click `NCTL` → you'll see four subdirectories:
   - **`Manifest Reports/`** — manifest-level outputs (Consolidated CoAs, etc.)
   - **`Raw Data Files/`** — raw instrument files
   - **`Sample Images/`** — sample photos used on CoA cover pages
   - **`Sample Reports/`** — **this is where CoAs live**
4. Click `Sample Reports` → you'll see a flat list of GUID-named files: `00001648-9a6b-487e-….pdf`, `00001aa3-7cc2-….pdf`, etc.

**Limitations of the Browse blade:**
- Only shows columns Name / Type / Size. **No Last Modified column.**
- Headers are NOT sortable.
- Search by prefix works (type a GUID prefix in the search box).
- You can click an individual file → **Properties** to see Last Modified, ETag, Content-MD5.

### Option B — Storage browser (better)

1. Go back to the storage account `nclimsfiles` (don't go through the share).
2. Left nav → **Storage browser** (the file-tree icon).
3. Expand **File shares → production → NCTL → Sample Reports**.
4. Same file listing, but the right-pane **Edit columns** button gives you... still only Name / Type / Size for Azure Files. Microsoft hasn't exposed Last Modified as a sortable column for Azure Files even in Storage browser. (For Blob Storage, the column exists; for File shares, it doesn't.)

**Workaround for "what was last written":** the application's own database is the source of truth. The DB has `FileStorage.FileCreatedOn` (UTC datetime) — query it directly. The portal is for spot-checks, not bulk inventory.

## Step 4 — open a real CoA end-to-end

Pick a known sample to walk the chain:

```sql
-- Run against production via NCLimsConnection-Prod-ReadOnly
SELECT TOP 1
       s.LabSampleNr,
       l.Slug                AS Lab,
       fs.FolderPath,
       fs.NewFileName,
       fs.FileName           AS OriginalName,
       fs.FileCreatedOn      AS WrittenToShareUtc,
       rh.ReportedOn         AS GeneratedAtUtc,
       u.UserName            AS GeneratedBy
FROM   dbo.ReportFile rf
JOIN   dbo.FileStorage     fs ON fs.ReportFileId = rf.Id
JOIN   dbo.ReportHistory   rh ON rh.ReportFileId = rf.Id
JOIN   dbo.SampleAssay     sa ON sa.Id = rh.SampleAssayId
JOIN   dbo.Sample          s  ON s.Id  = sa.SampleId
JOIN   dbo.Lab             l  ON l.Id  = s.LabId
JOIN   dbo.AspNetUsers     u  ON u.Id  = rh.ApplicationUserId
WHERE  rf.ReportType = 2       -- CoA (1=MetrcCsv, 2=CoA, 4=ManifestReport, 5=ConsolidatedCoA)
  AND  s.LabId = 1001          -- Ohio
ORDER  BY rh.ReportedOn DESC;
```

Suppose this returns:

| LabSampleNr | Lab  | FolderPath          | NewFileName                                | OriginalName                                            |
|---|---|---|---|---|
| 142462 | NCTL | NCTL\Sample Reports | 954bab91-b409-41bf-bf28-813aea538318.pdf | 142462_Curaleaf_20240826150542830.pdf |

To **find that file in the Portal**:

1. Storage browser → File shares → production → NCTL → Sample Reports.
2. In the **Search files by prefix** box, paste the first 8 hex chars: `954bab91`.
3. The file should be the only result (or one of a small handful).
4. Click the file row → right pane shows **File properties** with Download, Last Modified, Size, ETag.

**Open the file:**
- Click the **Download** button in the right pane. The Portal streams the bytes through its authenticated session and your browser opens/saves the PDF.

**Do NOT just paste the URL into a new browser tab.** The raw URL `https://nclimsfiles.file.core.windows.net/production/NCTL/Sample%20Reports/<guid>.pdf` requires authentication headers your browser doesn't supply on a plain GET. You'll get:

```xml
<Error>
  <Code>InvalidHeaderValue</Code>
  <Message>The value for one of the HTTP headers is not in the correct format. ... HeaderName: x-ms-version</Message>
</Error>
```

That's an auth issue, not a missing-file issue. Use the Portal's Download button, or generate a SAS URL.

**To generate a SAS URL** (a temporary signed URL anyone can open in a browser):
1. With the file selected, the `…` menu (or right-click) → **Generate SAS**.
2. Set expiry (1 hour is fine for showing someone, up to 7 days for the share-level max).
3. Permissions: Read only.
4. The generated URL ends with `?sv=…&sig=…` and works anonymously in any browser until it expires.

This is what NCLims's own code does at runtime — `AzureFileStorageService.GetFileUri` builds a 1-hour SAS for users downloading CoAs out of the LIMS UI.

## Step 5 — see how versions accumulate

When a CoA gets regenerated (re-issued via the Generate Reports button), the system **mints a new file with a new GUID** and creates new `ReportFile` + `FileStorage` rows. **The old file is never overwritten**. This is by design — every regeneration is preserved as historical record.

To see this:

```sql
-- Find a sample with 3+ CoAs (NCTL has plenty)
WITH multi AS (
    SELECT s.Id, s.LabSampleNr, COUNT(*) AS CoaCount
    FROM   dbo.Sample s
    JOIN   dbo.ReportFile rf ON rf.SampleId = s.Id
    JOIN   dbo.FileStorage fs ON fs.ReportFileId = rf.Id
    WHERE  s.LabId = 1001
      AND  rf.ReportType = 2
      AND  rf.Deleted = 0 AND fs.Deleted = 0
    GROUP  BY s.Id, s.LabSampleNr
    HAVING COUNT(*) >= 3
)
SELECT TOP 1 Id, LabSampleNr, CoaCount FROM multi ORDER BY NEWID();
```

Then list all versions for that sample:

```sql
SELECT fs.FileCreatedOn AS GeneratedUtc,
       fs.NewFileName   AS GuidOnShare,
       fs.FileName      AS OriginalName
FROM   dbo.ReportFile  rf
JOIN   dbo.FileStorage fs ON fs.ReportFileId = rf.Id
WHERE  rf.SampleId   = @ChosenSampleId
  AND  rf.ReportType = 2
  AND  rf.Deleted = 0 AND fs.Deleted = 0
ORDER  BY fs.FileCreatedOn;
```

You'll see something like:

| GeneratedUtc | GuidOnShare | OriginalName |
|---|---|---|
| 2023-04-20 22:00:34 | f31d970e-19b1-438a-9f87-15ece642a7f7.pdf | …_20230420220034342.pdf |
| 2023-04-21 14:31:49 | 24a3ba78-92d3-447b-85b1-c9539e87ae2c.pdf | …_20230421143149241.pdf |
| 2023-04-21 14:55:27 | ddd17f97-b7a9-43d1-9b61-02c640c9547e.pdf | …_20230421145527164.pdf |

Three regenerations within ~17 hours — typical pattern for a correction-then-re-correction event. All three files exist on the share right now; you can prefix-search any of those GUIDs and download them side-by-side. The DB doesn't capture *why* a CoA was regenerated (that's a deferred-amendment-UX gap), but `ReportHistory.ApplicationUserId` tells you *who* clicked Generate each time.

**This is the load-bearing property your backfill relies on:** historical regenerations are still on disk, intact. The bytes you'll be importing from Confident may match the most recent local version, an older local version, or none of them — that's why Confident's `coa.public_key` (not byte hashing) is the right comparison key.

## Step 6 — chain of custody story for auditors

For any sample, the answer to "which CoA was sent out, when, by whom" lives in three coordinated places:

1. **`Sample`** — the LIMS sample record (LabSampleNr, LabId, ConfidentCannabisId).
2. **`ReportFile` + `FileStorage`** — every CoA ever generated for that sample, with provenance (generated when, original filename, the GUID on the share).
3. **`ReportHistory`** — links each CoA to the specific `SampleAssay` (panel result) it reported and the user (`ApplicationUserId`) who clicked Generate.

The bytes live on Azure Files, addressed by `FolderPath + NewFileName`. SHA-256 is **not** currently stored anywhere — that's something the backfill will add for tamper-evidence going forward, but isn't present on existing rows.

**Compliance talking points (from Adam's session):**
- **Atomic write:** the file save and DB row inserts are committed together via EF Core transaction. On failure, the orphan file is deleted from the share (see `ReportingService.cs:134-135`). No half-states.
- **Immutability in practice:** no code path overwrites a saved CoA. Re-generation = new GUID file + new ReportFile row. Old file stays.
- **Access control:** the share is reached either (a) via the connection string in `nclims-kv` (scoped to whoever has KV `Get` on that secret) or (b) via 1-hour SAS URLs the app mints for users. No direct anonymous access.
- **Filename obfuscation:** GUID filenames mean an auditor can't browse "by sample number" via filesystem alone — they have to come through the DB to learn which GUID maps to which sample. That's intentional information separation.

## Step 7 — the gap your project closes

Today, **NCTL only knows about CoAs it itself generated**. If CS uploads a corrected PDF directly to Confident's UI (the manual amendment path used for sample 217848), that file exists in Confident but NOT in NCTL's Azure Files share. NCTL's archive is incomplete by definition until you do the backfill.

The backfill pulls **Confident's of-record copy** for every sample, storing it alongside the LIMS-generated versions in `NCTL/Sample Reports/` (with new GUIDs). After the run completes, NCTL holds a canonical copy of every CoA ever issued, regardless of which path produced it.

That's the project. The rest is in `PLAN.md`.

## Cheat sheet — Portal navigation paths

| What | How |
|---|---|
| Find storage account name | Key Vault `nclims-kv` → Secrets → `FileShareConnectionString` → Show Secret Value → parse `AccountName=` |
| Find share name | App Services → production NCLims app → Environment variables → `FileShareName` (= `production`) |
| Browse files | Storage accounts → `nclimsfiles` → Storage browser → File shares → `production` → `NCTL` (or `NCTLM`) → `Sample Reports` |
| Look up a CoA by sample | SQL: `Sample → ReportFile → FileStorage`, then prefix-search GUID in Storage browser |
| Open a CoA | Click the file in Storage browser → **Download** button in right pane (DO NOT paste raw URL) |
| Generate a shareable link | Click the file → `…` menu → **Generate SAS** → Read-only, 1-hour expiry |
| Verify share is live (not the misleading 2021 dates) | Storage account → Monitoring → Metrics → metric `Transactions`, scope to `production` share |
| Read-only prod DB access | KV secret `NCLimsConnection-Prod-ReadOnly` → sqlcmd against `lims5000.database.windows.net` |

## Glossary

- **CoA** — Certificate of Analysis. The PDF that goes to the customer.
- **Confident Cannabis / CC** — third-party SaaS that hosts customer-facing CoA portals.
- **NCTL** — North Coast Testing Laboratories. Also the Ohio lab's slug.
- **NCTLM** — same company, Michigan lab. The slug NCTL uses internally.
- **Lab.Slug** — short identifier per lab (NCTL=Ohio, NCTLM=Michigan). Used as the top-level folder name on the share.
- **Sample.LabSampleNr** — the internal 5-or-6-digit sample number. What CS and analysts refer to in conversation.
- **Sample.ConfidentCannabisId** — the identifier CC uses for the same sample. Format like `2604NCTL1753.14775` (order prefix + sub-id).
- **FileStorage.NewFileName** — the GUID-based filename used on the Azure Files share. Always unique. Never overwritten.
- **FileStorage.FileName** — the original human-readable filename (e.g. `142462_Curaleaf_20240826150542830.pdf`). Preserved for display.
- **ReportType** — enum on `ReportFile`. `1=MetrcCsv`, `2=CoA`, `3=CcResults`, `4=ManifestReport`, `5=ConsolidatedCoA`. **Filter `=2` for CoAs.**
- **System of record (SoR)** — the authoritative archive. Today it's CC; after this project, it's NCTL's Azure Files share.
