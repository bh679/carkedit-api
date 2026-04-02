module.exports = {
  apps: [{
    name: 'carkedit-api',
    script: 'dist/index.js',
    cwd: '/home/bitnami/server/carkedit-api',
    env: {
      PORT: 4500,
      NODE_ENV: 'production'
    }
  }]
};
