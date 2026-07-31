# Release Process

This document describes the release and publishing process for Local Serverless Stack (LSS).

## Overview

LSS uses GitHub Actions to automatically publish to NPM when the version number changes in `package.json` on `main`. The current version lives in `package.json` and on npm — this document does not track it. (The `serverless-lss` plugin package was retired in 1.0 and is no longer published.)

## Quick Release

### Root Package (`local-serverless-stack`)

```bash
# Bump version without committing or tagging
npm version patch --no-git-tag-version

# Stage and review the change
git add package.json package-lock.json
git diff --staged

# Commit and push
git commit -m "chore: release v0.8.1"
git push origin main
```

> Note: plain `npm version patch` would create a commit and a git tag by itself. Always use `--no-git-tag-version` so the bump can be reviewed before committing.

## What Happens Automatically

When a version change lands on `main`, `.github/workflows/publish.yml` runs:

1. **Version Detection**: the `check-version` job compares the `package.json` version against the previous commit (`HEAD~1`)
2. **Build**: the package is built (`npm run build`)
3. **Publish**: the package is published to NPM with `--access public`

Important:

- The publish workflow runs **no tests**. Testing happens in the separate CI workflow (`.github/workflows/tests.yml`): unit tests with a coverage gate, lint/typecheck, build verification and the self-engine integration suite run on every push/PR.
- The publish workflow creates **no git tags**. Tagging is manual and optional (e.g. `git tag v0.8.1 && git push origin v0.8.1`).

## Workflow File

Location: `.github/workflows/publish.yml`

Key features:
- Detects the version change against the previous commit
- Publishes only when the version changed
- Uses `NPM_TOKEN` secret for authentication

## NPM Token Setup

Required for automatic publishing:

1. Go to [npmjs.com](https://www.npmjs.com) → Account → Access Tokens
2. Generate New Token → Type: **Automation**
3. Copy the token
4. Go to GitHub Repo → Settings → Secrets and variables → Actions
5. New repository secret: Name = `NPM_TOKEN`, Value = `<your-token>`

## Versioning Strategy

We follow [Semantic Versioning](https://semver.org/):

- **PATCH**: Bug fixes, small improvements
- **MINOR**: New features, backwards compatible
- **MAJOR**: Breaking changes

Use npm commands:
```bash
npm version patch --no-git-tag-version  # Bug fixes
npm version minor --no-git-tag-version  # New features
npm version major --no-git-tag-version  # Breaking changes
```

## Pre-release Checklist

Before bumping version:

- [ ] Unit tests passing locally (`npm test`)
- [ ] Integration tests passing if Docker/LocalStack is available (`npm run test:integration`)
- [ ] Code built successfully (`npm run build`)
- [ ] CHANGELOG.md updated with changes
- [ ] README.md updated if needed
- [ ] Breaking changes documented
- [ ] Commits follow conventional commits format

## Post-release

After successful publish:

1. **Verify on NPM**: Check [npmjs.com/package/local-serverless-stack](https://www.npmjs.com/package/local-serverless-stack)
2. **Test installation**: `npm install local-serverless-stack@latest`
3. **Update documentation**: If needed
4. **Announce**: Release notes, changelog, etc.

## Troubleshooting

### Publish Failed

Check:
- NPM_TOKEN is valid and has publish permissions
- Version is unique (not already published)
- Build is successful

### Manual Publish

If automation fails:
```bash
npm run build
npm publish --access public
```

## GitHub Actions Logs

Monitor releases at:
- Actions tab in GitHub repository
- "Publish to NPM" workflow for publishing; "CI" workflow for tests
- Check individual job logs for errors

## Package Scope

- `local-serverless-stack` (unscoped), published with `--access public`.

## Release Cadence

- **Patch releases**: As needed for bug fixes
- **Minor releases**: When significant features are ready
- **Major releases**: When breaking changes are necessary
