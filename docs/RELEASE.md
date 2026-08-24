# Release

GitHub Actions publishes this plugin to npm when a GitHub Release is published.
The release tag, `package.json`, and `openclaw.plugin.json` must all contain the
same version. Stable releases use npm's `latest` tag; GitHub prereleases use
`next`.

## Trusted publisher

npm trusted publishing is configured with:

- GitHub organization: `unblocklabs-ai`
- repository: `unblock-qmd`
- workflow: `release.yml`
- allowed action: `npm publish`

Manage this configuration through the package settings on npm. The npm 11.13
`npm trust` command cannot select the required allowed action and the registry
rejects it with `E400`. Do not add an `NPM_TOKEN` GitHub secret; trusted
publishing gives workflow runs short-lived credentials through OIDC.

## Publish a release

1. Update the version in `package.json`, `package-lock.json`, and
   `openclaw.plugin.json`.
2. Run `npm run preflight`.
3. Commit and push the version change to `main`.
4. Create and publish an annotated `vX.Y.Z` Git tag and matching GitHub Release.

For example:

```bash
git tag -a v0.1.1 -m v0.1.1
git push origin main refs/tags/v0.1.1
gh release create v0.1.1 --verify-tag --generate-notes --title v0.1.1
```

Publishing the GitHub Release runs `.github/workflows/release.yml`, which:

- checks out the exact release tag;
- verifies the release commit belongs to `main`;
- verifies the tag and package versions match;
- runs the full plugin preflight; and
- publishes the package to npm with provenance.
