// Test-only preload: isolate the built CLI's macOS Activity path without
// changing HOME or any production path-resolution behavior.
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const actualHome = os.homedir;
os.homedir = () => process.env.XDG_CONFIG_HOME || actualHome();
syncBuiltinESMExports();
