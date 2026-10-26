# Universal MCP delivery 2026-10-26

Project-owned contributions use Apache-2.0; third-party notices remain unchanged.
The API0.1.2-semantic.1 / monitor0.1.1-ui.9 core is unchanged. Host-specific root
manifests are removed; generic configuration is printed by scripts/mcp-config.mjs.
See [generic MCP setup](UNIVERSAL-MCP.md). This is a host-neutral integration,
with Windows-only production credentials/UI, not verified cross-platform support.
The author's separately installed native tokenizer0.6.8 is not changed or bundled.

- [Universal source ZIP](../dist/CachePilot-universal-source-20261026.zip): commit a6bb902 snapshot of project
  source, tests, docs, Apache license and notices; no executable runtime.
- [Universal Windows x64 ZIP](../dist/CachePilot-universal-windows-x64-20261026.zip): the same
  product plus its three reviewed executables. Node26.12.1/OpenSSL3.5.9 is isolated
  inside that ZIP. Python, model weights and CUDA are not included.
- [ZIP SHA-256 checksums](../dist/SHA256SUMS.txt).

The two older CachePilot-Apache2-*-20261026.zip files remain byte-for-byte historical
artifacts of commit15c4c7f. They contain the previous Codex-specific packaging and
are not the current generic integration. Use the two Universal links above.

File scopes: universal source ZIP96 files; runnable ZIP99 files (the same96 plus
Node/helper/monitor executables). Their manifests contain95 and98 entries because
each excludes itself. The repository also keeps four ZIPs and one checksum file;
those five dist files are not inside either universal product ZIP. See the exact
test scopes in UNIVERSAL-MCP.md and the later targeted findings in PROJECT-BOUNDARIES.md.

Each ZIP has its own MANIFEST.sha256.json with an explicit file scope. Dist ZIPs
are excluded from the source manifest to avoid recursive packaging. A source
checkout cannot start until the required runtime/binaries are supplied or built.
Neither archive installs anything or changes the current plugin or GPU setting.

This upload creates repository files, not a published GitHub Release. Historical
audits, binary captures containing machine paths, process inventories and local
credentials are excluded. Their public-export review is not complete. Originals
remain unchanged on the local machine. This is not a complete historical-audit
backup or a claim that optional environments passed a fresh license/CVE audit.


The current main-branch documentation adds corrected project boundaries and later
targeted acceptance after a6bb902. This documentation-only commit does not rebuild
or replace any ZIP or the previously exported local Word reading copy. Their
original hashes and commit scope remain valid; they do not contain this addendum.
Read [current boundaries](PROJECT-BOUNDARIES.md) alongside the archived package.
