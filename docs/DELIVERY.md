# Delivery 2026-10-26

Project-owned contributions use Apache-2.0; third-party notices remain unchanged.
The root is the existing reviewed API0.1.2-semantic.1 / monitor0.1.1-ui.9 candidate.
The currently installed native plugin0.6.8 is not modified by this delivery.

- [Source ZIP](../dist/CachePilot-Apache2-source-20261026.zip): current project
  source, tests, docs, Apache license and notices; no executable runtime.
- [Windows x64 ZIP](../dist/CachePilot-Apache2-windows-x64-20261026.zip): the same
  product plus its three reviewed executables. Node26.12.1/OpenSSL3.5.9 is isolated
  inside that ZIP. Python, model weights and CUDA are not included.
- [ZIP SHA-256 checksums](../dist/SHA256SUMS.txt).

Each ZIP has its own MANIFEST.sha256.json with an explicit file scope. Dist ZIPs
are excluded from the source manifest to avoid recursive packaging. A source
checkout cannot start until the required runtime/binaries are supplied or built.
Neither archive installs anything or changes the current plugin or GPU setting.

This upload creates repository files, not a published GitHub Release. Historical
audits, binary captures containing machine paths, process inventories and local
credentials are excluded. Their public-export review is not complete. Originals
remain unchanged on the local machine. This is not a complete historical-audit
backup or a claim that optional environments passed a fresh license/CVE audit.
