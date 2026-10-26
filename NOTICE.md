# Provenance and third-party notices

This independent review packages the frozen semantic API candidate and frozen UI8 monitor with a narrow API-frame version compatibility fix. It does not rewrite the API transport, profile validation, approval flow, ledger, semantic cache algorithm or monitor receiver/history. Exact copy/changed-file evidence is retained in the separate local audit directory, not committed with private machine paths.

The Node runtime's complete upstream license and bundled dependency notices are preserved verbatim in `runtime/LICENSE.node.txt`; its supplied checksum material is preserved in `runtime/SHASUMS256.txt`. The binary is separate from a source-only Git checkout. These third-party notices do not grant a license to the rest of this project.

Windows/.NET Framework, WPF, WinForms and DPAPI are system dependencies, not copied frameworks. Model weights, Python, torch, transformers and their native/transitive packages are not redistributed. An optionally selected model/environment has its own licenses and must be reviewed by its operator; the known MiniLM model card declares Apache-2.0. Optional Python dependencies have not received a new complete vulnerability/license audit here.

The existing project declares the small SVG icon original. No competing cache implementation, article code, paper implementation or ASUS executable was copied into this package. This scoped source/provenance review cannot establish absence of all third-party similarity, patent claims or unknown contributions. The project owner selected Apache License 2.0 for project-owned contributions on 2026-10-26; see LICENSE and NOTICE. Third-party materials retain their original terms. This selection does not resolve unidentified prior contribution rights, patent or trademark claims.

Reference interface documentation (not copied implementation):
https://www.sbert.net/docs/sentence_transformer/usage/semantic_textual_similarity.html
https://www.sbert.net/docs/package_reference/sentence_transformer/model.html
