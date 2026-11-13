# Skynet Installers

The public site hosts the current Skynet installation packages:

- [Skynet Installers](https://skynet.matteo-avigni.com/)

Installer binaries and signed update feeds are stored in a private Cloudflare
R2 bucket and exposed read-only through the download site's Worker. The GitHub
Pages site mirrors only signed feed metadata for older Skynet builds that still
use the legacy update URL.

Publication is intentionally limited to the Windows MSI, the Developer ID
signed and notarized macOS PKG, and signed update-feed metadata. This repository
does not use GitHub Releases or publish application source. The Skynet
application source remains private.

The release control page is `/admin/`. Its API requires the
`SKYNET_ADMIN_TOKEN` and `GITHUB_WORKFLOW_TOKEN` Worker secrets. The GitHub token
must be a fine-grained token restricted to `matteo-avigni/Skynet` with Actions
read/write permission.

Run `npm run check` before deployment. Upload the current manifest's installers
and metadata with `npm run publish:current`, or migrate every installer in
`downloads/` with `npm run publish:all`, then deploy the site with
`npm run deploy`. Verify the live hostname with `npm run verify`.
