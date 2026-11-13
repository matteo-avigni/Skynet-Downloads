# Skynet Installers

The public site hosts the current Skynet installation packages:

- [Skynet Installers](https://skynet.matteo-avigni.com/)

Installer binaries are stored in a private Cloudflare R2 bucket and exposed
read-only through the download site's Worker. The GitHub Pages site remains a
temporary compatibility bridge for existing clients and points downloads to
the Cloudflare hostname.

Publication is intentionally limited to the Windows MSI, the Developer ID
signed and notarized macOS PKG, and signed update-feed metadata. This repository
does not use GitHub Releases or publish application source. The Skynet
application source remains private.

Run `npm run check` before deployment. Upload the current manifest's installers
with `npm run publish:current`, or migrate every installer in `downloads/` with
`npm run publish:all`, then deploy the site with `npm run deploy`. Verify the
live hostname with `npm run verify`.
