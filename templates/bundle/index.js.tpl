/**
 * {{title}}
 *
 * {{description}}
 *
 * This Host row registers a tool on the deployment context, so every preset's
 * sessions see it. To expose it in one preset only, remove the registration
 * below and mount `./tools/example.js` from that preset's plugin list instead;
 * the comment in cordis.patch.yml points at a worked example.
 */
import { exampleTool } from './tools/example.js'

export const name = '{{rowId}}'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(exampleTool), '{{rowId}}/{{toolName}}')
}
