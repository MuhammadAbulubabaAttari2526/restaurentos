/**
 * printerManager.cjs
 *
 * Manages sending ESC/POS buffers to thermal printers on Windows.
 *
 * Supports two connection types:
 *   - 'network' : Direct TCP/IP socket (port 9100) - most reliable
 *   - 'driver'  : Windows printer spooler via raw PRINT command (net use / copy)
 *
 * Usage:
 *   const { printBuffer } = require('./printerManager.cjs')
 *   await printBuffer(buffer, printerConfig)
 */

const net  = require('net')
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const { execFile } = require('child_process')

/** Timeout for TCP connections (ms) */
const TCP_TIMEOUT_MS = 6000

/** ─── TCP/IP Network Printer ────────────────────────────────────────────── */
function printViaNetwork(buffer, { ipAddress, port = 9100 }) {
  return new Promise((resolve, reject) => {
    if (!ipAddress) {
      return reject(new Error('Printer IP address is not configured.'))
    }

    const socket = new net.Socket()
    let done = false

    const finish = (err) => {
      if (done) return
      done = true
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }

    socket.setTimeout(TCP_TIMEOUT_MS)

    socket.on('connect', () => {
      socket.write(buffer, (err) => {
        if (err) return finish(err)
        // Give the printer time to read the buffer before closing
        setTimeout(() => finish(), 300)
      })
    })

    socket.on('timeout', () => {
      finish(new Error(`Printer connection timed out (${ipAddress}:${port})`))
    })

    socket.on('error', (err) => {
      finish(new Error(`Printer network error: ${err.message}`))
    })

    socket.connect(port, ipAddress)
  })
}

/** ─── Windows Spooler / Driver Printer ─────────────────────────────────── */
function printViaDriver(buffer, { name }) {
  return new Promise((resolve, reject) => {
    if (!name) {
      return reject(new Error('Printer name is not configured.'))
    }

    // Write buffer to a temp file, then use COPY /B to send raw bytes to the printer
    const tmpFile = path.join(os.tmpdir(), `pos_print_${Date.now()}.bin`)

    fs.writeFile(tmpFile, buffer, (writeErr) => {
      if (writeErr) {
        return reject(new Error(`Failed to write temp print file: ${writeErr.message}`))
      }

      // Use PowerShell to send raw bytes to the Windows printer
      // COPY /B sends the file as binary to the named printer port
      const psScript = `
        $bytes = [System.IO.File]::ReadAllBytes('${tmpFile.replace(/\\/g, '\\\\')}')
        $printer = New-Object System.Drawing.Printing.PrintDocument
        $printerSettings = New-Object System.Drawing.Printing.PrinterSettings
        $printerSettings.PrinterName = '${name.replace(/'/g, "''")}'
        if (-not $printerSettings.IsValid) { throw "Printer '${"'${name}'"} not found" }
        $rawPrint = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $rawPrint, $bytes.Length)
        $hPrinter = [IntPtr]::Zero
        $di = New-Object System.IntPtr
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA")] public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter")] public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA")] public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv")] public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv")] public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
    [DllImport("winspool.Drv")] public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv")] public static extern bool EndDocPrinter(IntPtr hPrinter);
}
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public class DOCINFOA { public string pDocName; public string pOutputFile; public string pDataType; }
"@
        $hPrinter = [IntPtr]::Zero
        $opened = [RawPrint]::OpenPrinter('${name.replace(/'/g, "''")}', [ref]$hPrinter, [IntPtr]::Zero)
        if (-not $opened) { throw "Cannot open printer '${name}'" }
        $docInfo = New-Object DOCINFOA; $docInfo.pDocName = "ESC/POS Job"; $docInfo.pDataType = "RAW"
        $jobId = [RawPrint]::StartDocPrinter($hPrinter, 1, $docInfo)
        [RawPrint]::StartPagePrinter($hPrinter) | Out-Null
        $written = 0
        $pBytes = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pBytes, $bytes.Length)
        [RawPrint]::WritePrinter($hPrinter, $pBytes, $bytes.Length, [ref]$written) | Out-Null
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pBytes)
        [RawPrint]::EndPagePrinter($hPrinter) | Out-Null
        [RawPrint]::EndDocPrinter($hPrinter) | Out-Null
        [RawPrint]::ClosePrinter($hPrinter) | Out-Null
        Write-Host "Printed $written bytes"
      `

      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          // Clean up temp file
          fs.unlink(tmpFile, () => {})

          if (err) {
            return reject(new Error(`Print job failed: ${err.message || stderr || 'unknown error'}`))
          }
          resolve()
        }
      )
    })
  })
}

/**
 * Alternative simpler driver method using COPY /B command
 */
function printViaDriverSimple(buffer, { name }) {
  return new Promise((resolve, reject) => {
    if (!name) {
      return reject(new Error('Printer name is not configured.'))
    }

    const tmpFile = path.join(os.tmpdir(), `pos_print_${Date.now()}.bin`)

    fs.writeFile(tmpFile, buffer, (writeErr) => {
      if (writeErr) {
        return reject(new Error(`Failed to write temp print file: ${writeErr.message}`))
      }

      // COPY /B sends as raw binary — works for most USB/driver thermal printers on Windows
      execFile(
        'cmd.exe',
        ['/c', `COPY /B "${tmpFile}" "\\\\${os.hostname()}\\${name}"`],
        { timeout: 8000 },
        (err, _stdout, stderr) => {
          fs.unlink(tmpFile, () => {})
          if (err) {
            return reject(new Error(`Print failed via driver: ${err.message || stderr}`))
          }
          resolve()
        }
      )
    })
  })
}

/**
 * Send an ESC/POS buffer to a printer.
 *
 * @param {Buffer} buffer           - Compiled ESC/POS command buffer
 * @param {object} printerConfig    - Printer record from SQLite
 * @param {string} printerConfig.connection_type  - 'network' | 'driver'
 * @param {string} printerConfig.ip_address       - IP for network printers
 * @param {number} printerConfig.port             - Port (default 9100)
 * @param {string} printerConfig.name             - Windows driver printer name
 */
async function printBuffer(buffer, printerConfig = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Nothing to print — empty buffer.')
  }

  const connType = printerConfig.connection_type || printerConfig.connectionType || 'network'

  if (connType === 'network') {
    await printViaNetwork(buffer, {
      ipAddress: printerConfig.ip_address || printerConfig.ipAddress,
      port: printerConfig.port || 9100,
    })
  } else if (connType === 'driver') {
    try {
      await printViaDriver(buffer, { name: printerConfig.name })
    } catch (err) {
      // Fallback to simple COPY /B method
      await printViaDriverSimple(buffer, { name: printerConfig.name })
    }
  } else {
    throw new Error(`Unknown printer connection type: ${connType}`)
  }
}

/**
 * Get list of Windows printers via PowerShell.
 * Returns an array of printer name strings.
 */
function listWindowsPrinters() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        const names = stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
        resolve(names)
      }
    )
  })
}

module.exports = {
  printBuffer,
  listWindowsPrinters,
  printViaNetwork,
  printViaDriverSimple,
}
