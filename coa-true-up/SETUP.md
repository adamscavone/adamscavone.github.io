# CoA Backfill — Setup & Access Requirements

> **For:** David Kohn (and his team / DevOps). **Before you can do anything:** get the access listed here.

## Azure tenant + subscription

- **Tenant:** `nctl.com` (NCTL — North Coast Testing Laboratories)
- **Subscription:** `North Coast LIMS` (the one containing the storage account `nclimsfiles`, key vault `nclims-kv`, and the SQL server `lims5000.database.windows.net`)
- **Resource group(s) you'll touch:** `NorthCoastLims` (existing prod) and one new resource group you'll create for the standalone project's resources (e.g., `coa-backfill-rg`).

**To request:** ask Adam Scavone or NCTL's Azure admin to add your user as **Reader** on the existing `NorthCoastLims` resource group, plus **Contributor** on a new resource group you create for the project's own resources (your ledger DB, WebJob host, etc.).

## Required RBAC roles

| Resource | Role you need | Why |
|---|---|---|
| Key Vault `nclims-kv` | **Key Vault Secrets User** | read `NCLimsConnection-Prod-ReadOnly` and CC credentials |
| Storage account `nclimsfiles` | **Storage File Data SMB Share Contributor** | write CoA bytes to the `production` file share |
| SQL Server `lims5000.database.windows.net`, DB `NCLims` | none directly — use the connection string | the read-only login `nclimsproduser_readonly` is already bundled in the KV secret |
| Your project's own Azure SQL DB | **DB owner** (or equivalent) | for your ledger schema |
| Your project's WebJob / Container App | **Contributor** | to deploy and run |

**Managed identity recommended.** Stand up a User Assigned Managed Identity for the WebJob, grant it the roles above, and read all secrets via `DefaultAzureCredential` in code. Avoid baking creds into config.

## Key Vault secrets you'll consume

In `nclims-kv` (existing):

| Secret | Contents | Notes |
|---|---|---|
| `NCLimsConnection-Prod-ReadOnly` | SQL connection string for read-only access to production `NCLims` DB | This is the canonical way to read prod. Never use the read-write prod connection string. |
| `FileShareConnectionString` | Connection string for storage account `nclimsfiles` | Contains the account key; treat as sensitive. Recommended: use managed identity instead and skip this secret. |
| `FileShareName` | Name of the share (`production`) | Actually stored as an App Service application setting, not a KV secret — see `Startup.cs:426`. You can hard-code `production` in your project. |

CC API credentials are stored in the **NCLims database** itself, not in Key Vault:

```sql
-- Read-only against prod
SELECT Id, Slug, CcApiKey, CcSecretKey
FROM   dbo.Lab
WHERE  Id IN (1001, 1003);
```

`CcApiKey` is a `Guid`. `CcSecretKey` is an **encrypted string** (DPAPI-style); the existing NCLims code decrypts it with a key in app settings. **You will need Adam to share the decryption key, or to hand you the decrypted secret out-of-band** — don't try to reverse the encryption from the DB row alone.

**Recommended:** ask Adam to mint per-lab CC credentials specifically for your project and store them in your own Key Vault. Don't reuse the production app's CC credentials; you want to be able to revoke yours without affecting prod.

## Tools you'll need locally

