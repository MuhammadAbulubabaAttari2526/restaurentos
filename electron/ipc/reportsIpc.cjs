/**
 * reportsIpc.cjs
 *
 * IPC handlers for local POS offline analytics and reports.
 */

const { ipcMain } = require('electron')
const reportService = require('../../reports/reportService.cjs')

function registerReportsIpc() {
  ipcMain.handle('reports:dailySummary', async (_event, restaurantId, startDate, endDate) => {
    try {
      return { success: true, data: reportService.getDailySalesSummary(restaurantId, startDate, endDate) }
    } catch (err) {
      console.error('[reports:dailySummary error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:itemsBreakdown', async (_event, restaurantId, startDate, endDate) => {
    try {
      return { success: true, data: reportService.getCategoryAndItemBreakdown(restaurantId, startDate, endDate) }
    } catch (err) {
      console.error('[reports:itemsBreakdown error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:hourly', async (_event, restaurantId, dateString) => {
    try {
      return { success: true, data: reportService.getHourlySales(restaurantId, dateString) }
    } catch (err) {
      console.error('[reports:hourly error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:payments', async (_event, restaurantId, startDate, endDate) => {
    try {
      return { success: true, data: reportService.getPaymentsSummary(restaurantId, startDate, endDate) }
    } catch (err) {
      console.error('[reports:payments error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:taxes', async (_event, restaurantId, startDate, endDate) => {
    try {
      return { success: true, data: reportService.getTaxReport(restaurantId, startDate, endDate) }
    } catch (err) {
      console.error('[reports:taxes error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:discounts', async (_event, restaurantId, startDate, endDate) => {
    try {
      return { success: true, data: reportService.getDiscountReport(restaurantId, startDate, endDate) }
    } catch (err) {
      console.error('[reports:discounts error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:staff', async (_event, restaurantId, startDate, endDate) => {
    try {
      return { success: true, data: reportService.getStaffPerformance(restaurantId, startDate, endDate) }
    } catch (err) {
      console.error('[reports:staff error]', err)
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerReportsIpc }
