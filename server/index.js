import { createServer } from 'node:http'
import { handleRequest } from './handler.js'
import { loadLocalMongoConfig } from '../functions/scripts/load-local-mongo-config.js'

if (process.env.NODE_ENV !== 'production' && !process.env.MONGODB_URI) {
  loadLocalMongoConfig()
}

const server = createServer(handleRequest)
const port = Number(process.env.PORT || 8787)
server.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`RestaurantOS MongoDB API listening on port ${port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
