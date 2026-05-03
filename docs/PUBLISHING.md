# Publishing Guide — GitHub Packages

This document describes how to publish skelm packages to GitHub Packages npm registry.

## Prerequisites

1. **GitHub PAT with `write:packages` scope**
   - Create a Personal Access Token at: https://github.com/settings/tokens
   - Scopes needed: `read:packages`, `write:packages`
   - Store the token securely (e.g., as `NPM_TOKEN` or `GITHUB_TOKEN` secret)

2. **Repository settings**
   - Ensure the repository has GitHub Packages enabled
   - Your GitHub account (`scottgl9`) owns the packages namespace

## Configuration

### Local `.npmrc` (already created)

The `.npmrc` file in the repository root configures:
- Registry URL: `https://npm.pkg.github.com/scottgl9`
- Authentication via `NODE_AUTH_TOKEN` environment variable
- Publish configuration for all packages

### Package `publishConfig`

Each package has `publishConfig` in its `package.json`:
```json
{
  "publishConfig": {
    "registry": "https://npm.pkg.github.com/scottgl9",
    "access": "public"
  }
}
```

## Publishing Methods

### Method 1: GitHub Actions (Recommended)

Use the `.github/workflows/publish.yml` workflow:

**Trigger on release:**
```bash
# Create a release on GitHub
git tag v0.3.0
git push origin v0.3.0
# Then create release at https://github.com/scottgl9/skelm/releases/new
```

The workflow automatically publishes all packages when a release is published.

**Manual trigger:**
1. Go to Actions → "Publish to GitHub Packages"
2. Select workflow run
3. Choose package(s) to publish:
   - `all` (default) - publishes all packages
   - `core`, `cli`, `opencode`, `pi`, `server`, `integrations`, `skelm`
4. Optional: Enable "dry-run" to verify config without publishing
5. Click "Run workflow"

### Method 2: Manual Local Publishing

**Step 1: Set authentication**
```bash
export NODE_AUTH_TOKEN=ghp_your_personal_access_token
```

**Step 2: Build all packages**
```bash
pnpm build
```

**Step 3: Update versions**
```bash
# Option A: Use changesets (recommended for managed versioning)
npx changeset
npx changeset version
npx changeset publish

# Option B: Manual version bump
cd packages/core
npm version 0.3.0  # or patch/minor/major
cd ../cli
npm version 0.3.0
# ... repeat for each package
```

**Step 4: Publish each package**
```bash
cd packages/core
npm publish --registry=https://npm.pkg.github.com/scottgl9 --access=public
cd ../cli
npm publish --registry=https://npm.pkg.github.com/scottgl9 --access=public
# ... repeat for each package
```

## Package List

| Package | Name | Current Version |
|---------|------|-----------------|
| Core runtime | `@skelm/core` | 0.2.0 |
| CLI | `@skelm/cli` | 0.2.0 |
| Opencode backend | `@skelm/opencode` | 0.1.0 |
| Pi backend | `@skelm/pi` | 0.1.0 |
| Server | `@skelm/server` | 0.2.0 |
| Main package | `skelm` | 0.1.0 |
| Integrations | `@skelm/integrations` | (not configured) |

## Versioning Strategy

### Semantic Versioning
- **MAJOR** (0.x.x): Breaking changes (pre-v1, all changes are technically breaking)
- **MINOR** (x.0.x): New features, backward compatible
- **PATCH** (x.x.0): Bug fixes, minor improvements

### Pre-v1 Considerations
Since this is pre-v1 (0.x.x), minor version bumps may include breaking changes. Consider:
- Using patch versions for small changes
- Bumping minor for significant new features
- Documenting breaking changes in release notes

## Installing Published Packages

Users install from GitHub Packages:

```bash
# Add registry to .npmrc
echo "@skelm:registry=https://npm.pkg.github.com/scottgl9" >> ~/.npmrc
echo "//npm.pkg.github.com/scottgl9:_authToken=${NPM_TOKEN}" >> ~/.npmrc

# Install packages
npm install @skelm/core @skelm/cli
# or with pnpm
pnpm add @skelm/core @skelm/cli
```

## Troubleshooting

### "403 Forbidden" or "401 Unauthorized"
- Check `NODE_AUTH_TOKEN` is set correctly
- Verify token has `write:packages` scope
- Ensure token hasn't expired

### "400 Bad Request" - Package already exists
- Check if package version already exists
- Increment version before republishing

### "404 Not Found" - Package not found
- Verify registry URL is correct: `https://npm.pkg.github.com/scottgl9`
- Check package name scope: `@skelm/...`

### Version conflicts
- Clean local state: `pnpm clean`
- Rebuild: `pnpm build`
- Ensure versions are synchronized across packages

## CI/CD Integration

The `publish.yml` workflow:
1. Triggers on release publish or manual dispatch
2. Checks out code
3. Builds and tests all packages
4. Publishes to GitHub Packages
5. Uses `GITHUB_TOKEN` for authentication (automatically has package permissions)

## Security Notes

- **Never commit `NPM_TOKEN` or `GITHUB_TOKEN` to the repository**
- Use GitHub Secrets for CI/CD authentication
- Rotate tokens periodically
- Use minimal scope tokens (only `write:packages` needed for publishing)

## Links

- GitHub Packages docs: https://docs.github.com/en/packages/working-with-a-npm-registry
- Create PAT: https://github.com/settings/tokens
- Package registry: https://npm.pkg.github.com/scottgl9
