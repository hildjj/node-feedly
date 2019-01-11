'use strict'

const fs = require('fs')
const path = require('path')
const url = require('url')
const util = require('util')
const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)

const open = require('opn')
const untildify = require('untildify')

const utils = require('./utils')

/// @nodoc
function _normalizeTag (str, userid) {
  if (!str.match(/^user\//)) {
    str = `user/${userid}/tag/${str}`
  }
  return encodeURIComponent(str)
}

/// @nodoc
function _nodify (cb, f) {
  const p = (typeof f === 'function') ? f() : f
  return cb ? p.then(r => cb(null, r), cb) : p
}

/// @nodoc
function _pickCB (...args) {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'function') {
      return [args[i], ...args.slice(0, i)]
    }
  }
  return [null, ...args]
}

function _streamOptions (opts, cb) {
  switch (typeof opts) {
    case 'function':
      return [null, opts]
    case 'string':
      return [{ continuation: opts }, cb]
    case 'object':
    case 'undefined':
      if (!opts) { // might be null
        return [null, cb]
      }
      break
    default:
      throw new TypeError('Unknown options type')
  }
  for (const [k, v] of Object.entries(opts)) {
    if (v instanceof Date) {
      opts[k] = v.getTime()
    }
  }
  return [opts, cb]
}

/**
 * Talk to the Feedly API.
 * All methods will ensure a valid authentication dance has occurred,
 * and perform the dance if necessary.
 *
 * All of the methods that take a callback also return
 * a promise - the callback is therefore optional.
 *
 * WARNING: by default, this class stores state information such
 * as your access token in ~/.feedly by default.
 */
class Feedly {
  /**
   * Creates an instance of Feedly.
   *
   * @param {Object} options - Options for the API
   * @param {int} [options.port] - TCP port to listen on for callbacks.
   *   (default: 0, which means to pick a random port)
   * @param {String} [options.base] - The root URL of the API.
   *   (default: 'http://cloud.feedly.com')
   * @param {String} [options.config_file] - File in which state information such
   *   as the access token and refresh tokens are stored. Tildes are expanded
   *   as needed. Tokens can also be provided manually as options.
   *   (default: '~/.feedly')
   * @param {String} [options.refresh_token] - User account refresh token.
   *   (default: undefined)
   * @param {String} [options.access_token] - User account access token.
   *   (default: undefined)
   * @param {String} [options.access_token_expires] - Time when the user account
   *   access token expires in milliseconds.  (default: 0)
   * @param {String} [options.html_file] - File that contains the HTML to give to
   *   the web browser after it is redirected to the one-shot web server that
   *   we'll be running.  (default: '../html/index.html')
   * @param {String} [options.html_text] - If html_file is null or the file can't
   *   be read, use this text instead.  (default: 'No HTML found')
   * @param {int} [options.slop] - If there is less than this amount of time (in
   *   milliseconds) between now and the expiration of the access token, refresh
   *   the token.  (default: 3600000)
   * @param {String} options.client_id - The API client ID.  (REQUIRED)
   * @param {String} options.client_secret - The API client Secret.  (REQUIRED)
   */
  constructor (options) {
    this.options = Object.assign({}, {
      port: 0,
      base: 'http://cloud.feedly.com',
      config_file: '~/.feedly',
      refresh_token: undefined,
      access_token: undefined,
      access_token_expires: 0,
      html_file: path.join(__dirname, '../html/index.html'),
      html_text: 'No HTML found',
      slop: 3600000,
      client_id: null,
      client_secret: null
    }, options)
    this.options.config_file = untildify(this.options.config_file)
    this.options.html_file = untildify(this.options.html_file)
    if ((this.options.client_id == null) || (this.options.client_secret == null)) {
      throw new Error('client_id and client_secret required')
    }
    this.state = {}
    if (this.options.refresh_token && this.options.access_token && this.options.access_token_expires) {
      this.state = {
        refresh_token: this.options.refresh_token,
        access_token: this.options.access_token,
        expires: this.options.access_token_expires
      }
    }

    // allSettled ignores errors
    this.ready = Promise.all([this._loadConfig(), this._loadHTML()])
  }

