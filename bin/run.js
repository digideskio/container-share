var argv = require('minimist')(process.argv.slice(2), {
  alias: { h: 'help' }
})

var share = require('..')

if (argv.help) {
  console.log(require('../docs/run')())
  process.exit(0)
}

if (argv._.length !== 1) {
  console.error('must specify a single image to launch')
  process.exit(2)
}

var torrent = argv._[0]

console.log('Booting up container from torrent:', torrent)
share.launchContainer(torrent, function (err, torrent) {
  if (err) {
    console.error('Could not boot up container:', err)
    process.exit(2)
  }
  console.log('Container exited')
  process.exit(0)
})
