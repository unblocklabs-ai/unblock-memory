# Release

GitHub Actions publishes this plugin to npm when a GitHub Release is published.
The release tag, `package.json`, and `openclaw.plugin.json` must all contain the
same version. Stable releases use npm's `latest` tag; GitHub prereleases use
`next`.

## One-time trusted publisher setup

npm requires a package to exist before it can have a trusted publisher.
Version `0.1.0` was published as that one-time bootstrap release. After this
workflow exists on the repository's default branch, an npm owner must establish
the trust relationship once:

```bash
npx --yes npm@11.13.0 trust github @unblocklabs/openclaw-unblock-qmd \
  --repo unblocklabs-ai/unblock-qmd \
  --file release.yml
```

Do not republish `0.1.0` and do not add an `NPM_TOKEN` GitHub secret. Trusted
publishing gives subsequent workflow runs short-lived credentials through OIDC.

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
