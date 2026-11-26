# {{packageName}} — bundle patch layer.
#
# One inserted Host row plus a skill provider. No agent preset is patched, so
# installing this bundle leaves every existing preset's composition unchanged.
#
# Note what the skill provider does and does not scope: it scans only this
# package's skills/ directory, but the skill catalog is deployment-wide, so
# every preset's sessions will list the skill. To scope it to one preset, move
# the provider row into that preset's plugin list instead of this layer.

- insert:
    - id: {{rowId}}
      name: '{{packageName}}'
    - id: {{rowId}}-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: {{rowId}}-skills
        includeDefaultRoots: false
        customSkillDirs:
          - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('{{packageName}}/package.json')), 'skills')
