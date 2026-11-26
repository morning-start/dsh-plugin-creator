/**
 * Host half of `dsh-plugin-powerful`.
 *
 * The capability half lives in `./tools`, which the bundle patch mounts inside
 * the Creator-mode preset (`preset-cordis`) only. This row exists so the bundle
 * has a stable Host-level identity in Plugin Manager, and it is the future home
 * of Host-wide services that the preset-scoped tools need to share.
 *
 * It registers nothing today, so loading this bundle adds no Host-level tool,
 * prompt section, or service to any other preset. Anything added here later must
 * be registered inside `ctx.effect(...)` so unloading the bundle removes it.
 */

export const name = 'powerful'

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  void ctx
}
