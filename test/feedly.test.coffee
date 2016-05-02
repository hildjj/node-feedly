try
  require('source-map-support').install()
catch

fs = require 'fs'

request = require 'request'
q = require 'q'
Feedly = require '../lib/feedly'

FEEDLY_SECRET = process.env.FEEDLY_SECRET
if !FEEDLY_SECRET?
  throw new Error """
Specify the client secret in the FEEDLY_SECRET environment variable
Find it here: https://groups.google.com/forum/#!forum/feedly-cloud
"""

FEED_URL = 'http://blog.foodnetwork.com/fn-dish/feed/'
FEED = "feed/#{FEED_URL}"
CONFIG = "#{__dirname}/test_config.json"

module.exports =
  feeds: (test)->
    f = new Feedly
      client_id: 'sandbox'
      client_secret: FEEDLY_SECRET
      base: 'http://sandbox.feedly.com'
      port: 8080
      config_file: CONFIG

    test.ok f
    test.equals f.options.base, 'http://sandbox.feedly.com'
    f.profile()
    .then (prof) ->
      test.ok prof
      f.updateProfile
        gender: 'male'
    .then ->
      f.preferences()
    .then (prefs) ->
      test.ok prefs
      f.updatePreferences
        "category/reviews/entryOverviewSize": 0
    .then ->
      f.updatePreferences
        "category/reviews/entryOverviewSize": "==DELETE=="
    .then ->
      f.refresh()
    .then ->
      f.subscribe FEED
    .then ->
      f.subscriptions()
    .then (subs) ->
      test.ok subs
      sub = subs.find (s) ->
        return s.id == FEED
      test.ok sub
    .then ->
      test.ok true
      f.unsubscribe FEED
    .then ->
      test.ok true
      f.subscribe FEED_URL, ['testing_foo', 'testing_bar']
    .then ->
      test.ok true
      f.feed FEED
    .then (fee) ->
      test.equals fee.id, FEED
      f.categories()
    .then (cats) ->
      test.ok Array.isArray(cats)
      test.ok cats.length >= 2
      foo = cats.find (c) ->
        c.label == 'testing_foo'
      test.ok foo?
      f.setCategoryLabel foo.id, 'testing_foo2'
      .then ->
        f.deleteCategory foo.id
    .then ->
      f.counts()
    .then (counts)->
      test.ok Array.isArray(counts.unreadcounts)
      test.ok counts.unreadcounts.length >= 2
      f.stream FEED
    .then (page) ->
      ent = page.ids[0]
      f.entry ent
    .then (entries) ->
      test.ok entries?
      test.ok entries.length > 0
      id = entries[0].id
      f.markEntryRead id
      .then ->
        f.markEntryUnread id
      .then ->
        f.tagEntry id, 'test_tag_foo'
      .then ->
        f.tags()
      .then (tags) ->
        test.ok tags
        f.untagEntries id, 'test_tag_foo'
      .then ->
        f.setTagLabel 'test_tag_foo', 'test_tag_foo2'
      .then ->
        f.untagEntries id, 'test_tag_foo'
      .then ->
        f.deleteTags 'test_tag_foo'
      .then ->
        f.shorten id
      .then (short) ->
        test.ok short
        test.ok typeof(short.shortUrl) == 'string'
    .then ->
      f.contents FEED
    .then (contents) ->
      test.ok contents
      test.ok Array.isArray(contents.items)
      test.ok contents.continuation
      f.contents FEED, contents.continuation
    .then (contents) ->
      test.ok contents
      f.markFeedRead FEED
    .then ->
      f.markCategoryRead 'testing_bar'
    .then ->
      f.reads()
    .then (reads) ->
      test.ok reads
      test.ok Array.isArray(reads.entries)
    .then ->
      f.searchFeeds 'arduino'
    .then (results) ->
      test.ok results
      test.ok Array.isArray(results.results)
      f.unsubscribe FEED
    .then ->
      userid = f.state.id
      f.createEntry
        title: "NBC's reviled sci-fi drama 'Heroes' may get a second lease"
        author: "Nathan Ingraham"
        origin:
          title: "The Verge -  All Posts"
          htmlUrl: "http://www.theverge.com/"

        content:
          direction: "ltr"
          content: "...html content the user wants to associate with this entry.."

        alternate: [
          type: "text/html"
          href: "http://www.theverge.com/2013/4/17/4236096/nbc-heroes-may-get-a-second-lease-on-life-on-xbox-live"
        ]
        tags: [
          {
            id: "user/#{userid}/tag/global.saved"
          }
          {
            id: "user/#{userid}/tag/inspiration"
            label: "inspiration"
          }
        ]
        keywords: [
          "NBC"
          "sci-fi"
        ]
    .then ->
      f.logout()
    .then ->
      q.nfcall fs.unlink, CONFIG
    .then ->
      test.done()
    , (er) ->
      console.log 'ERROR', er, er.stack
      test.ifError er
