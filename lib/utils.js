'use strict'
const http = require('http')
const url = require('url')

const request = require('request')
const NoFilter = require('nofilter')

module.exports = class Utils {
  static qserver (port, text, opener) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(function (req, res) {
        const u = url.parse(req.url, true)
        if (u.pathname === '/') {
          const bs = new NoFilter()
          res.writeHead(200,
            {'Content-Type': 'text/html'})
          bs.on('finish', function () {
            resolve([u.query, bs.toString('utf8')])
            return server.close()
          })
          req.pipe(bs)
          res.end(text)
        } else {
          res.writeHead(404)
          res.end()
        }
        return req.connection.destroy()
      })

      server.on('error', function (er) {
        // is this needed?  Find an error to test.
        return server.close()
      })

      server.listen(port, function () {
        const a = server.address()
        opener(`http://localhost:${a.port}`)
      })
    })
  }

  static qrequest (options) {
    if ((options == null)) {
      throw new Error('options not optional')
    }

    const cb = options.callback
    delete options.callback

    let prom = new Promise((resolve, reject) => {
      options.json = true
      request(options, function (er, res, body) {
        if (er != null) {
          return reject(er)
        } else if (res.statusCode !== 200) {
          return reject(new Error(`HTTP error: ${res.statusCode}\nFrom: ${options.uri}\n${JSON.stringify(body)}`))
        } else {
          return resolve(body)
        }
      })
    })
    if (typeof cb === 'function') {
      prom = prom.then(r => cb(null, r), cb)
    }

    return prom
  }
}
