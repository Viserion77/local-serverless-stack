# Release Process

This document describes the automated release and publishing process for Local Serverless Stack (LSS).

## Overview

LSS uses GitHub Actions to automatically publish packages to NPM when version numbers are updated in `package.json` files.

## Current Versions

- **Root Package** (`local-serverless-stack`): `0.0.1`
- **Plugin** (`lss-serverless-plugin`): `0.0.1`
- **Orchestrator** (`lss-orchestrator`): `0.0.1` (private, not published)

## Quick Release

### Root Package (CLI + Orchestrator)

```bash
# Bump version
npm version patch  # 0.0.1 -> 0.0.2

# Commit and push
git add package.json
git commit -m "chore: release v0.0.2"
git push origin main
```

### Plugin Package

```bash
# Navigate and bump
cd packages/serverless-plugin
npm version patch

# Return to root
cd ../..

# Commit and push
git add packages/serverless-plugin/package.json
git commit -m "chore(plugin): release v0.0.2"
git push origin main
```

## What Happens Automatically

When you push a version change to `main`:

1. **Version Detection**: GitHub Actions compares the version in `package.json` with the previous commit
2. **Testing**: Full test suite runs (34 integration tests)
3. **Build**: Project is built (`npm run build`)
4. **Publish**: Package is published to NPM with `--access public`
5. **Tagging**: Git tag is created automatically (e.g., `v0.0.2` or `plugin-v0.0.2`)

## Workflow File

Location: `.github/workflows/publish.yml`

Key features:
- Detects version changes in both root and plugin packages
- Runs tests before publishing
- Publishes only changed packages
- Creates separate tags for root and plugin releases
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

- **PATCH** (`0.0.1` → `0.0.2`): Bug fixes, small improvements
- **MINOR** (`0.0.2` → `0.1.0`): New features, backwards compatible
- **MAJOR** (`0.1.0` → `1.0.0`): Breaking changes

Use npm commands:
```bash
npm version patch  # Bug fixes
npm version minor  # New features
npm version major  # Breaking changes
```

## Pre-release Checklist

Before bumping version:

- [ ] All tests passing locally (`npm test`)
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
- Tests are passing
- Build is successful

### Tag Already Exists

If a tag exists:
```bash
git tag -d v0.0.2
git push origin :refs/tags/v0.0.2
```

### Manual Publish

If automation fails:
```bash
npm run build
npm publish --access public
git tag v0.0.2
git push origin v0.0.2
```

## GitHub Actions Logs

Monitor releases at:
- Actions tab in GitHub repository
- Look for "Publish to NPM" workflow
- Check individual job logs for errors

## Package Scopes

- **Root package**: `local-serverless-stack` (unscoped)
- **Plugin**: `lss-serverless-plugin` (unscoped)

Both use `--access public` flag for publishing.

## Release Cadence

- **Patch releases**: As needed for bug fixes
- **Minor releases**: Monthly or when significant features are ready
- **Major releases**: When breaking changes are necessary

## First Release (0.0.1)

The initial release `0.0.1` marks the first stable version ready for public use. It includes:

- ✅ Full CLI implementation (start/stop/status/logs)
- ✅ Orchestrator with API and UI
- ✅ Serverless plugin for auto-registration
- ✅ LocalStack integration
- ✅ Lambda proxy generation
- ✅ Event source mappings
- ✅ 100% test coverage (34/34 tests passing)
- ✅ Complete documentation
- ✅ CI/CD pipeline

## Future Releases

Planned for upcoming versions:

- `0.0.2`: Bug fixes and documentation improvements
- `0.1.0`: Additional AWS service support (S3, EventBridge)
- `0.2.0`: Enhanced UI with real-time updates
- `1.0.0`: Production-ready stable release
