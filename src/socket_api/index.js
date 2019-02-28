/**
 * Web socket server to receive client connections and manage interactions with a runnng SPDZ process.
 * Note socket id is used to track the client connection. No additional state here, see spdzEngine.
 */
'use strict'

const logger = require('../support/logging')
const fs = require('fs')
const mongoose = require('mongoose')
const ipc = require('node-ipc')
const contractInstance = require('../ethereum/mpc')
const spdzDataConversion = require('../spdz_interface/spdzDataConversion')
const { exec } = require('child_process')
const web3 = require('web3')
let computationID,
  computationType,
  playerAddress,
  millionaireModel,
  newComputationEvent,
  endedComputationEvent

//connect to database
const connectToMongo = mongoUri => {
  mongoose.connect(mongoUri)

  const db = mongoose.connection
  db.on('error', function() {
    logger.info(error)
  })
  db.once('open', function() {
    logger.info('connected')
  })

  //write to db
  //SCHEMA
  const millionaireSchema = new mongoose.Schema({
    _id: String,
    a: String
  })

  //MODEL -> constructor created from the schema
  return mongoose.model('Millionaire', millionaireSchema, 'millionaires')
}

//handle and forward messages from SPDZ to client
const handleNewSpdzMessage = async (spdzEngine, clientSocket) => {
  if (clientSocket.connected) {
    try {
      //data here is in SPDZ binary form
      const spdzData = spdzEngine.getServerTransmission(clientSocket.id)

      if (spdzData !== null) {
        clientSocket.emit('spdz_message', spdzData)

        try {
          const convertedData = spdzDataConversion.binaryToIntArray(
            new Array(spdzData)
          )
          //the input after convertedData[i]==999 is the result
          //999 is the type
          //write into the blockchain the result
          for (var i = 0; i < convertedData.length; i++) {
            if (parseInt(convertedData[i]) === 999) {
              try {
                logger.warn('debug.txt', '\ncompu: ' + playerAddress)
                await contractInstance.methods
                  .setComputationResult(
                    parseInt(computationID),
                    convertedData[i + 1].toString()
                  )
                  .send({ from: playerAddress, gas: 1000000 })
              } catch (err) {
                logger.warn('debug.txt', playerAddress + 'err2: ' + err + '\n')
              }
            }
          }
        } catch (err) {
          logger.warn('debug.txt', '\nerr: ' + err)
        }
      } else {
        logger.warn(
          `Should not be getting notification of new spdz message for client ${
            clientSocket.id
          } and then not find one.`
        )
      }
    } catch (err) {
      logger.warn(
        `Notified of new spdz message, got error trying to consume it - ${
          err.message
        }.`
      )
    }
  } else {
    logger.debug(
      'Getting notification of new SPDZ message but client web socket is disconnected.'
    )
  }
}

//handle closed connections
const handleSpdzSocketClosed = clientSocket => {
  if (clientSocket.connected) {
    clientSocket.emit('spdz_socketDisconnected', {
      status: 0
    })
  } else {
    logger.debug(
      'Getting notification of SPDZ socket closed but client web socket is disconnected.'
    )
  }
}

//Setup SPDZ socket connection tracking connection with clientSocket id.
const setupSpdzConnection = (spdzEngine, clientSocket, clientPublicKey) => {
  return new Promise(function(resolve, reject) {
    if (spdzEngine.checkConnection(clientSocket.id)) {
      reject(
        new Error(
          `Unable to setup SPDZ connection, this id ${
            clientSocket.id
          } is already connected.`
        )
      )
    } else {
      spdzEngine
        .setupConnection(
          clientSocket.id,
          clientPublicKey,
          () => {
            handleNewSpdzMessage(spdzEngine, clientSocket)
          },
          () => {
            handleSpdzSocketClosed(clientSocket)
          }
        )
        .then(() => {
          resolve()
        })
        .catch(err => {
          reject(err)
        })
    }
  })
}

