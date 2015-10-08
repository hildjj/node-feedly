http = require 'http'
url = require 'url'

q = require 'q'
request = require 'request'
NoFilter = require 'nofilter'

exports.extend = (old, adds...)->
  old ?= {}
  for a in adds
    for k,v of a
      old[k] = v
  old

exports.qserver = (port, text) ->
  addr_defer = q.defer()
  result_defer = q.defer()
  server = http.createServer (req, res) ->
    u = url.parse req.url, true
    if u.pathname == '/'
      res.writeHead 200,
        'Content-Type': 'text/html'
      bs = new NoFilter()
      bs.on 'finish', () ->
        result_defer.resolve [u.query, bs.toString('utf8')]
        server.close()
      req.pipe bs
      res.end text
    else
      res.writeHead 404
      res.end()
    req.connection.destroy()

  server.on 'error', (er) ->
    addr_defer.reject er
    # is this needed?  Find an error to test.
    server.close()

  server.listen port, ->
    a = server.address()
    addr_defer.resolve "http://localhost:#{a.port}"

  [addr_defer.promise, result_defer.promise]

exports.qrequest = (options) ->
  if !options?
    throw new Error("options not optional")
  d = q.defer()
  cb = options.callback
  if cb?
    delete options.callback
    d.promise.nodeify cb

  options.json = true
  request options, (er, res, body) ->
    if er?
      d.reject er
    else if res.statusCode != 200
      d.reject new Error("HTTP error: #{res.statusCode}\nFrom: #{options.uri}\n#{JSON.stringify(body)}")
    else
      d.resolve body

  d.promise

# polyfill from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/find
unless Array::find
  Object.defineProperty Array::, "find",
    enumerable: false
    configurable: true
    writable: true
    value: (predicate) ->
      throw new TypeError("Array.prototype.find called on null or undefined")  unless this?
      throw new TypeError("predicate must be a function")  if typeof predicate isnt "function"
      list = Object(this)
      length = list.length >>> 0
      thisArg = arguments[1]
      value = undefined
      i = 0

      while i < length
        if i of list
          value = list[i]
          return value  if predicate.call(thisArg, value, i, list)
        i++
      `undefined`
