'use strict'

const fs = require('fs')
const Feedly = require('../lib/feedly')
const test = require('ava')
const util = require('util')
const unlink = util.promisify(fs.unlink)

const { FEEDLY_SECRET } = process.env
if ((FEEDLY_SECRET == null)) {
  throw new Error(`\
Specify the client secret in the FEEDLY_SECRET environment variable
Find it here: https://groups.google.com/forum/#!forum/feedly-cloud`)
}

const FEED_URL = 'https://www.tbray.org/ongoing/ongoing.atom'
const FEED = `feed/${FEED_URL}`
const CONFIG = `${__dirname}/test_config.json`
const SANDBOX = 'sandbox7'
const SAFE = ['id', 'name']

function pick (o, ...props) {
  const ret = {}
  if (Array.isArray(props[0])) {
    props = props[0]
  }
  for (const p of props) {
    if (o.hasOwnProperty(p)) {
      ret[p] = o[p]
    }
  }
  return ret
}

test('feeds', async t => {
  const f = new Feedly({
    client_id: 'sandbox',
    client_secret: FEEDLY_SECRET,
    base: `http://${SANDBOX}.feedly.com`,
    port: 8080,
    config_file: CONFIG
  })
  t.truthy(f)
  await f.ready
  t.deepEqual(f.options.base, `http://${SANDBOX}.feedly.com`)
  const profile = await f.profile()
  t.truthy(profile)
  await f.updateProfile({
    gender: 'male'
  })
  const prefs = await f.preferences()
  t.truthy(prefs)
  await f.updatePreferences({
    'category/reviews/entryOverviewSize': 0
  })

  await f.updatePreferences({
    'category/reviews/entryOverviewSize': '==DELETE=='
  })
  const tok = await f.refresh()
  t.is(typeof tok, 'string')

  // await f.unsubscribe(FEED)
  let sub = await f.subscribe(FEED)
  t.is(sub.length, 1)
  const sub1 = pick(sub[0], SAFE)
  const subs = await f.subscriptions()
  t.truthy(subs)
  t.truthy(subs.length > 0)
  const sub2 = pick(subs.find(s => s.id === FEED), SAFE)
  t.deepEqual(sub1, sub2)
  await f.unsubscribe(FEED)

  sub = await f.subscribe(FEED_URL, ['testing_foo', 'testing_bar'])
  const fee = await f.feed(FEED)
  t.is(fee.id, FEED)
  const cats = await f.categories()

  const labels = new Set(cats.map(c => c.label))
  t.truthy(labels.has('testing_foo'))
  t.truthy(labels.has('testing_bar'))
  const foo = cats.find(c => c.label === 'testing_foo')
  t.truthy(foo)
  await f.setCategoryLabel(foo.id, 'testing_foo2')
  await f.deleteCategory(foo.id)
  await t.throwsAsync(f.setCategoryLabel(foo.id, 'testing_foo3'))

  // also test callbacks
  await new Promise((resolve, reject) => {
    f.counts((er, counts) => {
      t.falsy(er)
      t.truthy(Array.isArray(counts.unreadcounts))
      t.truthy(counts.unreadcounts.length >= 2)
      resolve()
    })
  })

  const page = await f.stream(FEED)
  const ent = page.ids[0]
  const entries = await f.entry(ent)
  t.truthy(Array.isArray(entries))
  t.truthy(entries.length > 0)
  const { id } = entries[0]
  await f.markEntryRead(id)

  await f.tagEntry(id, 'test_tag_foo')
  const tags = await f.tags()
  t.truthy(tags)
  await f.untagEntries(id, 'test_tag_foo')
  await f.setTagLabel('test_tag_foo', 'test_tag_foo2')
  await f.untagEntries(id, 'test_tag_foo')
  await f.deleteTags('test_tag_foo')
  const short = await f.shorten(id)
  t.truthy(short)
  t.is(typeof short.shortUrl, 'string')

  let contents = await f.contents(FEED)
  t.truthy(Array.isArray(contents.items))
  t.truthy(contents.continuation)
  contents = await f.contents(FEED, contents.continuation)
  t.truthy(contents.items)
  await f.markFeedRead(FEED)
  await f.markCategoryRead('testing_bar')
  const reads = await f.reads()
  t.truthy(reads)
  t.truthy(Array.isArray(reads.entries))
  const results = await f.searchFeeds('arduino')
  t.truthy(results)
  t.truthy(Array.isArray(results.results))
  const userid = f.state.id

  const [entry] = await f.createEntry({
    title: 'NBC\'s reviled sci-fi drama \'Heroes\' may get a second lease',
    author: 'Nathan Ingraham',
    origin: {
      title: 'The Verge -  All Posts',
      htmlUrl: 'http://www.theverge.com/'
    },

    content: {
      direction: 'ltr',
      content: '...html content the user wants to associate with this entry..'
    },

    alternate: [{
      type: 'text/html',
      href: 'http://www.theverge.com/2013/4/17/4236096/nbc-heroes-may-get-a-second-lease-on-life-on-xbox-live'
    }
    ],
    tags: [
      {
        id: `user/${userid}/tag/global.saved`
      },
      {
        id: `user/${userid}/tag/inspiration`,
        label: 'inspiration'
      }
    ],
    keywords: [
      'NBC',
      'sci-fi'
    ]
  })
  const newEnt = await f.entry(entry)
  t.truthy(Array.isArray(newEnt))
  t.truthy(newEnt.length)
  // No DELETE in API

  // cleanup
  for (const c of cats) {
    try {
      await f.deleteCategory(c.id)
    } catch (e) {}
  }

  await f.unsubscribe(FEED)
  await f.logout()
})

test.after(async t => {
  try {
    await unlink(CONFIG)
  } catch (e) {
    console.warn(`Could not unlink '${CONFIG}'`)
  }
})