//Setup web socket server to receive client socket connections.
const setupSpdzInteraction = (io, namespace, spdzEngine, playerId) => {
  const ns = io.of(namespace)

  switch (playerId) {
    case '0':
      playerAddress = '0x5bf328D2F7d5830C2232B7520aa7fCAFFfb2b8CF'
      break
    case '1':
      playerAddress = '0xc3001e08fd1950693f12Cb9582e002D630e468Ae'
      break
  }

  const mongoUri = 'mongodb://andrea:andr3a@ds151544.mlab.com:51544/mpc'
  millionaireModel = connectToMongo(mongoUri)

  //blockchain events listener
  newComputationEvent = contractInstance.events.NewComputationRequest(
    { fromBlock: 'latest' },
    async (error, event) => {
      if (error) fs.appendFile('debug.txt', JSON.stringify(error))
      else {
        //accept the request on the blockchain
        try {
          computationID = event.returnValues.index
          const res = await contractInstance.methods
            .acceptComputationRequest(event.returnValues.index)
            .send({
              gas: 1000000,
              value: web3.utils.toWei('1'),
              from: playerAddress
            })
        } catch (err) {
          fs.appendFile('debug.txt', JSON.stringify(err))
        }
      }
    }
  )

  //end of mpc event listener
  endedComputationEvent = contractInstance.events.computationEnded(
    { fromBlock: 'latest' },
    async (error, event) => {
      if (error) fs.appendFile('debug.txt', JSON.stringify(error))
      else {
        //check if i have bonus and withdraw
        try {
          let bonus = await contractInstance.methods
            .actorBonus(playerAddress)
            .call()

          if (bonus > 0) {
            try {
              await contractInstance.methods
                .withdrawBonus()
                .send({ from: playerAddress })
              fs.appendFile('debug.txt', '\nwithdrawn ' + bonus)
            } catch (err) {
              fs.appendFile('debug.txt', JSON.stringify(err))
            }
          }
        } catch (err) {
          fs.appendFile('debug.txt', JSON.stringify(err))
        }
      }
    }
  )

  ns.on('connection', socket => {
    logger.debug(`Socket ${socket.id} connected.`)

    const runComputation = () => {
      millionaireModel.find({}, (err, millionaires) => {
        for (var i = 0; i < millionaires.length; i++) {
          //dataArray[i] = millionaires[i].a
          var dataArray = new Array(millionaires[i].a)

          //send to SPDZ engine this input
          if (spdzEngine.sendBigIntegers(socket.id, dataArray)) {
            socket.emit('sendData_result', { status: 0 })
            fs.appendFile('debug.txt', '\ndata: ' + dataArray)
          } else {
            socket.emit('sendData_result', {
              status: 1,
              err: 'Unable to send data (modp) to SPDZ engine.'
            })
          }
        }
      })
    }

    socket.on('isSpdzConnected', () => {
      const connected = spdzEngine.checkConnection(socket.id)
      socket.emit('isSpdzConnected_result', { status: connected ? 0 : 1 })
    })

    socket.on('connectToSpdz', clientPublicKey => {
      const reformatClientPublicKey =
        clientPublicKey !== undefined && clientPublicKey.length === 0
          ? undefined
          : clientPublicKey
      setupSpdzConnection(spdzEngine, socket, reformatClientPublicKey)
        .then(() => socket.emit('connectToSpdz_result', { status: 0 }))
        .catch(err => {
          socket.emit('connectToSpdz_result', { status: 1, err: err.message })
        })
    })
    //ATTIVATO CON sendClearInputsPromise o sendSecretInputsPromise nel client
    //con sendSecretInputsPromise prima di inviare gli input viene attivato il protocollo di sharing
    //dello SPDZ - gli input sono inviati con dataType modp se già shared
    socket.on('sendData', async (dataType, dataArray) => {
      //this when they receive the ID in clear from client
      if (dataType === 'int32') {
        if (dataArray[0] === 999) {
          //this is the computation ID passed from client
          computationID = dataArray[1]
          computationType = dataArray[2]

          fs.appendFile('debug.txt', 'comp: ' + dataArray[2])
        } else {
          try {
            await contractInstance.methods
              .confirmDataProducerRequest(dataArray[0])
              .send({ from: playerAddress, gas: 200000 })
            socket.emit('sendData_result', { status: 0 })
          } catch (err) {
            fs.appendFile('debug.txt', 'err ' + err + '\n')
            socket.emit('sendData_result', {
              status: 1,
              err: 'Error confirming request to blockchain'
            })
          }
        }
      } else if (dataType === 'modp') {
        //save to database the secret data

        //DOCUMENT -> instance of a model
        //dataArray['id', 'worth', 'isLast ']
        const millionaire = new millionaireModel({
          _id: dataArray[0],
          a: dataArray[0]
        })

        millionaire.save(err => {
          if (err) {
            fs.appendFile('debug.txt', 'err db ' + playerId + '\n')
          }

          if (spdzEngine.sendBigIntegers(socket.id, new Array(dataArray[0]))) {
            socket.emit('sendData_result', { status: 0 })
          } else {
            fs.appendFile('debug.txt', 'err big int' + playerId + '\n')
            socket.emit('sendData_result', {
              status: 1,
              err: 'Unable to send data (modp) to SPDZ engine.'
            })
          }
        })
      }
    })

    socket.on('runComputation', () => {
      runComputation()
    })

    socket.on('getHighestValue', () => {
      runComputation()
    })

    socket.on('getLowestValue', () => {
      runComputation()
    })

    socket.on('getMeanValue', () => {
      runComputation()
    })

    /**
     * @description Disconnect the client represented by this web socket from the SPDZ TCP connection.
     * @alias disconnectFromSpdz
     * @return {String} event name disconnectFromSpdz_result
     * @return {String} JSON response with {status : 0 (success)}
     * @example Client code to disconnect connection:
     *
     * socket.emit('disconnectFromSpdz')
     * @access public
     */

    socket.on('disconnectFromSpdz', () => {
      spdzEngine.closeConnection(socket.id)
      socket.emit('disconnectFromSpdz_result', { status: 0 })
    })

    socket.on('disconnect', () => {
      logger.debug(`Socket ${socket.id} disconnected.`)
    })
  })
}

module.exports = setupSpdzInteraction
