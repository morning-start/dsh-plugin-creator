name: Release

# Tag-driven release for a DSH plugin package. Copy this file to another plugin
# as-is: every step works with nothing but package.json, and the ones that need
# this repository's own tooling are skipped when that tooling is absent.
#
#   git tag v1.0.0 && git push origin v1.0.0
#
# Publishing credential, in order of preference:
#
#   1. NPM_TOKEN — if the repository has that secret, it is used. Explicit, and
#      works on any npm account, including ones where OIDC is not set up.
#   2. OIDC trusted publishing — with no secret, `npm publish` exchanges this
#      job's identity for a short-lived credential. Nothing long-lived sits in
#      the repository.
#
# A missing token never skips the step: the step always runs and picks whichever
# credential exists, so "no secret configured" cannot quietly mean "no publish".
#
# One-time setup, only needed for option 2 — npmjs.com -> the package -> Settings
# -> Trusted Publisher:
#
#   Provider          GitHub Actions
#   Repository owner  <owner>
#   Repository name   <repo>
#   Workflow filename  release.yml      (renaming this file breaks publishing)
#   Environment       (leave empty)
#
# Until that is saved, a tokenless publish fails to authenticate — it does not
# silently succeed.

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write
  # Trusted publishing + provenance: the registry checks this OIDC identity
  # against the repository, so the tarball carries a signed statement of where
  # it was built — and the publish credential is minted per run.
  id-token: write

concurrency:
  # Every release shares one group on purpose. Keying on the ref would let two
  # tags pushed together publish in parallel, and the second one repoints the
  # `latest` dist-tag at the older version.
  group: release
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          # Trusted publishing needs a supported LTS; the package has no
          # dependencies, so any supported Node runs the checks.
          node-version: lts/*
          registry-url: https://registry.npmjs.org

      - name: npm must be new enough for trusted publishing
        run: |
          npm install -g npm@latest
          npm --version
          node -e "const v=require('child_process').execSync('npm --version').toString().trim(); const [a,b]=v.split('.').map(Number); if (a<11||(a===11&&b<5)) { console.error('npm '+v+' cannot use trusted publishing; 11.5.1 or newer is required'); process.exit(1) }"

      - name: The tag must match package.json
        run: |
          version=$(node -p "require('./package.json').version")
          tag="${GITHUB_REF_NAME#v}"
          if [ "$version" != "$tag" ]; then
            echo "::error::tag $GITHUB_REF_NAME does not match package.json version $version"
            exit 1
          fi
          echo "releasing $version"

      - name: The package must be installable
        run: |
          node -e "const m=require('./package.json'); if(!m.dsh?.bundle?.patch) { console.error('no dsh.bundle.patch: dsh plugin add would refuse this'); process.exit(1) }"

      # Optional gate: present only in repositories that ship this toolkit's
      # scripts. A plain plugin package has no scripts/ and skips both steps.
      - name: Readiness check (when the toolkit is present)
        if: hashFiles('scripts/release.mjs') != ''
        run: node scripts/release.mjs check .

      - name: Suites (when the toolkit is present)
        if: hashFiles('scripts/release.mjs') != ''
        run: |
          for suite in try-tool try-sandbox try-checks try-audit try-generate try-release try-market try-adopt; do
            [ -f "scripts/$suite.mjs" ] && node "scripts/$suite.mjs"
          done
          [ -f scripts/check-project.mjs ] && node scripts/check-project.mjs .

      - name: Pack
        run: |
          npm pack
          # Marketplace entries point at releases/latest/download/<name>.tgz, where
          # the tag resolves at request time but the filename is literal. A version
          # in the asset name would 404 at the next release.
          asset=$(node -p "require('./package.json').name.replace(/^@[^/]+\//, '')")
          mkdir -p dist
          cp ./*.tgz "dist/$asset.tgz"
          echo "ASSET=dist/$asset.tgz" >> "$GITHUB_ENV"

      # Credential, in order of preference:
      #   1. NPM_TOKEN — if this repository has the secret, use it. Explicit and
      #      works on any account.
      #   2. OIDC trusted publishing — no secret at all: npm mints a short-lived
      #      credential from this job's identity. Needs a Trusted Publisher
      #      configured on npmjs.com for this package.
      # The step always runs; a missing token must not be able to silence it.
      - name: Publish to the registry
        env:
          NPM_TOKEN: $\{{ secrets.NPM_TOKEN }}
        run: |
          if node -e "process.exit(require('./package.json').private === true ? 0 : 1)"; then
            echo "package.json is private: skipping npm publish"
            echo "SKIPPED_PUBLISH=1" >> "$GITHUB_ENV"
            exit 0
          fi
          name=$(node -p "require('./package.json').name")
          version=$(node -p "require('./package.json').version")
          if [ -n "$NPM_TOKEN" ]; then
            echo "publishing with the NPM_TOKEN secret"
            export NODE_AUTH_TOKEN="$NPM_TOKEN"
          else
            # setup-node wrote `_authToken=${NODE_AUTH_TOKEN}` into .npmrc. With the
            # variable unset npm must fall through to trusted publishing, so drop
            # the line rather than hand it an empty credential.
            echo "no NPM_TOKEN secret: publishing with OIDC trusted publishing"
            if [ -f "${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}" ]; then
              sed -i '/_authToken/d' "${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
            fi
          fi
          # No pipe around `npm publish`: a pipeline reports the last command's
          # status, so `npm publish | tee` succeeds when publish fails. Capture
          # the output, then decide on the real exit code.
          set +e
          npm publish --provenance --access public > /tmp/publish.log 2>&1
          status=$?
          set -e
          cat /tmp/publish.log
          if [ "$status" -eq 0 ]; then
            echo "published $name@$version"
            exit 0
          fi
          if grep -qi 'cannot publish over the previously published versions' /tmp/publish.log; then
            echo "::error::$name@$version is already in the registry. A published version cannot be overwritten: bump package.json and push a NEW tag."
          elif [ -n "$NPM_TOKEN" ]; then
            echo "::error::publishing with the NPM_TOKEN secret failed; the token may be expired or lack publish rights for $name. See the npm output above."
          else
            echo "::error::the registry did not accept this job's OIDC identity. Either add an NPM_TOKEN secret, or configure a Trusted Publisher on npmjs.com -> the package -> Settings -> Trusted Publisher -> GitHub Actions with workflow filename release.yml. Until one of those exists npm treats the publish as anonymous and answers 404."
          fi
          exit 1
            echo "::error::publishing $name@$version failed; see the npm output above."
          fi
          exit 1

      - name: Create the GitHub Release
        env:
          GH_TOKEN: $\{{ github.token }}
        run: |
          # Idempotent: a rerun (or a tag pushed twice) must not fail here.
          gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1 \
            && echo "release $GITHUB_REF_NAME already exists" \
            || gh release create "$GITHUB_REF_NAME" "$ASSET" --title "$GITHUB_REF_NAME" --generate-notes

      # After the release on purpose: the registry can take longer than any
      # reasonable wait to serve a brand-new version, and that lag must not hold
      # up the tarball people install from. Read-only (`npm view`), so it needs
      # no credential.
      - name: Registry propagation (advisory)
        if: env.SKIPPED_PUBLISH != '1' && hashFiles('scripts/release.mjs') != ''
        continue-on-error: true
        run: node scripts/release.mjs verify . --version "${GITHUB_REF_NAME#v}" --wait 600