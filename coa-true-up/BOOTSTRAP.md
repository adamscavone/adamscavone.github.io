# Bootstrap prompt for your Claude Code instance

> Copy everything below the `---` line into your first message in a fresh Claude Code session. Replace `<your-project-dir>` with wherever you'll work. Adjust the model / fast-mode flags to your preference.

---

I'm David Kohn, and I'm taking over the **CoA Backfill** project from Adam Scavone at North Coast Testing Laboratories (NCTL). This is a brand-new project — I have no existing repo yet, and I'm NOT modifying the NCLims production codebase or its Kondo work-in-progress branch. I'm building a standalone tool.

**The project:** pull every Certificate of Analysis NCTL has ever issued out of Confident Cannabis (CC, a third-party portal) and into NCTL's own Azure Files share, with cryptographic integrity and per-file provenance. After this ships, NCTL's internal LIMS becomes the system of record for issued CoAs.

**Before you write any code, read these four documents in order:**

1. `https://adamscavone.github.io/coa-true-up/HANDOFF.md` — orientation, what's already decided, what's deferred, who the domain expert is. (Access code on the page: `nctl`. Markdown files are linked from the page; read them in raw form.)
2. `https://adamscavone.github.io/coa-true-up/PLAN.md` — the engineering plan. Architecture, reconciliation primitive (CC identity, NOT hashing — read the rationale carefully), backfill orchestration, ledger schema, verification protocol.
3. `https://adamscavone.github.io/coa-true-up/SETUP.md` — access requirements (Azure RBAC, Key Vault secrets, CC API credentials).
4. `https://adamscavone.github.io/coa-true-up/CC_API_REFERENCE.md` — Confident Cannabis API protocol: HMAC-SHA256 request signing, endpoint catalog, known bugs in NCTL's existing client that I should NOT replicate.

**After reading, verify my access is set up** by running the commands in `SETUP.md` §"First-day verification commands". Report which ones succeed and which fail. If anything fails, list the role / secret / capability I'm missing — I'll go get it before we proceed.

**Then scaffold the project** per the plan:
- .NET 8 console app or Azure WebJob
- Polly retry + rate-limit (~0.5 req/sec sustained against CC)
- Azure SQL ledger DB (3 tables: `CoaBackfillRun`, `CoaBackfillItem`, indexes per the plan)
- HMAC-signed CC client (lift the protocol from the reference doc; do NOT lift the bugs)
- Smoke-test mode: 10 samples, **must include sample LabSampleNr 217848** (Klutch Cannabis, CC ID `2604NCTL1753.14775` — NCTL's one documented historical amendment, our gold case)

**Critical "don't do" list:**
- Don't modify the NCLims codebase. Standalone project only.
- Don't use byte hashing as the reconciliation primitive. Use CC's per-file `public_key` Guid. SHA-256 stored for integrity-proof only.
- Don't trust `Sample.ResultsSentToConfidentCannabis` as proof that CC has the CoA PDF.
- Don't run against staging / QA NCLims DBs. Production read-only only.
- Don't bake credentials into config. Managed identity + Key Vault.
- Don't try to reconstruct historical amendment chains. CC's current state is what we capture; one-version-per-sample is the operative assumption.

**First open discovery item** (please don't skip): once smoke testing is working, fetch sample 217848's CC payload and tell me what's in `coa_additions`. That field's semantics are unknown — amendment history, supplemental docs, or something else. We need to know before we can decide canonical treatment.

**Stop and ask if:**
- Any of the source documents contradict each other or themselves
- You discover NCTL infrastructure that doesn't match what the plan describes (the docs are point-in-time; verify before trusting)
- The smoke test reveals something materially different from what the plan assumes

Adam Scavone (`ascavone@nctl.com`) is the domain expert for everything CoA / Confident Cannabis / NCTL LIMS. Escalate to him for product / domain questions; handle pure-engineering decisions yourself.

Begin.
