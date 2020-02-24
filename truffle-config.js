module.exports = {
  // See <http://truffleframework.com/docs/advanced/configuration>
  // to customize your Truffle configuration!
  compilers: {
    solc: {
      settings: {
        // See the solidity docs for advice about optimization and evmVersion
        optimizer: {
          enabled: true,
          runs: 200
        }
      },
      version: '0.5.13' // Fetch exact version from solc-bin (default: truffle's version)
    }
  },
  networks: {
    test: {
      gas: 8000000,
      host: 'localhost',
      network_id: '*',
      port: 8545
    }
  },
  plugins: ['solidity-coverage']
}
