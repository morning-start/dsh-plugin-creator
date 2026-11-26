# {{packageName}} — bundle patch layer.
#
# One inserted Host row. No agent preset is patched, so installing this bundle
# leaves every existing preset's composition unchanged.
#
# To expose this plugin's tools in exactly one preset instead of everywhere,
# override that preset's declaration in this file and append a row naming this
# package. dsh-plugin-creator's cordis.patch.yml is a worked example: it
# restates the shipped preset list and appends its own rows.

- insert:
    - id: {{rowId}}
      name: '{{packageName}}'
