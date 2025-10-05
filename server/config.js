require('dotenv').config();

module.exports = {
  distro: {
    apiKey: process.env.DISTRO_API_KEY || 'YjBBLiyW7bMAwyOoXpmTOQSjWbbgmec0qz8n6xOwJD3Eh9hCTwGVPk6te1ivVUtU',
    apiEndpoint: process.env.DISTRO_API_ENDPOINT || 'https://pulse-chain-dc452eb2642a.herokuapp.com/api/external/news'
  }
};



