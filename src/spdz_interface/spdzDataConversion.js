// Manage data conversions between spdz proxy representation and SPDZ engine data formats sent over socket connection.
// These functions are designed to be stateless.
'use strict'

const assert = require('assert')

/**
 * SPDZ server transmissions are expected to hold the payload length in first 4 bytes.
 */
const calculatePayloadLength = buf => {
  if (buf.length < 4) {
    throw new Error(
      `A new server transmission must include a 4 byte length header, actual buffer length ${
        buf.length
      }. Ignoring data.`
    )
  }

  return buf.readUInt32LE(0)
}

/**
 * Create a 4 byte buffer holding the payload byte size in little endian format.
 */
const generatePayloadHeader = payloadByteSize => {
  let buf = Buffer.alloc(4, 0)
  buf.writeInt32LE(payloadByteSize, 0)

  return buf
}

const allSame = list => {
  if (list.length === 0) {
    return true
  } else {
    return !!list.reduce(function(a, b) {
      if (a.length && b.length && a.length === b.length) {
        for (var i = 0; i < a.length; i++) {
          if (a[i] instanceof _Gfp.Gfp) {
            if (!a[i].equals(b[i])) {
              return NaN
            }
          } else {
            if (a[i] !== b[i]) {
              return NaN
            }
          }
        }
      } else {
        return NaN
      }
      return a
    })
  }
}

/**
 * Binary data should be multiple of intSize bytes.
 */
const checkBuffer = (intSize, byteBufferList) => {
  var wrongLengthMsgs = byteBufferList.map(function(byteBuffer, index) {
    return byteBuffer.length % intSize === 0
      ? ''
      : 'Spdz proxy ' +
          index +
          ' provided ' +
          byteBuffer.length +
          ' bytes, expected multiple of ' +
          intSize +
          '.'
  })

  var wrongTypeMsgs = byteBufferList.map(function(byteBuffer) {
    return byteBuffer instanceof Uint8Array
      ? ''
      : 'Expect array of Uint8Array type, got a ' +
          (typeof byteBuffer === 'undefined'
            ? 'undefined'
            : _typeof(byteBuffer)) +
          '.'
  })

  return wrongLengthMsgs
    .concat(wrongTypeMsgs)
    .filter(function(message) {
      return message.length > 0
    })
    .join('\n')
}

const binaryToArray = (
  byteBufferList,
  typeByteLength,
  extractBinaryIntoArray
) => {
  if (byteBufferList.length === 0) {
    throw new Error('No data to extract.')
  }

  var chkBufLengthMessage = checkBuffer(typeByteLength, byteBufferList)
  if (chkBufLengthMessage.length > 0) {
    throw new Error(chkBufLengthMessage)
  }

  //First index indicates SPDZ proxy, second indicates result number
  var arrayMatrix = byteBufferList.map(extractBinaryIntoArray)

  if (!allSame(arrayMatrix)) {
    throw new Error('Not all parties have sent the same result.')
  }

  return arrayMatrix[0]
}