  /// @nodoc
  async _loadConfig () {
    if (this.options.config_file == null) { return null }
    try {
      const data = await readFile(this.options.config_file)
      this.state = JSON.parse(data)
      if (this.state.expires != null) {
        this.state.expires = new Date(this.state.expires)
      }
    } catch (er) {
      this.state = {}
    }
  }

  /// @nodoc
  async _loadHTML () {
    if (this.options.html_file != null) {
      try {
        this.options.html_text =
          await readFile(this.options.html_file, {encoding: 'utf8'})
      } catch (er) {
        console.error('WARNING:', er)
      }
    }
  }

  /// @nodoc
  async _save () {
    if (this.options.config_file != null) {
      await writeFile(
        this.options.config_file,
        JSON.stringify(this.state),
        { encoding: 'utf8' })
    }
  }

  /// @nodoc
  _validToken () {
    return (this.state.access_token != null) &&
           (this.state.refresh_token != null) &&
           (this.state.expires != null) &&
           (this.state.expires > new Date())
  }

  /// @nodoc
  async _getAuth () {
    await this.ready
    if (!this._validToken()) {
      // do full auth
      return this._auth()
    } else if ((this.state.expires - new Date()) > this.options.slop) {
      return this._refresh()
    }
    return this.state.access_token
  }

  /// @nodoc
  async _auth () {
    const u = url.parse(this.options.base)
    let cbURL = null
    const [results] = await utils.qserver(
      this.options.port,
      this.options.html_text,
      (cbu) => {
        cbURL = cbu
        u.pathname = '/v3/auth/auth'
        u.query = {
          response_type: 'code',
          client_id: this.options.client_id,
          redirect_uri: cbURL,
          scope: 'https://cloud.feedly.com/subscriptions'
        }
        return open(url.format(u))
      }
    )
    if (results.error != null) {
      throw results.error
    }
    return this._getToken(results.code, cbURL)
  }

  /// @nodoc
  async _getToken (code, redirect) {
    const u = url.parse(this.options.base)
    u.pathname = '/v3/auth/token'

    const body = await utils.qrequest({
      method: 'POST',
      uri: url.format(u),
      body: {
        code,
        client_id: this.options.client_id,
        client_secret: this.options.client_secret,
        grant_type: 'authorization_code',
        redirect_uri: redirect
      }
    })
    this.state = Object.assign({}, this.state, body)
    this.state.expires = new Date(new Date().getTime() + (body.expires_in * 1000))
    await this._save()
    return this.state.access_token
  }

  /// @nodoc
  async _refresh () {
    const u = url.parse(this.options.base)
    u.pathname = '/v3/auth/token'
    u.query = {
      refresh_token: this.state.refresh_token,
      client_id: this.options.client_id,
      client_secret: this.options.client_secret,
      grant_type: 'refresh_token'
    }

    const body = await utils.qrequest({
      method: 'POST',
      uri: url.format(u)})
    this.state = Object.assign({}, this.state, body)
    this.state.expires = new Date(new Date().getTime() + (body.expires_in * 1000))
    await this._save()
    return this.state.access_token
  }

  /// @nodoc
  async _request (callback, path, method, body = null) {
    if (method == null) { method = 'GET' }
    const u = url.parse(this.options.base)
    u.pathname = path

    const auth = await this._getAuth()
    return utils.qrequest({
      method,
      uri: url.format(u),
      headers: {
        Authorization: `OAuth ${auth}`
      },
      body,
      callback
    })
  }

  /// @nodoc
  async _requestURL (callback, path, method, body = null) {
    if (method == null) { method = 'GET' }
    const u = url.parse(this.options.base)
    u.pathname = path
    u.query = body

    const auth = await this._getAuth()
    return utils.qrequest({
      method,
      uri: url.format(u),
      headers: {
        Authorization: `OAuth ${auth}`
      },
      callback
    })
  }

