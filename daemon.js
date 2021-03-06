// seed images and write the torrent files to hyperdrive

var fs = require('fs')
var path = require('path')
var http = require('http')
var proc = require('child_process')
var npmexec = require('npm-execspawn')

var async = require('async')
var partial = require('lodash.partial')
var Docker = require('dockerode')
var finalHandler = require('finalhandler')
var Router = require('router')
var morgan = require('morgan')
var levelup = require('level')
var hyperdrive = require('hyperdrive')
var swarm = require('discovery-swarm')()
var raf = require('random-access-file')
var bodyParser = require('body-parser')
var randomstring = require('randomstring')
var url = require('url')

var conf = require('./conf')
var util = require('./util')
var appName = conf.name
var debug = require('debug')(appName)

var torrentBin = util.getTorrentBin()

var docker = new Docker()
var db = levelup(conf.db)
var drive = hyperdrive(db)

var existingKey = process.env['CONTAINER_DRIVE_KEY']
var archiveKey = existingKey ? new Buffer(existingKey, 'hex') : null
var archive = drive.createArchive(archiveKey, {
  live: true,
  file: function (name) {
    return raf(path.join(conf.torrentsDir, name))
  }
})
archiveKey = archive.key

var makeId = util.makeId()
var seeding = {}

var router = Router()
router.use(bodyParser.json())
router.use(morgan())
var server = http.createServer(function (req, res) {
  router(req, res, finalHandler(req, res))
})

/**
 * Start seeding any images listed in the db
 */
function start (cb) {
  var hexKey = archiveKey.toString('hex')
  process.env['CONTAINER_DRIVE_KEY'] = hexKey

  function _seedTorrents (next) {
    listSeedableTorrents(function (err, torrents) {
      if (err) return cb(err)
      async.each(torrents, function (torrent, next) {
        startSeeding(torrent, next)
      }, function (err) {
        return next(err)
      })
    })
  }

  function _shareDrive (next) {
    console.log('sharing archive key:', hexKey)
    swarm.listen(conf.swarmPort)
    swarm.join(archiveKey)
    swarm.on('connection', function (conn) {
      conn.pipe(archive.replicate()).pipe(conn)
    })
    return next()
  }

  async.series([
    _seedTorrents,
    _shareDrive
  ], function (err) {
    return cb(err)
  })
}

/**
 * Stop seeding all images
 */
function stop () {
  async.each(Object.keys(seeding), function (torrent, next) {
    stopSeeding(torrent)
  })
}

/**
 * List the .torrent files in the conf.data directory
 */
function listSeedableTorrents (cb) {
  fs.readdir(conf.data, function (err, files) {
    if (err) return cb(err)
    var onlyTorrents = files.filter(function (f) {
      return f.endsWith('.torrent')
    })
    return cb(null, onlyTorrents.map(function (f) {
      return path.join(conf.data, f.slice(0, -8))
    }))
  })
}

/**
 * Optimistically seed (its data might not be available) a torrent in the conf.data directory
 */
function startSeeding (torrent, cb) {
  var torrentName = torrent + '.torrent'
  var torrentFile = path.join(conf.data, torrentName)

  // start the seeding process
  function _startSeedProc (next) {
    var child = proc.spawn(torrentBin, ['seed', torrentFile], {})
    var pid = child.pid
    // TODO do anything with output streams?
    child.on('close', function (code) {
      console.error('Stopped seeding', torrent, 'with PID', pid)
      stopSeeding(torrent)
    })
    seeding[torrent] = pid
    return next(null)
  }

  // write the torrent file to hyperdrive, so that it's discoverable
  function _shareImage (next) {
    var hyperStream = archive.createFileWriteStream(torrentName)
    fs.createReadStream(torrentFile).pipe(hyperStream)
      .on('finish', function () {
        return next(null)
      })
      .on('error', function (err) {
        return next(err)
      })
  }

  if (!seeding[torrent]) {
    async.series([
      _startSeedProc,
      _shareImage
    ], function (err) {
      return cb(err, torrent)
    })
  } else {
    // already seeding
    return cb(null)
  }
}

