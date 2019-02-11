//web3 creates a bridge between the blockchain and the outside (Javascript API)
const Web3 = require('web3')
//get the compiled solidity contract
const compiledMpc = require('./build/Mpc.json')
const address = require('./address')

//creates an instance of web3 using websocket ->
//it connects to the local blockchain (created with ganache-cli)
//websockets are needed for subscribing to events
let web3
web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:7545'))

//get the address and generate a new contract -> constructor
module.exports = new web3.eth.Contract(
  JSON.parse(compiledMpc.interface),
  address
)
