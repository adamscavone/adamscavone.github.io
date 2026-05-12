# CoA Backfill — Handoff Notes

> **For:** David Kohn. **From:** Adam Scavone (current owner) via Claude Code session, 2026-05-12. **Status:** Ready for your team to own end-to-end.

## Why this project exists

North Coast Testing Laboratories (NCTL) issues Certificates of Analysis (CoAs) and currently depends on Confident Cannabis (CC, an external SaaS) as the authoritative archive of every CoA ever produced. Compliance and operational risk both push toward "we should hold our own canonical copies." Today, an outage at CC or a contract dispute would leave NCTL without immediate access to the bytes we sent customers, even though NCTL's own LIMS generated them in the first place.

This project pulls every of-record CoA from CC into NCTL's own Azure Files share, with cryptographic integrity and per-file provenance, and keeps that archive complete as new CoAs are issued.

**Volume:** order of magnitude 200,000 historical samples across two labs (Ohio + Michigan). Storage cost is bounded (NCTL already holds 504 GiB on the existing share).

**Amendment rate:** very low — exactly one amendment in NCTL's email history. The plan does NOT try to reconstruct historical amendment chains; it captures CC's current of-record state.

## What's already decided (don't re-litigate)

- **Reconciliation primitive is CC's per-CoA file identifier** (`CcFile.public_key`, Guid). NOT byte-by-byte hash comparison. Hashes false-positive on benign rendering drift and were affirmatively dropped after analysis.
- **SHA-256 is stored anyway**, but as post-import integrity proof (tamper-evidence), not as the comparison key.
- **CC is the source of truth for HISTORICAL CoAs.** Regenerating a 2023 CoA through current LIMS code produces analyte/limit drift (Ohio Admin Code panel definitions have evolved). We never regenerate historical CoAs — we trust CC's preserved-as-issued bytes.
- **The backfill writes to `nclimsfiles/production/<labSlug>/Sample Reports/`** — the existing Azure Files share NCTL's LIMS already uses. New GUID per file. Never overwrites.
- **Lab slugs are `NCTL` (Ohio, LabId=1001) and `NCTLM` (Michigan, LabId=1003).** Per the `Lab.Slug` column.
- **Going-forward correctness uses incremental polling**, NOT a code change to NCLims's `ReportingService.ReportOnSample`. Standalone project, no LIMS source edits required.
- **After this project ships, NCTL's LIMS becomes the system of record** for issued CoAs. Future amendments are authored in LIMS (separate initiative) and pushed to CC. We will NOT build reverse CC→LIMS sync; one-direction-of-truth is intentional.

## What's deferred (deliberately, not forgotten)

**LIMS-side "Amend CoA" UX** — the Razor modal that lets CS or a lab director author an amendment, attach a canned amendment message (e.g. "REPORT AMENDED TO REFLECT PBO RESULT CORRECTION" — see sample 217848 for the historical precedent), regenerate the CoA with a native red "AMENDED" banner stamped on the cover page, and push it to CC via the API.

That work touches the CoA cover-page renderer code, which is currently the active surface of another engineer's release (Pearson, microbials). Bundling the amendment UX into this project would create a collision risk. **The amendment UX will be picked up as a separate initiative after Pearson's release ships.**

Until then, amendments continue to be authored manually via CC's UI by CS, the same way they're authored today. Your backfill captures whatever amendment-equivalent files CC already has (see `coa_additions` discovery item below).

## Stakeholder decision context

Six product-level decisions exist on the companion review page (same URL, decisions section):

1. **Lab rollout order** — Ohio first / Michigan first / both concurrently
2. **Backfill pace** — fast ~3 days / balanced ~5-7 days / slow ~3 weeks
3. **Multiple-file handling** — what to do when CC has more than one CoA file per sample
4. **Confident-only orphans** — what to do about samples in CC with no LIMS match
5. **Drift warning visibility** — what UX surface to show when someone regenerates a backfilled CoA in LIMS
6. **Amendment UX timing** — when does the deferred work get picked up

Adam will compile these from stakeholder responses and hand you the results. **You don't need them all answered before starting** — the smoke test + ledger schema work is independent of these calls. Decisions 1, 2, 5 affect the rollout itself; decisions 3, 4, 6 affect scope outside the core flow.

## Open discovery items (likely your first real findings)

These aren't blockers — they're things we don't know empirically yet and that you'll be the first to verify:

### `CcSample.CoaAdditions` semantics

CC's API response on `GET /v0/sample/{ccId}` includes both `coa` (singular `CcFile`) and `coa_additions` (a `List<CcFile>`). We don't know what's in the additions list. Plausible candidates:

- **Amendment history** — older versions of the CoA that got replaced (this would be the most useful interpretation)
- **Supplemental documents** — method addendums, accreditation letters, COC photos
- **Cover-image-or-other-asset overflow** — additional non-CoA files associated with the sample
- **Something else entirely**

Your smoke test should include **sample 217848 (Klutch Cannabis, CC ID `2604NCTL1753.14775`)**. That's NCTL's one documented historical amendment. Fetch its CC payload, inspect `coa_additions`, and report back what's there. Adam will help interpret.

### CC rate limits

The published CC rate limits aren't documented in the NCLims source. The existing client (`CcApiService.cs`) has no retry/backoff logic and has been mostly used for low-volume per-sample calls. Your 1,000-sample pilot is the first sustained load against CC from NCTL. Watch for `429 Too Many Requests` and `Retry-After` headers. Adjust the semaphore pace accordingly.

### CC sandbox tenant

`CcApiService.cs:81-82` has a commented-out sandbox URL. Verify with Adam whether the sandbox holds representative historical data (good for smoke testing) or is wiped periodically (use a small production slice instead).

## Latent bugs in existing NCLims code — DON'T replicate

The existing NCLims `CcApiService.cs` is correct enough for the production system that uses it, but for a standalone project you'll do better. Things to know:

- **No retry/backoff.** `Line 557` literally says `// Implement retries?`. Build Polly in from day one.
- **`Orders.modifiedSinceTime` parameter is not serialized correctly** (line 434 area). If you need date-range Orders enumeration for the optional orphan crawl, fix the form-encoding.
- **`Sample.ResultsSentToConfidentCannabis` flips to true after `SampleTestResults` upload, NOT after CoA upload.** Don't trust this flag as proof that CC has the PDF.
- **`SendSampleToCc` picks "latest ReportFile where FileName contains '.pdf'"** without filtering on `ReportType=2`. Once non-CoA PDF reports exist for a sample, the wrong file will be uploaded. Doesn't affect your backfill (you read from CC, not push to CC), but worth knowing if you reference the code.

## Domain expert

**Adam Scavone** (ascavone@nctl.com) — original owner, source of all "what is this column actually for" and "why was this decision made" answers. Pearson handles the microbials side; Adam is your point of contact for everything CoA / Confident Cannabis / LIMS-side.

## Reading order for day one

1. **HANDOFF.md** (this doc) — orientation
2. **PLAN.md** — the engineering plan
3. **SETUP.md** — what access you need before you can run anything
4. **CC_API_REFERENCE.md** — the HMAC protocol, endpoints, known traps
5. **BOOTSTRAP.md** — copy-paste this into your Claude Code instance as your first message

## Decisions that need stakeholder input

See the decisions section on the same URL. Compiled responses will be handed to you separately. If you want to surface additional questions for stakeholders, ask Adam to add a v2 decisions page — the pattern is established.

## Project name

For now, "CoA Backfill" or "CoA True-Up." NCTL doesn't have a formal codename for this. Use whatever you want for your repo.
