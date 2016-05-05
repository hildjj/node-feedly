This is a node API for [Feedly](http://developer.feedly.com)

Installation
============

Install from NPM:

    npm install --save feedly

Creating an instance
====================

Create an instance:

    var Feedly = require 'feedly'

    var f = new Feedly({
      client_id: 'MY_CLIENT_ID',
      client_secret: 'MY_CLIENT_SECRET'
      port: 8080
    });

Use the sandbox:

    var Feedly = require 'feedly'

    var f = new Feedly({
      client_id: 'sandbox',
      client_secret: 'Get the current secret from http://developer.feedly.com/v3/sandbox/'
      base: 'http://sandbox.feedly.com'
      port: 8080
    });

Authentication
==============

The first non-trivial method call you make to the object will cause your
default browser to pop up asking you to log in.  When that process is complete,
you will see a page served from http://localhost:8080/, which you can close.
After that point, you won't need to log in again until your token expires
(without your having called `refresh` in the meantime).

**WARNING**: by default, this will store your auth token and refresh token in  
`~/.feedly`, unencrypted.  Set the `config_file` options to null to prevent this
behavior, but you will have to log in through the web site each time you create
a new `Feedly` instance.

Callbacks and promises
======================

Each method takes an optional node-style `(error, results)` callback.  If you
prefer a [promise](https://github.com/kriskowal/q)-style
approach, you do without a callback, like this:

    f.reads().then(function(results) {
        // process results
    },
    function (error) {
        // process error
    });


Documentation
=============

Full documentation for the API can be found
[here](http://hildjj.github.io/node-feedly/doc/).
