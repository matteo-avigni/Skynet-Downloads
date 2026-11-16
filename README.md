# Skynet Installers

The public site hosts the current Skynet installation packages:

- [Skynet Installers](https://skynet.matteo-avigni.com/)

Installer binaries and signed update feeds are stored in a private Cloudflare
R2 bucket and exposed read-only through the download site's Worker. The GitHub
Pages site mirrors only signed feed metadata for older Skynet builds that still
use the legacy update URL.

Publication is intentionally limited to the Windows MSI, the Developer ID
signed and notarized macOS PKG, the Linux x64 Debian package, signed
update-feed metadata, and the PDF operator handbook in `docs/`. This repository
does not use GitHub Releases or publish application source. The Skynet
application source remains private.

The release control page is `/admin/`. Its API requires the
`SKYNET_ADMIN_TOKEN` and `GITHUB_WORKFLOW_TOKEN` Worker secrets. The GitHub token
must be a fine-grained token restricted to `matteo-avigni/Skynet` with Actions
read/write permission. The page remains locked until the admin password is
validated. After authentication, installer publication uploads the canonical
Windows MSI and macOS PKG directly to R2 and only advances the public manifest
after both objects are present. Updater publication is a separate action that
dispatches the signed-feed workflow for the current manifest.

Each installer upload must remain below Cloudflare's 100 MB request limit. A
published semantic version cannot be reused with a different build identifier.

Run `npm run check` before deployment. Upload the current manifest's installers
and metadata with `npm run publish:current`, or migrate every installer in
`downloads/` with `npm run publish:all`, then deploy the site with
`npm run deploy`. Verify the live hostname with `npm run verify`.
