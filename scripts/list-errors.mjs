#!/usr/bin/env node
/**
 * List every `errors/` card as a table, or one card in detail.
 *
 * The cards are the scannable half of an entry: this is what a skill (or a
 * person under time pressure) reads first, to decide which entry is theirs
 * before opening the body.
 *
 *   node scripts/list-errors.mjs                      # every card of this project
 *   node scripts/list-errors.mjs identity             # cards matching "identity"
 *   node scripts/list-errors.mjs --json               # machine-readable, for matching
 *   node scripts/list-errors.mjs --root ../my-plugin  # another project's errors/
 */

import { loadCards } from '../lib/errors-card.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const rootFlag = args.indexOf('--root')
const root = rootFlag >= 0 ? args[rootFlag + 1] : process.cwd()
const query = args.find((argument, index) => !argument.startsWith('--') && index !== rootFlag + 1)

const cards = await loadCards(root)
if (cards.length === 0) {
  console.error('no errors/ cards found in this directory')
  process.exitCode = 1
} else {
  const needle = query?.toLowerCase()
  const matched = needle === undefined
    ? cards
    : cards.filter(card => [card.id, card.data?.name, card.data?.title, ...(card.data?.matches ?? [])]
      .filter(value => typeof value === 'string')
      .some(value => value.toLowerCase().includes(needle)))

  if (asJson) {
    console.log(JSON.stringify(matched.map(card => ({
      id: card.id,
      file: card.file,
      name: card.data?.name,
      severity: card.data?.severity,
      cause: card.data?.cause,
      matches: card.data?.matches ?? [],
      location: card.data?.location,
      consequence: card.data?.consequence,
      fix: card.data?.fix,
      check: card.data?.check,
    })), null, 2))
  } else if (matched.length === 0) {
    console.log(`no card matches ${JSON.stringify(query)}; the closest entries are:`)
    for (const card of cards) console.log(`  ${card.id} — ${card.data?.name ?? '(no card)'}`)
    process.exitCode = 1
  } else {
    for (const card of matched) {
      console.log(`${card.id}  [${card.data?.severity ?? '?'}]  check: ${card.data?.check ?? 'none'}`)
      console.log(`  名称  ${card.data?.name ?? '—'}`)
      console.log(`  原因  ${card.data?.cause ?? '—'}`)
      console.log(`  位置  ${card.data?.location ?? '—'}`)
      console.log(`  后果  ${card.data?.consequence ?? '—'}`)
      console.log(`  修法  ${card.data?.fix ?? '—'}`)
      if ((card.data?.matches ?? []).length > 0) console.log(`  原文  ${card.data.matches.map(text => JSON.stringify(text)).join(' · ')}`)
      console.log(`  正文  ${card.file}`)
      console.log('')
    }
  }
}