// Public
module.exports = {
  /**
   * Package a list of N integers received from the client in base 64 encoded big endian format
   * into a sequence of bytes (8 bit unsigned integer):
   *   4 bytes of payload byte length representing an unsigned 32 bit integer
   *  16 bytes representing a 128 bit big integer * N
   * bytes are ordered little endian.
   * @param {Array<string>} base64InputList
   * @returns {Buffer} Containing payload size header followed by binary integers.
   */
  base64ToSpdz: base64InputList => {
    const payloadSize = base64InputList.length * 16
    const header = generatePayloadHeader(payloadSize)

    const buf = Buffer.alloc(payloadSize + 4, 0)
    header.copy(buf)

    base64InputList.forEach((base64Str, index) => {
      let bigIntBuf = Buffer.from(base64Str, 'base64').reverse()
      bigIntBuf.copy(buf, 4 + index * 16)
    })

    return buf
  },

  /**
   * Convert a list of binary Buffers in little endian format into a list of base 64 encoded big endian format
   * @param {Array<Buffer>} binaryList
   * @returns {Array<String>}
   */
  binaryToBase64: binaryList => {
    return binaryList.map(buf => {
      buf.reverse()
      return buf.toString('base64')
    })
  },

  /**
   * Extract from a socketChunk the payload. Needed because transmissions over socket from server may be split or amalgamated.
   * @param {Buffer} socketChunk The data provided to the socket from the SPDZ engine.
   * @param {Number} expectedBytes If zero we are expecting a new server transmission with payload length header,
   *   if not then continuing to read a chunked previous server transmission.
   * @param {Buffer} remainingChunk Any bytes left over from last socket chunk.
   * @returns {Object} containing payload, expectedBytes, remainingChunk.
   */
  extractPayloadFromBuffer: (socketChunk, expectedBytes, remainingChunk) => {
    let payload = Buffer.alloc(0)
    let buf = socketChunk
    let curPosn = 0
    if (remainingChunk.length > 0) {
      buf = Buffer.concat([remainingChunk, socketChunk])
    }

    if (expectedBytes === 0) {
      // This a new server transmission so expect header
      expectedBytes = calculatePayloadLength(buf)
      curPosn = 4
    }

    payload = Buffer.from(buf.slice(curPosn, curPosn + expectedBytes))

    remainingChunk = Buffer.from(buf.slice(curPosn + expectedBytes))

    if (payload.length === expectedBytes) {
      expectedBytes = 0
    }

    return {
      payload: payload,
      expectedBytes: expectedBytes,
      remainingChunk: remainingChunk
    }
  },

  payloadLengthFromHeader: buf => {
    return calculatePayloadLength(buf)
  },

  /**
   * Package an array of 32 bit integers into a buffer in little endian byte order for a SPDZ regint type.
   * @param {Array<Number>} int32List array of 32 bit integers
   * @returns {Buffer} Containing integers
   */
  int32ToSpdz: int32List => {
    const payloadSize = int32List.length * 4
    const header = generatePayloadHeader(payloadSize)

    const buf = Buffer.alloc(payloadSize + 4, 0)
    header.copy(buf)

    int32List.forEach((intValue, index) => {
      buf.writeInt32LE(intValue, 4 + index * 4)
    })

    return buf
  },

  /**
   * Package hex representing 256 bit public key into binary buffer representing integer array.
   * Add payload header.
   * As mapping into array of 8 SPDZ integers, need to reverse each 4 bytes into little endian.
   * @param {String} 64 byte string containing hex
   * @returns {Buffer} 4 + 32 byte buffer containing header and public key
   */
  hexPublicKeyToBuffer: value => {
    const hexKey = value || []
    assert(
      hexKey.length === 64,
      `Expect hex string to be length 64 representing 256 bit public key, given length ${
        hexKey.length
      }.`
    )

    const payloadBuf = Buffer.alloc(32, 0)

    for (let i = 0; i < 8; i++) {
      const integerValue = hexKey.slice(i * 8, (i + 1) * 8)
      const integerBuf = Buffer.from(integerValue, 'hex').reverse()
      integerBuf.copy(payloadBuf, i * 4)
    }

    const header = generatePayloadHeader(32)

    const combinedBuf = Buffer.alloc(36, 0)
    header.copy(combinedBuf)
    payloadBuf.copy(combinedBuf, 4)

    return combinedBuf
  },

  binaryToIntArray: byteBufferList => {
    return binaryToArray(byteBufferList, 4, function(byteBuffer) {
      // Read through buffer, reversing then extracting each 4 bytes (little endian integer -> big endian)
      var intArray = new Array(byteBuffer.length / 4)
      var dv = new DataView(byteBuffer.buffer)

      for (var i = 0; i < dv.byteLength; i += 4) {
        intArray[i / 4] = dv.getUint32(i, true)
      }
      return intArray
    })
  },

  /**
   * Parse a message from SPDZ to extract out the header.
   *
   * @param {Uint8Array} messageBytes
   * @param {String} encryptionKey session key agreed between client and SPDZ server.
   * If undefined then assume SPDZ message not encrypted.
   * @param {String} url SPDZ proxy url - helps with logging
   *
   * @returns {messageType} to indicate the layout / purpose of the message
   * @returns {remainingBytes} the remaining bytes
   */
  parseSpdzMessage: (messageBytes, encryptionKey, url) => {
    try {
      ;(0, _assert2.default)(
        messageBytes instanceof Uint8Array,
        'Message from SPDZ should be a Uint8Array type, got a ' +
          (typeof messageBytes === 'undefined'
            ? 'undefined'
            : _typeof(messageBytes)) +
          '.'
      )
      var clearBytes =
        encryptionKey !== undefined
          ? (0, _crypto.decrypt)(encryptionKey, messageBytes)
          : new Uint8Array(messageBytes)
      ;(0, _assert2.default)(
        clearBytes.length >= 8,
        'Message from SPDZ must be at least 8 bytes, given ' +
          clearBytes.length +
          '.'
      )

      var messageType = (0, _binaryToArray.binaryToIntArray)([
        clearBytes.slice(0, 4)
      ])[0]
      var remainingBytes = clearBytes.slice(4)

      if (!messageTypeExists(messageType)) {
        throw new Error('Unknown message type ' + messageType + '.')
      }

      return { messageType: messageType, data: remainingBytes }
    } catch (err) {
      return err
    }
  }
}
