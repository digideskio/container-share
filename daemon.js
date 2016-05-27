// seed images and write the torrent files to hyperdrive

var fs = require('fs')
var path = require('path')
var http = require('http')
var proc = require('child_process')

var async = require('async')
var partial = require('lodash.partial')
var pm2 = require('pm2')
var Docker = require('dockerode')
var finalHandler = require('finalhandler')
var Router = require('router')
var morgan = require('morgan')
var levelup = require('level')
var hyperdrive = require('hyperdrive')
var bodyParser = require('body-parser')
var nid = require('nid')

var appName = require('./package.json')['name']
var debug = require('debug')(appName)
var conf = require('./conf')

try {
  var binPath = proc.execSync('npm bin', { encoding: 'utf8' }).trim()
  var torrentBin = path.join(binPath, 'torrent-docker')
} catch (err) {
  console.error('could not find torrent-docker bin')
  process.exit(2)
}

var docker = new Docker()
var db = levelup(conf.db)
var drive = hyperdrive(db)

var archiveKey = process.env['CONTAINER_DRIVE_KEY']
var archive = drive.createArchive(archiveKey, {
  live: true
})
archiveKey = archive.key

var makeId = nid({
  hex: 1,
  length: conf.idLength
})
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
    process.env['CONTAINER_DRIVE_KEY'] = archive.key
    console.log('sharing archive key:', archive.key.toString('hex'))
    pm2.connect(function (err) {
      if (err) return next(err)
      pm2.start({
        name: 'container-drive-seeder',
        script: path.join(__dirname, 'share.js')
      }, function (err) {
        return next(err)
      })
    })
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
  var torrentFile = path.join(conf.data, torrent + '.torrent')

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
    var hyperStream = archive.createFileWriteStream(torrent)
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
  var torrentFile = path.join(conf.data, torrent + '.torrent')

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
function createTorrent (cont, cb) {
  function _createImage (next) {
    var container = docker.getContainer(cont)
    var id = makeId()
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
 * List all downloadable torrents stored in the hyperdrive archive
 */
function listDownloadableTorrents (cb) {
  archive.list(function (err, torrents) {
    if (err) return cb(err)
    return cb(null, torrents)
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
  res.end(err)
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
    if (err) {
      debug('could not list torrents:', err)
      sendError(res, err)
    }
    return sendJson(res, torrents)
  })
})

/**
 * Create and seed a new image
 */
router.post('/torrents', function (req, res) {
  var container = req.body.container
  debug('body:', JSON.stringify(req.body))
  if (!container) {
    return sendError(res, 'expecting field \'container\' in body\n')
  }
  async.waterfall([
    partial(createTorrent, container),
    startSeeding
  ], function (err, torrent) {
    if (err) return sendError(res, err)
    debug('created torrent:', torrent)
    res.writeHead(200)
    res.end()
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
start(function (err) {
  if (err) {
    console.error('could not start daemon:', err)
    process.exit(2)
  }
  debug('starting server on port', conf.port)
  server.listen(conf.port)
})