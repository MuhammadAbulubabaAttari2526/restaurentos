export class HttpsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'HttpsError'
    this.code = code
  }
}

export const onCall = (_options, handler) => handler
export const onRequest = (_options, handler) => handler
