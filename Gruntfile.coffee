module.exports = (grunt) ->

  # Load Grunt tasks declared in the package.json file
  require("jit-grunt") grunt
  grunt.initConfig
    pkg: grunt.file.readJSON("package.json")
    clean:
      all: [
        "coverage"
        "doc"
        "lib"
        "man"
      ]
      coverage: ["coverage"]
      doc: ["doc"]
      lib: ["lib"]
      man: ["man"]

    coffee:
      compile:
        expand: true
        flatten: true
        cwd: "src"
        src: ["*.coffee"]
        dest: "lib/"
        ext: ".js"

    # just run 'codo' on the command line (using .codoopts),
    # and everything will work.
    # grunt-codo doesn't seem to produce consistent output at the
    # moment.
    codo:
      options:
        undocumented: true
        name: "Feedly API"
        readme: "README.md"
        extra: ["LICENSE.md"]
      all:
        src: ["src/feedly.coffee"]

    coffeelint:
      src: ["src/*.coffee"]
      options:
        configFile: "coffeelint.json"

    nodeunit:
      all: ["test"]

    shell:
      istanbul:
        command: 'istanbul cover nodeunit test'

    express:
      all:
        options:
          port: 9000
          hostname: "0.0.0.0"
          bases: "coverage/lcov-report"
          livereload: true
          open: "http://localhost:<%= express.all.options.port%>/lib/feedly.js.html"

    watch:
      all:
        files: [
          "src/*.coffee"
          "test/*.coffee"
        ]
        tasks: [
          "coffee"
          "shell:istanbul"
        ]
        options:
          livereload: true

    release:
      options:
        tagName: "v<%= version %>" #default: '<%= version %>'

  grunt.registerTask "default", ["test"]
  grunt.registerTask "prepublish", [
    "clean"
    "coffee"
    "codo"
  ]
  grunt.registerTask "doc", [
    "clean:doc"
    "codo"
  ]
  grunt.registerTask "test", [
    "coffee"
    "nodeunit"
  ]
  grunt.registerTask "server", [
    "shell:istanbul"
    "express"
    "watch"
  ]
  grunt.registerTask "ci", [
    "test"
    "shell:istanbul"
    "coveralls"
  ]
  return
