# Durable Knowledge

## KC-0001: MVP security boundary

- Kind: fact
- Status: active
- Created: 2026-11-08T13:11:45.276Z
- Updated: 2026-11-08T13:11:45.276Z
- Sources: []

Targets are selected only from the JSON registry. OpenCode runs with --pure, shell=false argument arrays, restrictive inline read-only permissions, a sanitized non-secret environment, timeout/output limits, structured report validation, and metadata-only audit logs. The MVP does not provide an OS-level sandbox.

## KC-0002: Verified OpenCode adapter contract

- Kind: fact
- Status: active
- Created: 2026-11-08T13:12:06.275Z
- Updated: 2026-11-08T13:12:06.275Z
- Sources: []

Installed OpenCode version is 1.19.5. Its help confirms batch command opencode run with --format json, --agent, --dir, --model, and --pure; --auto exists but is intentionally not used. Resolved agent output confirmed the inline relay-research permission ordering.

## KC-0003: Repository language policy

- Kind: decision
- Status: active
- Created: 2026-11-17T05:45:28.666Z
- Updated: 2026-11-17T05:45:28.666Z
- Sources: []

All repository-facing content must be in English. Before publishing, translate any non-English information intended for the repository.

## KC-0004: Work-context versioning policy

- Kind: decision
- Status: active
- Created: 2026-11-17T05:46:30.453Z
- Updated: 2026-11-17T05:46:30.453Z
- Sources: []

Commit work-context files to Git, except for `.work-context/local/`, which must remain local and is ignored.
