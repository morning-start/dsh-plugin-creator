name: Release

# Every tag that starts with v cuts a release: the tarball is attached to a GitHub
# Release, and the registry is updated when a token is configured.
#
#   git tag v1.0.0 && git push origin v1.0.0

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: release-$\{{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    env:
      NPM_TOKEN: $\{{ secrets.NPM_TOKEN }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

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
          node -e "const m=require('./package.json'); if(m.private) console.log('private: the registry step will be skipped')"

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

      - name: Publish to the registry
        if: env.NPM_TOKEN != ''
        env:
          NODE_AUTH_TOKEN: $\{{ secrets.NPM_TOKEN }}
        run: |
          if node -e "process.exit(require('./package.json').private === true ? 0 : 1)"; then
            echo "package.json is private: skipping npm publish"
            exit 0
          fi
          npm publish --access public

      - name: Create the GitHub Release
        env:
          GH_TOKEN: $\{{ github.token }}
        run: |
          gh release create "$GITHUB_REF_NAME" "$ASSET" \
            --title "$GITHUB_REF_NAME" \
            --generate-notes