  /// @nodoc
  _normalizeTags (ary) {
    const userid = this.state.id
    return ary.map(s => _normalizeTag(s, userid))
  }

  /// @nodoc
  _normalizeCategories (ary) {
    const userid = this.state.id
    return ary.map(cat => {
      if (!cat.match(/^user\//)) {
        cat = `user/${userid}/category/${cat}`
      }
      return cat
    })
  }

  /**
   * Refresh the auth token manually.  If the current refresh token is not
   * valid, authenticate again.
   *
   * @param {Function} [cb] - Optional callback function(Error, String)
   * @returns {Promise(String)} new auth token
   */
  refresh (cb) {
    return _nodify(cb, async () => {
      await this.ready
      return this._validToken() ? this._refresh() : this._auth()
    })
  }

  /**
   * Discard all tokens
   *
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} completed
   */
  logout (cb) {
    return _nodify(cb, async () => {
      await this.ready

      const u = url.parse(this.options.base)
      u.pathname = '/v3/auth/token'
      u.query = {
        refresh_token: this.state.refresh_token,
        client_id: this.options.client_id,
        client_secret: this.options.client_secret,
        grant_type: 'revoke_token'
      }

      const body = utils.qrequest({
        method: 'POST',
        uri: url.format(u)})
      delete this.state.access_token
      delete this.state.expires
      delete this.state.plan
      delete this.state.provider
      delete this.state.refresh_token
      delete this.state.token_type
      this.state = Object.assign({}, this.state, body)
      return this._save()
    })
  }

  /**
   * Fetch the list of categories
   *
   * @param {Function} [cb] - Optional callback function(Error, Array(Category))
   * @returns {Promise(Array(Category))} list of categories
   * @see {@link https://developer.feedly.com/v3/categories/#get-the-list-of-all-categories}
   */
  categories (cb) {
    return this._request(cb, '/v3/categories')
  }

  /**
   * Set the label for a category.
   *
   * @param {String} id - the category to modify
   * @param {String} label - the new label
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/categories/#change-the-label-of-an-existing-category
   */
  setCategoryLabel (id, label, cb) {
    return this._request(
      cb,
      `/v3/categories/${encodeURIComponent(id)}`,
      'POST',
      {label})
  }

  /**
   * Delete a category.
   *
   * @param {String} id - the category to delete
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/categories/#delete-a-category
   */
  deleteCategory (id, cb) {
    return this._request(
      cb,
      `/v3/categories/${encodeURIComponent(id)}`,
      'DELETE')
  }

  /**
   * Get one or more entries
   *
   * @param {String|Array(String)} id - the entry or entries to retrieve
   * @param {Function} [cb] - Optional callback function(Error, Entry|Array(Entry))
   * @returns {Promise(Entry)|Promise(Array(Entry))} the entry(s)
   * @see https://developer.feedly.com/v3/entries/#get-the-content-of-an-entry
   * @see https://developer.feedly.com/v3/entries/#get-the-content-for-a-dynamic-list-of-entries
   */
  entry (id, cb) {
    if (Array.isArray(id)) {
      return this._request(cb, '/v3/entries/.mget', 'POST', id)
    } else {
      return this._request(cb, `/v3/entries/${encodeURIComponent(id)}`)
    }
  }

  /**
   * Create an entry.  This call is useful to inject entries not coming from a
   * feed, into a user’s account. The entries created will only be available
   * through the tag streams of the respective tags passed.
   *
   * @param {Entry} entry - See the
   *   {@link http://developer.feedly.com/v3/entries/#create-and-tag-an-entry Feedly API docs}
   *   for more information.
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see http://developer.feedly.com/v3/entries/#create-and-tag-an-entry
   */
  createEntry (entry, cb) {
    return this._request(cb, '/v3/entries/', 'POST', entry)
  }

  /**
   * Get meta-data about a feed or list of feeds
   *
   * @param {String|Array(String)} id - the ID or list of IDs of the feed(s)
   * @param {Function} [cb] - Optional callback function(Error, Feed|Array(Feed))
   * @returns {Promise(Feed)|Promise(Array(Feed))}
   * @see https://developer.feedly.com/v3/feeds/#get-the-metadata-about-a-specific-feed
   */
  feed (id, cb) {
    if (Array.isArray(id)) {
      return this._request(cb, '/v3/feeds/.mget', 'POST', id)
    } else {
      return this._request(cb, `/v3/feeds/${encodeURIComponent(id)}`)
    }
  }

  /**
   * Get unread counts.  In theory, newerThan and streamId can
   * be used to reduce the counts that are returned, but I didn't see evidence
   * of that in practice.
   *
   * @param {Boolean} [autorefresh] - Lets the server know if this is a background
   *   auto-refresh or not. In case of very high load on the service, the server
   *   can deny access to background requests and give priority to user facing
   *   operations.
   * @param {Date} [newerThan] - timestamp used as a lower time limit, instead of
   *   the default 30 days
   * @param {String} [streamId] - A user or system category can be passed to
   *   restrict the unread count response to feeds in this category.
   * @param {Function} [cb] - Optional callback function(Error, Counts)
   * @returns {Promise(Array(Count))}
   * @see https://developer.feedly.com/v3/markers/#get-the-list-of-unread-counts
   */
  counts (autorefresh, newerThan, streamId, cb) {
    [cb, autorefresh, newerThan, streamId] =
      _pickCB(autorefresh, newerThan, streamId, cb)

    let input = {}
    if (autorefresh != null) {
      input.autorefresh = autorefresh
    }
    if (newerThan != null) {
      input.newerThan = newerThan.getTime()
    }
    if (streamId != null) {
      input.streamId = streamId
    }
    if (Object.keys(input).length === 0) {
      input = null
    }
    return this._request(cb, '/v3/markers/counts', 'GET', input)
  }

  /**
   * Mark article(s) as read.
   *
   * @param {Array(String)|String} ids - article ID(s) to mark read
   * @param {Function} cb - Optionall callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#mark-one-or-multiple-articles-as-read
   */
  markEntryRead (ids, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    return this._request(cb, '/v3/markers', 'POST', {
      entryIds: ids,
      type: 'entries',
      action: 'markAsRead'
    })
  }

  /**
   * Mark article(s) as unread.
   *
   * @param {Array(String)|String} ids - Article ID(s) to mark unread
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#keep-one-or-multiple-articles-as-unread
   */
  markEntryUnread (ids, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    return this._request(cb, '/v3/markers', 'POST', {
      entryIds: ids,
      type: 'entries',
      action: 'keepUnread'
    })
  }

  /**
   * Mark feed(s) as read.
   *
   * @param {Array(String)|String} ids - feed ID(s) to mark read
   * @param {String|Date} [since] - last entry ID read or timestamp last read
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#mark-a-feed-as-read
   */
  markFeedRead (ids, since, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    [cb, since] = _pickCB(since, cb)

    const body = {
      feedIds: ids,
      type: 'feeds',
      action: 'markAsRead'
    }
    if (since instanceof Date) {
      body.asOf = since.getTime()
    } else if (typeof since === 'string') {
      body.lastReadEntryId = since
    }

    return this._request(cb, '/v3/markers', 'POST', body)
  }

  /**
   * Mark category(s) as read.
   *
   * @param {Array(String)|String} ids - category ID(s) to mark read
   * @param {String|Date} [since] - last entry ID read or timestamp last read
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#mark-a-category-as-read
   */
  markCategoryRead (ids, since, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    [cb, since] = _pickCB(since, cb)

    const body = {
      categoryIds: this._normalizeCategories(ids),
      type: 'categories',
      action: 'markAsRead'
    }
    if (since instanceof Date) {
      body.asOf = since.getTime()
    } else if (typeof since === 'string') {
      body.lastReadEntryId = since
    }

    return this._request(cb, '/v3/markers', 'POST', body)
  }

  /**
   * Mark tag(s) as read.
   *
   * @param {Array(String)|String} ids - tag ID(s) to mark read
   * @param {String|Date} [since] - last entry ID read or timestamp last read
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#mark-a-tag-as-read
   */
  markTagRead (ids, since, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    [cb, since] = _pickCB(since, cb)

    const body = {
      tagIds: this._normalizeTags(ids),
      type: 'tags',
      action: 'markAsRead'
    }
    if (since instanceof Date) {
      body.asOf = since.getTime()
    } else if (typeof since === 'string') {
      body.lastReadEntryId = since
    }

    return this._request(cb, '/v3/markers', 'POST', body)
  }

  /**
   * Mark tag(s) as saved.
   *
   * @param {Array(String)|String} ids - tag ID(s) to mark as saved
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#mark-a-tag-as-saved
   */
  markEntrySaved (ids, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    return f._request(cb, '/v3/markers', 'POST', {
      entryIds: ids,
      type: 'entries',
      action: 'markAsSaved'
    })
  }

  /**
   * Mark tag(s) as unsaved.
   *
   * @param {Array(String)|String} ids - tag ID(s) to mark as unsaved
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/markers/#mark-a-tag-as-unsaved
   */
  markEntryUnsaved (ids, cb) {
    if (typeof ids === 'string') {
      ids = [ids]
    }
    return f._request(cb, '/v3/markers', 'POST', {
      entryIds: ids,
      type: 'entries',
      action: 'markAsUnsaved'
    })
  }

  /**
   * Get the latest read operations (to sync local cache).
   *
   * @param {Date} [newerThan] - start date
   * @param {any} [cb] - Optional callback function(Error, Array(Read))
   * @returns {Promise(Array(Read))} the read operations
   * @see https://developer.feedly.com/v3/markers/#get-the-latest-read-operations-to-sync-local-cache
   */
  reads (newerThan, cb) {
    [cb, newerThan] = _pickCB(newerThan, cb)

    let input = null
    if (newerThan != null) {
      input = {
        newerThan: newerThan.getTime()
      }
    }
    return this._request(cb, '/v3/markers/reads', 'GET', input)
  }

  /**
   * Get the latest tagged entry ids
   *
   * @param {Date} [newerThan] - start date
   * @param {any} [cb] - Optional callback function(Error, Tagged)
   * @returns {Promise(Tagged)} The tags
   * @see https://developer.feedly.com/v3/markers/#get-the-latest-tagged-entry-ids
   */
  tags (newerThan, cb) {
    [cb, newerThan] = _pickCB(newerThan, cb)

    let input = null
    if (newerThan != null) {
      input = {
        newerThan: newerThan.getTime()
      }
    }
    return this._request(cb, '/v3/markers/tags', 'GET', input)
  }

  /**
   * Get the current user's preferences
   *
   * @param {Function} [cb] - Optional function(Error, Prefs)
   * @returns {Promise(Prefs)} - the preferences
   * @see https://developer.feedly.com/v3/preferences/#get-the-preferences-of-the-user
   */
  preferences (cb) {
    return this._request(cb, '/v3/preferences')
  }

  /**
   * Update the preferences of the user
   *
   * @param {Object} prefs - the preferences to update, use "==DELETE==”
   *   as the value in order to delete a preference.
   * @param {any} [cb] - Optional callback function(Error, Prefs)
   * @returns {Promise(Prefs)} updated preferences
   * @see https://developer.feedly.com/v3/preferences/#update-the-preferences-of-the-user
   */
  updatePreferences (prefs, cb) {
    return this._request(cb, '/v3/preferences', 'POST', prefs)
  }

  /**
   * Get the current user's profile
   *
   * @param {Function} [cb] - Optional callback function(Error, Profile)
   * @returns {Promise(Profile)} Profile information
   * @see https://developer.feedly.com/v3/profile/#get-the-profile-of-the-user
   */
  profile (cb) {
    return this._request(cb, '/v3/profile')
  }

  /**
   * Update the profile of the user
   *
   * @param {Object} profile - the profile to update.  See
   *   {@link https://developer.feedly.com/v3/profile/#update-the-profile-of-the-user Feedly API docs}
   *   for more information
   * @param {Function} [cb] - Optional callback function(Error, Profile)
   * @returns {Promise(Profile)} The updated profile
   * @see https://developer.feedly.com/v3/profile/#update-the-profile-of-the-user
   */
  updateProfile (profile, cb) {
    return this._request(cb, '/v3/profile', 'POST', profile)
  }

  /**
   * Find feeds based on title, url or #topic
   *
   * @param {String} query - the string to search for
   * @param {int} [results=20] - the max number of results to return
   * @param {String} [locale] - hint the search engine to return feeds in that locale (e.g. “pt”, “fr_FR”)
   * @param {Function} [cb] - Optional callback function(Error, Array(Feed))
   * @returns {Promise(Array(Feed))}
   * @see https://developer.feedly.com/v3/search/#find-feeds-based-on-title-url-or-topic
   */
  searchFeeds (query, results, locale, cb) {
    [cb, results, locale] = _pickCB(results, locale, cb)
    const req = {
      query
    }
    if (results != null) {
      req.n = results
    }
    if (locale) {
      req.locale = locale
    }

    return this._requestURL(cb, '/v3/search/feeds', 'GET', req)
  }

  /**
   * Create a shortened URL for an entry.  The short URL is unique for a given
   * entry id, user and application.
   *
   * @param {String} entryId - The entry ID to shorten
   * @param {Function} [cb] - Optional callback function(Error, String)
   * @returns {Promise(String)} the shortened URL
   * @deprecated This is no longer documented in the Feedly API
   */
  shorten (entryId, cb) {
    return this._requestURL(
      cb,
      '/v3/shorten/entries',
      'GET',
      { entryId })
  }

  /**
   * Get a list of entry ids for a specific stream.
   *
   * @param {String} id - the Stream ID
   * @param {String|Object} [options] - A continuation ID as a string is
   *   used to page, or an object with stream request parameters
   * @param {("newest"|"oldest")} [options.ranked="newest"] - order
   * @param {Boolean} [options.unreadOnly=false] - only unread?
   * @param {Date} [options.newerThan] - since when?
   * @param {String} [options.continuation] - continue from where you left off
   * @param {Function} [cb] - Optional callback function(Error, Page)
   * @returns {Promise(Page)}
   * @see https://developer.feedly.com/v3/streams/#get-a-list-of-entry-ids-for-a-specific-stream
   */
  stream (id, options, cb) {
    [options, cb] = _streamOptions(options, cb)
    return this._requestURL(
      cb,
      `/v3/streams/${encodeURIComponent(id)}/ids`,
      'GET',
      options)
  }

  /**
   * Get the content of a stream
   *
   * @param {String} id - the Stream ID
   * @param {String|Object} [options] - A continuation ID as a string is
   *   used to page, or an object with stream request parameters
   * @param {("newest"|"oldest")} [options.ranked="newest"] - order
   * @param {Boolean} [options.unreadOnly=false] - only unread?
   * @param {Date} [options.newerThan] - since when?
   * @param {String} [options.continuation] - continue from where you left off
   * @param {Function} [cb] - Optional callback function(Error, ContentPage)
   * @returns {Promise(ContentPage)}
   * @see https://developer.feedly.com/v3/streams/#get-the-content-of-a-stream
   */
  contents (id, options, cb) {
    [options, cb] = _streamOptions(options, cb)
    return this._request(
      cb,
      `/v3/streams/${encodeURIComponent(id)}/contents`,
      'GET',
      options)
  }

  /**
   * Get the user’s subscriptions
   *
   * @param {Function} [cb] - Optional callback function(Error, Array(Subscription))
   * @returns {Promise(Array(Subscription))}
   * @see https://developer.feedly.com/v3/subscriptions/#get-the-users-subscriptions
   */
  subscriptions (cb) {
    return this._request(cb, '/v3/subscriptions', 'GET')
  }

  /**
   * Subscribe to a feed
   * [{@link https://developer.feedly.com/v3/subscriptions/#subscribe-to-a-feed API doc}]
   *
   * @param {String} url - the URL of the feed to subscribe to
   * @param {String|Array(String)} [categories] - category(s) for the subscription
   * @param {String} [title] - Subscription title
   * @param {Function} cb - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/subscriptions/#subscribe-to-a-feed
   */
  subscribe (url, categories, title, cb) {
    if (!url.match(/^feed\//)) {
      url = `feed/${url}`
    }
    [cb, categories, title] = _pickCB(categories, title, cb)

    const input = {
      id: url
    }

    if (categories != null) {
      if (!Array.isArray(categories)) {
        categories = [categories]
      }
      const userid = this.state.id
      categories = categories.map(c => {
        if (typeof c !== 'string') {
          return c
        }
        let id = null
        let name = null
        const m = c.match(/^user\/[^/]+\/(.*)/)
        if (!m) {
          id = `user/${userid}/category/${c}`
          name = c
        } else {
          id = c
          name = m[1]
        }
        return {
          id,
          name
        }
      })
      input.categories = categories
    }
    if (title) {
      input.title = title
    }
    return this._request(cb, '/v3/subscriptions', 'POST', input)
  }

  /**
   * Unsubscribe from a feed
   *
   * @param {String} id - Feed ID
   * @param {Function} [cb] - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/subscriptions/#unsubscribe-from-a-feed
   */
  unsubscribe (id, cb) {
    // TODO: add support for mass unsubscribe
    return this._request(
      cb,
      `/v3/subscriptions/${encodeURIComponent(id)}`,
      'DELETE')
  }

  /**
   * Tag an existing entry or entries
   *
   * @param {String|Array(String)} entry - the entry(s) to tag
   * @param {String|Array(String)} tags - the tag(s) to apply to the entry
   * @param {Function} cb - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/tags/#tag-an-existing-entry
   * @see https://developer.feedly.com/v3/tags/#tag-multiple-entries-alternate
   */
  tagEntry (entry, tags, cb) {
    if (!Array.isArray(tags)) {
      tags = [tags]
    }
    tags = this._normalizeTags(tags)
    if (Array.isArray(entry)) {
      return this._request(
        cb,
        `/v3/tags/${tags.join(',')}`,
        'PUT',
        {entryIds: entry})
    } else {
      return this._request(
        cb,
        `/v3/tags/${tags.join(',')}`,
        'PUT',
        {entryId: entry})
    }
  }

  /**
   * Change a tag label
   *
   * @param {String} tag - the tag to modify
   * @param {String} label - new label for the tag
   * @param {Function} cb - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/tags/#change-a-tag-label
   */
  setTagLabel (tag, label, cb) {
    tag = _normalizeTag(tag, this.state.id)
    return this._request(
      cb,
      `/v3/tags/${tag}`,
      'POST',
      {label})
  }

  /**
   * Untag entries
   *
   * @param {String|Array(String)} entries - the ID(s) of the entries to modify
   * @param {String|Array(String)} tags - the tag(s) to remove
   * @param {Function} cb - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/tags/#untag-multiple-entries
   */
  untagEntries (entries, tags, cb) {
    if (!Array.isArray(entries)) {
      entries = [entries]
    }
    entries = entries.map(e => encodeURIComponent(e))

    if (!Array.isArray(tags)) {
      tags = [tags]
    }
    tags = this._normalizeTags(tags)

    return this._request(
      cb,
      `/v3/tags/${tags.join(',')}/${entries.join(',')}`,
      'DELETE')
  }

  /**
   * Delete tags
   *
   * @param {String|Array(String)} tags - the tag(s) to remove
   * @param {any} cb - Optional callback function(Error)
   * @returns {Promise} Done
   * @see https://developer.feedly.com/v3/tags/#delete-tags
   */
  deleteTags (tags, cb) {
    if (!Array.isArray(tags)) {
      tags = [tags]
    }
    tags = this._normalizeTags(tags)
    return this._request(cb, `/v3/tags/${tags.join(',')}`, 'DELETE')
  }
}

module.exports = Feedly
