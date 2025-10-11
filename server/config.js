require('dotenv').config();

module.exports = {
  distro: {
    apiKey: process.env.DISTRO_API_KEY || '32qCf5H}vfxl]|9(;$O*u33#JZiUl0ZY.',
    apiEndpoint: process.env.DISTRO_API_ENDPOINT || 'https://pulse-chain-dc452eb2642a.herokuapp.com/api/external/news'
  }
};



