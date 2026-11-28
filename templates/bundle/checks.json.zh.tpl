{
  "version": 1,
  "description": "Project checks for {{packageName}}. Run them with the dsh_project_check tool, or with scripts/check-project.mjs from dsh-plugin-creator. Rules are data; the rule reference is that package's docs/CHECKS.md.",
  "rules": [
    {
      "id": "docs:links",
      "type": "doc-links",
      "exclude": [
        "\\.dsh-memory/"
      ]
    },
    {
      "id": "locale:parity",
      "type": "locale-parity",
      "files": [
        "locale/en.json",
        "locale/zh.json"
      ]
    },
    {
      "id": "bundle:entry",
      "type": "file-exists",
      "path": "index.js"
    },
    {
      "id": "bundle:patch",
      "type": "json-field",
      "path": "package.json",
      "field": "dsh.bundle.patch",
      "equals": "./cordis.patch.yml"
    },
    {
      "id": "bundle:files-listed",
      "type": "files-listed",
      "manifest": "package.json",
      "exclude": [
        ".gitignore",
        ".gitattributes",
        "checks.json",
        ".github/workflows/release.yml"
      ]
    },
    {
      "id": "session:messages",
      "type": "session-message-identity",
      "root": "."
    }, {
      "id": "release:pipeline",
      "type": "release-pipeline",
      "workflow": ".github/workflows/release.yml"
    },
    {
      "id": "manifest:dsh-shape",
      "type": "manifest-shape",
      "manifest": "package.json"
    },
    {
      "id": "inject:declared",
      "type": "undeclared-inject",
      "root": "."
    },
    {
      "id": "depends:bare-name",
      "type": "bare-name-dependency",
      "root": "."
    },
    {
      "id": "session:custom-event",
      "type": "custom-session-event",
      "root": "."
    }
  ]
}
