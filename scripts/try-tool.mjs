// Exercise the tool without a Host: mount the plugin on a stub context, then run
// the registered tool against a directory. Plain node is enough (built-ins only).
import { apply } from '../tools/index.js'

const registered = new Map()
const ctx = {
  effect: (body) => body(),
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
}

apply(ctx)
if (!registered.has('dsh_plugin_check')) throw new Error('dsh_plugin_check was not registered')

const tool = registered.get('dsh_plugin_check')
const target = process.argv[2] ?? '.'
const value = await tool.execute({ path: target })
console.log(tool.output.render({}, value)[0].text)
console.log(`\nok=${value.ok} checks=${value.checks.length}`)
