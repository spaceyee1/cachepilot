# Review scope and security boundaries

New bindings default to networkEnabled:false. An existing profile explicitly enabled by its user may allow networking; per-request local approval still applies. Five protocol adapters retain endpoint/TLS/auth checks and bounded budgets. No automatic paid test, credential discovery or request retry is performed. The default semantic settings contain no machine path and do not launch Python.

The CPU semantic encoder loads explicitly selected local files without remote model code/downloads. It is not an OS sandbox. Local exact/approximate reuse does not authenticate the host tenant or actual provider model revision. Similarity cannot prove semantic equivalence; non-ASCII and high-risk literals use exact matching only.

UI8 verifies Monitor.xaml against embedded bytes before parsing and pipe startup, pins the selected source PID and receipt watermark, and separates process totals from rolling intervals. The API codec accepts only explicitly tested API component versions with schema 3. The per-user monitor pipe can be owned by another monitor, which is never terminated automatically.

Same-user replacement of the EXE, runtime, model or Python remains a risk. Manifests are not independent signatures; project EXEs are unsigned. A new directory does not isolate the Windows user. Runtime floors are dated assessments, not proof that no vulnerabilities exist. The installed 0.6.8 runtime and shared global Node are not upgraded by this candidate.

Not covered by this review: true host identity binding, paid provider accuracy/latency, Chinese approximate reuse, full up-to-date CVE/transitive license/legal clearance, historical unreadable/reparse paths, cross-user/cross-platform compatibility, 8B inference, real ASUS service stop/restart/network/hotkey recovery, and long-duration leak freedom. Reparse/permission-dependent tests remain explicitly reported rather than changing system privileges.

Raw diagnostic reports, credentials, prompts, local model paths and machine-specific process inventories are excluded from the Git source package. Pattern scans cannot prove every form of sensitive content absent. See the local audited upload file list and `docs/VALIDATION.md` before upload.
