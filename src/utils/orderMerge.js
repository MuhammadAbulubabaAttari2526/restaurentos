export function mergeOrderWithFinancials(order, financial) {
  return { ...financial, ...order, status: order.status }
}
