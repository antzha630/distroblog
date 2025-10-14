require('dotenv').config();

module.exports = {
  distro: {
    apiKey: process.env.DISTRO_API_KEY || 'fB|#7qo1HyyQ#J$;+N_:BT|m*_x$}Z,&',
    apiEndpoint: process.env.DISTRO_API_ENDPOINT || 'https://pulse-chain-dc452eb2642a.herokuapp.com/api/external/news'
  }
};



