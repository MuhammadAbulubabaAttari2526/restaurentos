import { handleRequest } from '../server/handler.js'

export default async function handler(req, res) {
  return handleRequest(req, res)
}