/**
 * Stop seeding (if the seeding process is currently running) a torrent file
 *
 * Note: the torrent will still be listed in the hyperdrive, but there might not be seeds
 */
function stopSeeding (torrent, cb) {
  // stop the seeding process
  function _stopSeedProc (next) {
    var pid = seeding[torrent]
    process.kill(pid, 'SIGINT')
    return next(null)
  }

  if (seeding[torrent]) {
    _stopSeedProc(function (err) {
      if (cb) return cb(err)
    })
  } else {
    // already not seeding
    if (cb) return cb(null)
  }
}

/**
 * Create a new torrent, but don't write the .torrent file to the hyperdrive archive
 */
function createTorrent (cont, name, cb) {
  if (typeof name === 'function') {
    cb = name
    name = null
  }
  function _createImage (next) {
    var container = docker.getContainer(cont)
    var id = name || makeId()
    container.commit({
      repo: id
    }, function (err) {
      return next(err, id)
    })
  }

  function _createTorrent (id, next) {
    proc.exec([torrentBin, 'create', id].join(' '), function (err) {
      return next(err, id)
    })
  }

  async.waterfall([
    _createImage,
    _createTorrent
  ], function (err, torrentName) {
    return cb(err, torrentName)
  })
}

/**
 * Return a stream of downloadable torrents stored in the hyperdrive archive
 */
function listDownloadableTorrents (cb) {
  var stream = archive.list({ live: false })
  var torrents = []
  stream.on('error', function (err) {
    return cb(err)
  })
  stream.on('data', function (data) {
    torrents.push(data)
    debug('torrents is now:', torrents)
  })
  stream.on('end', function () {
    return cb(null, torrents.map(function (t) { return t.name }))
  })
}

// configure routes

function sendJson (res, obj) {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

function sendError (res, err) {
  res.writeHead(500, {
    'Content-Type': 'text/plain'
  })
  res.end(err.toString())
}

/**
 * Get all images that are being seeded
 */
router.get('/seeding', function (req, res) {
  sendJson(res, seeding)
})

/**
 * Get all available torrents in the hyperdrive archive
 */
router.get('/torrents', function (req, res) {
  listDownloadableTorrents(function (err, torrents) {
    if (err) return sendError(res, err)
    return sendJson(res, torrents)
  })
})

/**
 * Create and seed a new image
 */
router.post('/torrents', function (req, res) {
  var container = req.body.container
  var torrentName = req.body.name
  debug('body:', JSON.stringify(req.body))
  if (!container) {
    return sendError(res, 'expecting field \'container\' in body\n')
  }
  async.waterfall([
    partial(createTorrent, container, torrentName),
    startSeeding
  ], function (err, torrent) {
    if (err) return sendError(res, err)
    debug('created torrent:', torrent)
    sendJson(res, { torrent: torrent })
  })
})

/**
 * List all available containers
 */
router.get('/containers', function (req, res) {
  var params = url.parse(req.url, true).query
  var all = (params && params.all) ? params.all : false
  docker.listContainers({ all: all }, function (err, containers) {
    if (err) return sendError(res, err)
    return sendJson(res, containers.map(function (cont) {
      return {
        id: cont['Id'],
        state: cont['State'],
        created: cont['Created'],
        image: cont['Image']
      }
    }))
  })
})

/**
 * Stop the daemon
 */
process.on('SIGINT', function () {
  stop()
})

/**
 * Start the daemon
 */
if (require.main === module) {
  start(function (err) {
    if (err) {
      console.error('could not start daemon:', err)
      process.exit(2)
    }
    debug('starting server on port', conf.port)
    server.listen(conf.port)
  })
} else {
  module.exports = start
}
