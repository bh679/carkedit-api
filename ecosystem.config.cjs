module.exports = {
  apps: [{
    name: 'carkedit-api',
    script: 'dist/index.js',
    cwd: '/home/bitnami/server/carkedit-api',
    env: {
      PORT: 4500,
      NODE_ENV: 'production'
    },
    env_development: {
      PORT: 4500,
      NODE_ENV: 'development'
    },
    env_staging: {
      PORT: 4500,
      NODE_ENV: 'production'
    },
    env_production: {
      PORT: 4500,
      NODE_ENV: 'production'
    }
  }]
};
