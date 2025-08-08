const path = require('path');

module.exports = function override(config, env) {
  // ✅ Prevent locked file issues (cross-platform compatible)
  if (config.watchOptions) {
    config.watchOptions.ignored = [
      '**/node_modules',
      '**/build',
      '**/public',
      '**/.git',
    ];
  }

  // ✅ Add custom aliases for cleaner imports
  config.resolve = {
    ...config.resolve,
    alias: {
      '@components': path.resolve(__dirname, 'src/components'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  };

  // ✅ Adjust Webpack Dev Server (only in development mode)
  if (env === 'development') {
    config.devServer = {
      ...config.devServer,
      port: 3001,
      proxy: {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
        },
      },
    };
  }

  return config;
};
