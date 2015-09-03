fs = require 'fs'
http = require 'http'
path = require 'path'
url = require 'url'

open = require 'open'
q = require 'q'
request = require 'request'
untildify = require 'untildify'

utils = require './utils'

# @nodoc
_normalizeTag = (str, userid) ->
  if !str.match(/^user\//)
    str = "user/#{userid}/tag/#{str}"
  encodeURIComponent(str)

# Talk to the Feedly API.
#
# All methods will ensure a valid authentication dance has occurred, and perform
# the dance if necessary.
#
# All of the methods that take a callback also return
# a [Q](https://github.com/kriskowal/q) promise - the callback is therefore
# optional.
#
# WARNING: by default, this class stores state information such
# as your access token in ~/.feedly by default.
module.exports = class Feedly
  # @param options [Object] options for the API
  # @option options [int] port TCP port to listen on for callbacks.
  #   (default: 0, which means to pick a random port)
  # @option options [String] base The root URL of the API.
  #   (default: 'http://cloud.feedly.com')
  # @option options [String] config_file File in which state information such
  #   as the access token and refresh tokens are stored.  Tildes are expanded
  #   as needed.  (default: '~/.feedly')
  # @option options [String] html_file File that contains the HTML to give to
  #   the web browser after it is redirected to the one-shot web server that
  #   we'll be running.  (default: '../html/index.html')
  # @option options [String] html_text If html_file is null or the file can't
  #   be read, use this text instead.  (default: 'No HTML found')
  # @option options [int] slop If there is less than this amount of time (in
  #   milliseconds) between now and the expiration of the access token, refresh
  #   the token.  (default: 3600000)
  # @option options [String] client_id The API client ID.  (REQUIRED)
  # @option options [String] client_secret The API client Secret.  (REQUIRED)
  constructor: (options) ->
    @options = utils.extend
      port: 0
      base: 'http://cloud.feedly.com'
      config_file: '~/.feedly'
      html_file: path.join(__dirname, '../html/index.html')
      html_text: 'No HTML found'
      slop: 3600000
      client_id: null
      client_secret: null
    , options
    @options.config_file = untildify @options.config_file
    @options.html_file = untildify @options.html_file
    if !@options.client_id? or !@options.client_secret?
      throw new Error "client_id and client_secret required"
    @state = {}

    # allSettled ignores errors
    @ready = q.allSettled [@_loadConfig(), @_loadHTML()]

  # @nodoc
  _loadConfig: ->
    unless @options.config_file? then return null

    q.nfcall fs.readFile, @options.config_file
    .then (data) =>
      @state = try
        s = JSON.parse(data)
        if s.expires?
          s.expires = new Date(s.expires)
        s
      catch er
        @state = {}
    , (er) ->
      @state = {}

  # @nodoc
  _loadHTML: ->
    unless @options.html_file? then return null

    q.nfcall fs.readFile, @options.html_file
    .then (data) =>
      @options.html_text = data.toString('utf8')
      true

  # @nodoc
  _save: () ->
    if @options.config_file?
      q.nfcall fs.writeFile, @options.config_file, JSON.stringify(@state)
    else
      q.resolve()

  # @nodoc
  _validToken: () ->
    return (@state.access_token?) and
           (@state.refresh_token?) and
           (@state.expires?) and
           (@state.expires > new Date())

  # @nodoc
  _getAuth: () ->
    @ready.then ()=>
      switch
        when !@_validToken()
          # do full auth, return promise
          @_auth()
        when (@state.expires - new Date()) < @options.slop
          # refresh, return promise
          @_refresh()
        else
          q.resolve @state.access_token

  # @nodoc
  _auth: () ->
    [addr, result] = utils.qserver(@options.port, @options.html_text)
    u = url.parse @options.base
    addr.then (cb_url) =>
      u.pathname = '/v3/auth/auth'
      u.query =
        response_type: 'code'
        client_id: @options.client_id
        redirect_uri: cb_url
        scope: 'https://cloud.feedly.com/subscriptions'
      open url.format(u)

      result.spread (results, body) =>
        if results.error?
          return q.reject(results.error)
        @_getToken results.code, cb_url

  # @nodoc
  _getToken: (code, redirect) ->
    u = url.parse @options.base
    u.pathname = '/v3/auth/token'

    utils.qrequest
      method: 'POST'
      uri: url.format(u)
      body:
        code: code
        client_id: @options.client_id
        client_secret: @options.client_secret
        grant_type: 'authorization_code'
        redirect_uri: redirect # Why is this needed?!
    .then (body) =>
      @state = utils.extend @state, body
      @state.expires = new Date(new Date().getTime() + (body.expires_in * 1000))
      @_save()
      @state.access_token

  # @nodoc
  _refresh: () ->
    u = url.parse @options.base
    u.pathname = '/v3/auth/token'
    u.query =
      refresh_token: @state.refresh_token
      client_id: @options.client_id
      client_secret: @options.client_secret
      grant_type: 'refresh_token'

    utils.qrequest
      method: 'POST'
      uri: url.format(u)
    .then (body) =>
      @state = utils.extend @state, body
      @state.expires = new Date(new Date().getTime() + (body.expires_in * 1000))
      @_save()
      @state.access_token

  # @nodoc
  _request: (callback, path, method='GET', body=null)->
    u = url.parse @options.base
    u.pathname = path
    @_getAuth().then (auth)->
      utils.qrequest
        method: method
        uri: url.format(u)
        headers:
          Authorization: "OAuth #{auth}"
        body: body
        callback: callback

  # @nodoc
  _requestURL: (callback, path, method='GET', body=null)->
    u = url.parse @options.base
    u.pathname = path
    u.query = body
    @_getAuth().then (auth)->
      utils.qrequest
        method: method
        uri: url.format(u)
        headers:
          Authorization: "OAuth #{auth}"
        callback: callback

  # @nodoc
  _normalizeTags: (ary) ->
    userid = @state.id
    ary.map (s) ->
      _normalizeTag s, userid

  # @nodoc
  _normalizeCategories: (ary) ->
    userid = @state.id
    ary.map (cat) ->
      if !cat.match /^user\//
        cat = "user/#{userid}/category/#{cat}"
      cat

  # Refresh the auth token manually.  If the current refresh token is not
  # valid, authenticate again.
  #
  # @param cb [function(error, authToken)] Optional callback
  # @return [promise(String)] new auth token
  refresh: (cb) ->
    @ready.then () =>
      p = if @_validToken()
        @_refresh()
      else
        @_auth()
      p.nodeify cb

  # Discard all tokens
  #
  # @param cb [function(error)] Optional callback
  # @return [promise()] logout finished
  logout: (cb) ->
    @ready.then () =>
      u = url.parse @options.base
      u.pathname = '/v3/auth/token'
      u.query =
        refresh_token: @state.refresh_token
        client_id: @options.client_id
        client_secret: @options.client_secret
        grant_type: 'revoke_token'

      utils.qrequest
        method: 'POST'
        uri: url.format(u)
      .then (body) =>
        delete @state.access_token
        delete @state.expires
        delete @state.plan
        delete @state.provider
        delete @state.refresh_token
        delete @state.token_type
        @state = utils.extend @state, body
        @_save()
      .nodeify cb

  # Fetch the list of categories
  #
  # @param cb [function(error, Array(Category))] Optional callback
  # @return [promise(Array(Category))] list of categories
  categories: (cb) ->
    @_request cb, '/v3/categories'

  # Set the label for a category.
  #
  # @param id [String] the category to modify
  # @param label [String] the new label
  # @param cb [function(error)] Optional callback
  # @return [promise()] complete
  setCategoryLabel: (id, label, cb)->
    @_request cb, "/v3/categories/#{encodeURIComponent(id)}", 'POST',
      label: label

  # Delete a category.
  #
  # @param id [String] the category to delete
  # @param cb [function(error)] Optional callback
  # @return [promise()] complete
  deleteCategory: (id, cb)->
    @_request cb, "/v3/categories/#{encodeURIComponent(id)}", 'DELETE'

  # Get one or more entries
  #
  # @param id [String or Array(String)] the entry or entries to retrieve
  # @param cb [function(error, promise(Entry) or promise(Array(Entry)))]
  #   Optional callback
  # @return [promise(Entry) or promise(Array(Entry))] the entry(s)
  entry: (id, cb)->
    if Array.isArray(id)
      @_request cb, "/v3/entries/.mget", 'POST', id
    else
      @_request cb, "/v3/entries/#{encodeURIComponent(id)}"

  # Create an entry.  Thiss call is useful to inject entries not coming from a
  # feed, into a user’s account. The entries created will only be available
  # through the tag streams of the respective tags passed.
  #
  # @param entry [Entry] See the [Feedly API docs]
  #   (http://developer.feedly.com/v3/entries/#create-and-tag-an-entry)
  #   for more information.
  # @param cb [function(error)] Optional callback
  # @return [promise()] complete
  createEntry: (entry, cb) ->
    @_request cb, '/v3/entries/', 'POST', entry

  # Get meta-data about a feed or list of feeds
  #
  # @param id [String or Array(String)] the ID or list of IDs of the feed(s)
  # @param cb [function(error, Feed)] Optional callback
  # @return [promise(Feed)]
  feed: (id, cb) ->
    if Array.isArray(id)
      @_request cb, '/v3/feeds/.mget', 'POST', id
    else
      @_request cb, "/v3/feeds/#{encodeURIComponent(id)}"

  # Get unread counts.  In theory, newerThan and streamId can
  # be used to reduce the counts that are returned, but I didn't see evidence
  # of that in practice.
  #
  # @param autorefresh [Boolean] lets the server know if this is a background
  #   auto-refresh or not. In case of very high load on the service, the server
  #   can deny access to background requests and give priority to user facing
  #   operations. (optional)
  # @param newerThan [Date] timestamp used as a lower time limit, instead of
  #   the default 30 days (optional)
  # @param streamId [String]  A user or system category can be passed to
  #   restrict the unread count response to feeds in this category. (optional)
  # @param cb [function(error, Counts)] optional callback
  # @return [promise(Counts)]
  counts: (autorefresh, newerThan, streamId, cb) ->
    if typeof(autorefresh) == 'function'
      [cb, autorefresh, newerThan, streamId] = [autorefresh, null, null, null]
    else if typeof(newerThan) == 'function'
      [cb, newerThan, streamId] = [newerThan, null, null]
    else if typeof(streamId) == 'function'
      [cb, streamId] = [streamId, null]
    input = {}
    found = false
    if autorefresh?
      input.autorefresh = autorefresh
      found = true
    if newerThan?
      input.newerThan = newerThan.getTime()
      found = true
    if streamId?
      input.streamId = streamId
      found = true
    unless found then input = null
    @_request cb, '/v3/markers/counts', 'GET', input

  # Mark articles as read.
  #
  # @param ids [Array(String)] article IDs to mark read
  # @param cb [function(error)] optional callback
  markEntryRead: (ids, cb) ->
    if typeof(ids) == 'string'
      ids = [ids]
    @_request cb, '/v3/markers', 'POST',
      entryIds: ids
      type: 'entries'
      action: 'markAsRead'

  # Mark articles as unread.
  #
  # @param ids [Array(String)] article IDs to mark unread
  # @param cb [function(error)] optional callback
  markEntryUnread: (ids, cb) ->
    if typeof(ids) == 'string'
      ids = [ids]
    @_request cb, '/v3/markers', 'POST',
      entryIds: ids
      type: 'entries'
      action: 'keepUnread'

  # Mark feed(s) as read.
  #
  # @param id [Array(String)] feed ID to mark read
  # @param since [String or Date] optional last entry ID read or timestamp
  #   last read
  # @param cb [function(error)] optional callback
  markFeedRead: (ids, since, cb) ->
    if typeof(ids) == 'string'
      ids = [ids]
    if typeof(since) == 'function'
      [cb, since] = [since, null]

    body =
      feedIds: ids
      type: 'feeds'
      action: 'markAsRead'
    if typeof(since) == 'Date'
      body.asOf = since.getTime()
    else if typeof(since) == 'Date'
      body.lastReadEntryId = since

    @_request cb, '/v3/markers', 'POST', body

  # Mark category(s) as read.
  #
  # @param id [Array(String)] feed ID to mark read
  # @param since [String or Date] optional last entry ID read or timestamp
  #   last read
  # @param cb [function(error)] optional callback
  markCategoryRead: (ids, since, cb) ->
    if typeof(ids) == 'string'
      ids = [ids]
    if typeof(since) == 'function'
      [cb, since] = [since, null]

    @ready.then =>
      body =
        categoryIds: @_normalizeCategories(ids)
        type: 'categories'
        action: 'markAsRead'
      if typeof(since) == 'Date'
        body.asOf = since.getTime()
      else if typeof(since) == 'Date'
        body.lastReadEntryId = since

      @_request cb, '/v3/markers', 'POST', body

  # Get the latest read operations (to sync local cache).
  #
  # @param newerThan [Date] Optional start date
  # @param cb [function(error, Reads)] Optional callback
  # @return [promise(Reads)]
  reads: (newerThan, cb) ->
    if typeof(newerThan) == 'function'
      [cb, newerThan] = [newerThan, null]
    input = null
    if newerThan?
      input =
        newerThan: newerThan.getTime()
    @_request cb, '/v3/markers/reads', 'GET', input

  # Get the latest tagged entry ids
  #
  # @param newerThan [Date] Optional start date
  # @param cb [function(error, Tags)] Optional callback
  # @return [promise(Tags)]
  tags: (newerThan, cb) ->
    if typeof(newerThan) == 'function'
      [cb, newerThan] = [newerThan, null]
    input = null
    if newerThan?
      input =
        newerThan: newerThan.getTime()
    @_request cb, '/v3/markers/tags', 'GET', input

  # Get the current user's preferences
  #
  # @param cb [function(error, Prefs)] Optional callback
  # @return [promise(Prefs)]
  preferences: (cb) ->
    @_request cb, '/v3/preferences'

  # Update the preferences of the user
  #
  # @param prefs [Object] the preferences to update, use "==DELETE==”
  #   as the value in order to delete a preference.
  # @param cb [function(error, Prefs)] Optional callback
  # @return [promise(Prefs)]
  updatePreferences: (prefs, cb) ->
    if !prefs? or (typeof(prefs) == 'function')
      throw new Error("prefs required")
    @_request cb, '/v3/preferences', 'POST', prefs

  # Get the current user's profile
  #
  # @param cb [function(error, Profile)] Optional callback
  # @return [promise(Profile)]
  profile: (cb) ->
    @_request cb, '/v3/profile'

  # Update the profile of the user
  #
  # @param profile [Object] the profile to update
  # @param cb [function(error, Profile)] Optional callback
  # @return [promise(Profile)]
  updateProfile: (profile, cb) ->
    if !profile? or (typeof(profile) == 'function')
      throw new Error("profile required")

    @_request cb, '/v3/profile', 'POST', profile

  # Find feeds based on title, url or #topic
  #
  # @param query [string] the string to search for
  # @param results [int] the maximum number of results to return (default: 20)
  # @param cb [function(error, Array(Feeds))] Optional callback
  # @return [promise(Array(Feeds))]
  searchFeeds: (query, results=20, cb) ->
    if !query? or (typeof(query) == 'function')
      throw new Error("query required")

    @_requestURL cb, '/v3/search/feeds', 'GET',
      query: query
      n: results

  # Create a shortened URL for an entry.  The short URL is unique for a given
  # entry id, user and application.
  #
  # @param entry [string] The entry ID to shorten
  # @param cb [function(error, Shortened)] Optional callback
  # @return [promise(Shortened)]
  shorten: (entry, cb) ->
    if !entry? or (typeof(entry) == 'function')
      throw new Error("entry required")

    @_requestURL cb, '/v3/shorten/entries', 'GET',
      entryId: entry

  # Get a list of entry ids for a specific stream.
  #
  # @param id [string] the id of the stream
  # @param options [string|object]  a continuation id is used to page
  #        or an object with stream request parameters
  # @param cb [function(error, Array(Page))] Optional callback
  # @return [promise(Array(Page))]
  stream: (id, options, cb) ->
    input = switch typeof(options)
      when 'function'
        cb = options
        {}
      when 'string'
        continuation: options
      when 'object'
        options
      else
        {}
    @_requestURL cb, "/v3/streams/#{encodeURIComponent(id)}/ids", 'GET', input

  # Get the content of a stream
  #
  # @param id [string] the id of the stream
  # @param continuation [string]  a continuation id is used to page
  # @param cb [function(error, Array(Page))] Optional callback
  # @return [promise(Array(Page))]
  contents: (id, continuation, cb) ->
    input = {}
    if continuation?
      input.continuation = continuation
    @_request cb, "/v3/streams/#{encodeURIComponent(id)}/contents", 'GET', input

  # Get the user’s subscriptions
  #
  # @param cb [function(error, Array(Subscription))] Optional callback
  # @return [promise(Array(Subscription))]
  subscriptions: (cb) ->
    @_request cb, '/v3/subscriptions'

  # Subscribe to a feed
  #
  # @param url [string] the URL of the feed to subscribe to
  # @param categories [string or Array(string)] category(s) for the subscription
  # @param cb [function(error)] Optional callback
  # @return [promise()]
  subscribe: (url, categories, cb)->
    if !url.match(/^feed\//)
      url = "feed/#{url}"
    if typeof(categories) == 'function'
      [cb, categories] = [categories, null]
    input =
      id: url

    @ready.then =>
      if categories?
        if !Array.isArray(categories)
          categories = [categories]
        userid = @state.id
        categories = categories.map (c) ->
          if typeof(c) == 'string'
            m = c.match /^user\/[^/]+\/(.*)/
            name = null
            id = null
            if !m
              name = c
              id = "user/#{userid}/category/#{c}"
            else
              name = m[1]
              id = c
            c =
              id: id
              name: name
          c
        input.categories = categories

      # TODO: add support for title and categories
      @_request cb, '/v3/subscriptions', 'POST', input

  # Unsubscribe from a feed
  #
  # @param id [string] the ID of the feed to unsubscribe from
  # @param cb [function(error)] Optional callback
  # @return [promise()]
  unsubscribe: (id, cb)->
    @_request cb, "/v3/subscriptions/#{encodeURIComponent(id)}", 'DELETE'

  # Tag an existing entry or entries
  #
  # @param entry [string or Array(string)] the entry(s) to tag
  # @param tags [string Array(string)] tag(s) to apply to the entry
  # @param cb [function(error)] Optional callback
  # @return [promise()]
  tagEntry: (entry, tags, cb) ->
    @ready.then () =>
      userid = @state.id
      if typeof(tags) == 'string'
        tags = [tags]
      tags = @_normalizeTags tags
      if Array.isArray(entry)
        @_request cb, "/v3/tags/#{tags.join(',')}", 'PUT',
          entryIds: entry
      else
        @_request cb, "/v3/tags/#{tags.join(',')}", 'PUT',
          entryId: entry

  # Change a tag label
  #
  # @param tag [string] the tag to modify
  # @param label [string] new label for the tag
  # @param cb [function(error)] Optional callback
  # @return [promise()]
  setTagLabel: (tag, label, cb) ->
    @ready.then () =>
      tag = _normalizeTag tag, @state.id
      @_request cb, "/v3/tags/#{tag}", 'POST',
        label: label

  # Untag entries
  #
  # @param entries [string or Array(string)] the ID(s) of the entries to modify
  # @param tags [string or Array(string)] the tag(s) to remove
  # @param cb [function(error)] Optional callback
  # @return [promise()]
  untagEntries: (entries, tags, cb) ->
    @ready.then () =>
      if !Array.isArray(entries)
        entries = [entries]
      entries = entries.map (e)->
        encodeURIComponent(e)

      if !Array.isArray(tags)
        tags = [tags]
      tags = @_normalizeTags tags
      @_request cb, "/v3/tags/#{tags.join(',')}/#{entries.join(',')}", 'DELETE'

  # Delete tags
  #
  # @param tags [string or Array(string)] the tag(s) to remove
  # @param cb [function(error)] Optional callback
  # @return [promise()]
  deleteTags: (tags, cb) ->
    @ready.then () =>
      if !Array.isArray(tags)
        tags = [tags]
      tags = @_normalizeTags tags
      @_request cb, "/v3/tags/#{tags.join(',')}", 'DELETE'