- **.NET 8 SDK** (`dotnet --version` ≥ 8.0)
- **Azure CLI** (`az`) — for KV reads, RBAC verification, deployment
- **SQL client** — Azure Data Studio, SSMS, or `sqlcmd` (already installed on most Windows boxes via the ODBC driver)
- **Git + GitHub access** (or Azure DevOps, your team's call — see "Repo hosting" below)
- **Storage Explorer** (desktop) or familiarity with Azure Portal → Storage Browser — for verifying file writes during smoke tests

Optional:
- **Polly** NuGet package for retry/rate-limit
- **Dapper** for the ledger DB (lighter than EF Core for a 3-table schema)
- **Application Insights SDK** for telemetry

## Repo hosting

NCTL uses **Azure DevOps** for the main LIMS codebase (`https://dev.azure.com/<org>/<project>`) but the patterns aren't rigid for side projects. Your call:

- **Option A — Azure DevOps**: matches NCTL's existing convention; co-locates with the LIMS pipelines if you want shared agent pools.
- **Option B — GitHub**: simpler, easier collaboration with Claude Code, doesn't require ADO licensing.

Either works. If GitHub, create a private repo under whatever org you prefer. Adam can be added as a reviewer.

## Storage layout

The backfilled files target the existing share:

```
Storage account: nclimsfiles
Share:           production
Path:            <labSlug>/Sample Reports/<NewGuid>.pdf

Where <labSlug> is:
  NCTL   for LabId = 1001 (Ohio)
  NCTLM  for LabId = 1003 (Michigan)
```

Files written here will sit alongside files NCLims wrote itself. Don't worry about collisions — every file has a fresh GUID name.

**Optional alternative:** if it would be cleaner organizationally for the backfilled files to live in their own subdirectory (e.g., `<labSlug>/Sample Reports/Backfilled From Confident/`), that's a one-line config change in your project. Doesn't affect retrieval — NCLims looks files up by `FileStorage.FolderPath + NewFileName`, so the path can be anything.

## Database for your ledger

**Recommended: Azure SQL Database**, S1 tier or smaller. Co-located with your project's resource group. ~$30/month, plenty of headroom for 200k+ ledger rows plus indexes.

Alternatives:
- **Azure SQL Database serverless** — auto-pause when idle, cheaper if the backfill runs in bursts
- **SQLite** — single-file DB, fine if the WebJob runs from a single host with persistent storage. Not recommended for production-grade observability.

Schema in `PLAN.md` §6.

## First-day verification commands

Once you have access, these prove your setup works:

```bash
# 1. Confirm tenant + subscription
az account show --query "{tenant: tenantDisplayName, sub: name}" -o table

# 2. Confirm KV read access
az keyvault secret show \
  --vault-name nclims-kv \
  --name NCLimsConnection-Prod-ReadOnly \
  --query value -o tsv | head -c 80
# Should print "Server=tcp:lims5000.database.windows.net..." (first 80 chars)

# 3. Confirm prod DB read access (parse conn string from above, then)
sqlcmd -S lims5000.database.windows.net -d NCLims \
       -U nclimsproduser_readonly -P "<password-from-conn-string>" -N -C \
       -Q "SELECT COUNT(*) FROM dbo.Sample WHERE ConfidentCannabisId IS NOT NULL;"
# Should print a count in the hundreds of thousands.

# 4. Confirm Azure Files share access
az storage file list \
  --account-name nclimsfiles \
  --share-name production \
  --path "NCTL/Sample Reports" \
  --num-results 5 \
  --query "[].name" -o tsv
# Should list 5 GUID-named files.

# 5. Confirm CC credentials (after Adam shares decrypted secret)
# Use the smoke-test script in your project to call GET /v0/lab and verify HMAC signing works.
```

If any step fails, fix it before moving on. The most common gotcha is RBAC propagation lag — role assignments can take 5-10 minutes to take effect.

## Security notes

- **Never commit credentials.** Use Key Vault + managed identity from the start.
- **Connection string for prod is read-only by design.** If you accidentally use the read-write production connection string (`NCLimsConnection-Prod`), you can damage live data. Stick to `-ReadOnly`.
- **Don't run the backfill against staging or QA NCLims DBs** — they don't have the same `ConfidentCannabisId` data shape and the CC API calls would target real CC tenants from a non-prod context.
- **The Azure Files share is shared with production.** Files you write are visible to NCLims and to anyone with RBAC on the share. That's intentional (you're populating the production archive). Just be aware: if you accidentally write garbage during testing, those files persist with their GUIDs and you have to clean them up.

## Contact for access blockers

**Adam Scavone** — ascavone@nctl.com. He owns the Azure subscription and can grant the RBAC roles, share the CC secret, and answer infrastructure questions.

For pure Azure billing / cost-center questions, escalate via NCTL's standard IT request channel after Adam confirms the project scope.
