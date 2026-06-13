const originalExport = require('./next.config.original.js');
const resolved = originalExport.default || originalExport;

let config;
if (typeof resolved === 'function') {
  const origFn = resolved;
  config = (...args) => {
    const result = origFn(...args);
    if (result && typeof result.then === 'function') {
      return result.then((c) => {
        c.images = { ...c.images, loader: 'custom', loaderFile: './.edgeone/image-loader.mjs' };
        return c;
      });
    }
    result.images = { ...result.images, loader: 'custom', loaderFile: './.edgeone/image-loader.mjs' };
    return result;
  };
} else {
  config = { ...resolved };
  config.images = { ...config.images, loader: 'custom', loaderFile: './.edgeone/image-loader.mjs' };
}

module.exports = config;
