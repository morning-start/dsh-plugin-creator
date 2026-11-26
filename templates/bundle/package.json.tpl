{
  "name": {{packageName|json}},
  "version": {{version|json}},
  "private": true,
  "type": "module",
  "description": {{description|json}},
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": {{manifestFiles}},
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
