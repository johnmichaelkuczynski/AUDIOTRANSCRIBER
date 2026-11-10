---
name: Container startup verification
description: Deployment verification must exercise the actual runtime image, not a development package-manager path.
---

Validate the image's exact startup command and healthcheck, not merely an equivalent package script on the host.

**Why:** A host production test passed while the deployed image failed because a copied package-manager launcher depended on files relative to its original location. Copying a launcher is not a portable package-manager installation.

**How to apply:** Prefer direct Node startup for this app. When testing containers, separate application HTTP results from failures of the local Docker exec mechanism. A successful standalone healthcheck command is not evidence that Docker's scheduled health status became healthy; report that distinction explicitly.
